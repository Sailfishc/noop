// After an agent's run: push its task branch (agent/T-xxxx, never anything else) and open or update the pull request
// on the repository's platform, and later read the PR's state and CI. GitHub uses the REST API; Ant Code and other
// GitLab-based platforms use the GitLab v4 API (a merge request, called a PR in Remi). Credentials stay on this
// machine: [git] in the config, or GITHUB_TOKEN / `gh auth token` for GitHub.
//
//   [git.github]            token = "…"                       (optional when gh is logged in)
//   [[git.gitlab]]          host = "code.example.com"  token = "…"  api = "https://code.example.com/api/v4" (optional)
import type { Cfg } from "./core";
import type { AfterRun, Claim, PR, TaskResult, Workdir } from "./teamwork";

export type Remote = { host: string; path: string };

/** origin's address → host and owner/repo path (https, ssh and scp-like forms). */
export function parseRemote(url: string): Remote | null {
  const u = url.trim().replace(/\.git$/, "").replace(/\/$/, "");
  let m = u.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  if (m) return { host: m[1].toLowerCase(), path: m[2] };
  m = u.match(/^(?:[^@]+@)?([^:/]+):(.+)$/);
  if (m) return { host: m[1].toLowerCase(), path: m[2] };
  return null;
}

export interface Provider {
  name: "github" | "gitlab";
  /** The open PR of `branch`, or a new one. */
  ensurePR(o: { path: string; branch: string; base: string; title: string; body: string }): Promise<PR>;
  /** The PR as it is now (state and CI). */
  status(pr: PR): Promise<PR>;
}

type Fetch = typeof fetch;

async function call(f: Fetch, url: string, headers: Record<string, string>, method = "GET", body?: unknown) {
  const r = await f(url, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`${method} ${url.replace(/\?.*/, "")} → ${r.status} ${String(data?.message ?? data?.error ?? text).slice(0, 200)}`);
  return data;
}

/** success when every check passed, failure when one failed, pending while any runs, none when there are none. */
export function combineChecks(states: string[]): PR["checks"] {
  if (!states.length) return "none";
  if (states.some((s) => /^(failure|failed|error|cancelled|canceled|timed_out|action_required)$/.test(s))) return "failure";
  if (states.some((s) => !/^(success|neutral|skipped|passed|manual)$/.test(s))) return "pending";
  return "success";
}

export function github(token: string, f: Fetch = fetch, api = "https://api.github.com"): Provider {
  const h = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" };
  const view = (p: any, path: string, checks = "pending"): PR => ({
    provider: "github", url: p.html_url, number: p.number, title: p.title, repo: path, checks,
    state: p.merged_at ? "merged" : p.state === "closed" ? "closed" : "open",
  });
  return {
    name: "github",
    async ensurePR(o) {
      const owner = o.path.split("/")[0];
      const open = await call(f, `${api}/repos/${o.path}/pulls?state=open&head=${encodeURIComponent(`${owner}:${o.branch}`)}`, h);
      if (open?.length) return view(open[0], o.path);
      return view(await call(f, `${api}/repos/${o.path}/pulls`, h, "POST", { title: o.title, head: o.branch, base: o.base, body: o.body }), o.path);
    },
    async status(pr) {
      const path = pr.repo!;
      const p = await call(f, `${api}/repos/${path}/pulls/${pr.number}`, h);
      const sha = p.head?.sha;
      const runs = sha ? await call(f, `${api}/repos/${path}/commits/${sha}/check-runs?per_page=100`, h) : null;
      const combined = sha ? await call(f, `${api}/repos/${path}/commits/${sha}/status`, h) : null;
      const states = [
        ...(runs?.check_runs ?? []).map((c: any) => (c.status === "completed" ? String(c.conclusion) : String(c.status))),
        ...(combined?.statuses ?? []).map((s: any) => String(s.state)),
      ];
      return view(p, path, combineChecks(states));
    },
  };
}

export function gitlab(host: string, token: string, f: Fetch = fetch, api = `https://${host}/api/v4`): Provider {
  const h = { "private-token": token };
  const project = (path: string) => `${api}/projects/${encodeURIComponent(path)}`;
  const pipeline = (s: string | undefined) => (s ? combineChecks([s === "running" || s === "created" || s === "waiting_for_resource" || s === "preparing" ? "pending" : s]) : "none");
  const view = (m: any, path: string): PR => ({
    provider: "gitlab", url: m.web_url, number: m.iid, title: m.title, repo: path,
    state: m.state === "merged" ? "merged" : m.state === "closed" ? "closed" : "open",
    checks: pipeline(m.head_pipeline?.status ?? m.pipeline?.status),
  });
  return {
    name: "gitlab",
    async ensurePR(o) {
      const open = await call(f, `${project(o.path)}/merge_requests?state=opened&source_branch=${encodeURIComponent(o.branch)}`, h);
      if (open?.length) return view(open[0], o.path);
      return view(await call(f, `${project(o.path)}/merge_requests`, h, "POST", {
        source_branch: o.branch, target_branch: o.base, title: o.title, description: o.body, remove_source_branch: true,
      }), o.path);
    },
    async status(pr) {
      return view(await call(f, `${project(pr.repo!)}/merge_requests/${pr.number}`, h), pr.repo!);
    },
  };
}

async function git(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { ok: (await p.exited) === 0, out: out.trim(), err: err.trim() };
}

let ghToken: string | null | undefined;
function githubToken(cfg: Cfg): string | null {
  const t = cfg.git?.github?.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (t) return String(t);
  if (ghToken === undefined) {
    const p = Bun.which("gh") ? Bun.spawnSync(["gh", "auth", "token"]) : null;
    ghToken = p?.exitCode === 0 ? p.stdout.toString().trim() || null : null;
  }
  return ghToken;
}

/** The provider for a remote host, if this machine has credentials for it. */
export function providerFor(cfg: Cfg, host: string, f: Fetch = fetch): Provider | null {
  if (host === "github.com") {
    const t = githubToken(cfg);
    return t ? github(t, f) : null;
  }
  const list = Array.isArray(cfg.git?.gitlab) ? cfg.git.gitlab : cfg.git?.gitlab ? [cfg.git.gitlab] : [];
  const g = list.find((x: any) => String(x.host ?? "").toLowerCase() === host);
  return g?.token ? gitlab(host, String(g.token), f, g.api ? String(g.api).replace(/\/$/, "") : undefined) : null;
}

/** The PR's description: what the agent wrote, then who made it for whom (outside Remi nobody knows the agent). */
export function prBody(c: Claim, r: TaskResult): string {
  return `${(r.pr_body || r.summary || c.task.title).trim()}\n\n---\n由 Remi 的 @${c.agent.handle}（${c.agent.name}）替 ${c.creator.name} 完成 · 任务 ${c.task.id}`;
}

/** Push the task branch and open (or find) its PR. Only agent/… branches are ever pushed. */
export function gitAfterRun(cfg: Cfg, f: Fetch = fetch): AfterRun {
  return async (c, r, wd: Workdir) => {
    if (!wd.repo || !wd.branch) return null;
    if (!wd.branch.startsWith("agent/")) throw new Error(`拒绝推送 ${wd.branch}：只推 agent/ 开头的任务分支`);
    const dirty = (await git(wd.cwd, "status", "--porcelain")).out;
    const ahead = Number((await git(wd.cwd, "rev-list", "--count", `${wd.base}..HEAD`)).out) || 0;
    const notes: string[] = [];
    if (dirty) notes.push("工作区还有没提交的改动，没有包含在 PR 里");
    if (!ahead) return notes.length ? { note: notes.join("；") } : null;
    if (!(await git(wd.cwd, "remote", "get-url", "origin")).ok) {
      notes.push(`改动在本地分支 ${wd.branch} 上；仓库没有 origin，没有推送也没有开 PR`);
      return { note: notes.join("；") };
    }
    const push = await git(wd.cwd, "push", "--force-with-lease", "origin", `HEAD:refs/heads/${wd.branch}`);
    if (!push.ok) throw new Error(push.err.split("\n").slice(-2).join(" "));
    const remote = parseRemote((await git(wd.cwd, "remote", "get-url", "origin")).out);
    const p = remote && providerFor(cfg, remote.host, f);
    if (!remote || !p) {
      notes.push(remote
        ? `已推送分支 ${wd.branch}；这台机器没有 ${remote.host} 的 API 凭证，PR 需要手动开（在 config 的 [git] 里配置）`
        : `已推送分支 ${wd.branch}；origin 不是 GitHub 或 GitLab 的地址，PR 需要手动开`);
      return { note: notes.join("；") };
    }
    const base = (wd.base ?? "main").replace(/^origin\//, "");
    const pr = await p.ensurePR({ path: remote.path, branch: wd.branch, base, title: r.pr_title?.trim() || c.task.title, body: prBody(c, r) });
    return { pr, note: notes.join("；") || undefined };
  };
}

/** Refresh the open PRs of this machine's tasks; report the ones that changed. */
export async function refreshPRs(cfg: Cfg, tasks: { id: string; pr: PR | null }[], report: (id: string, pr: PR) => Promise<unknown>, f: Fetch = fetch) {
  for (const t of tasks) {
    if (!t.pr || t.pr.state !== "open") continue;
    const host = (() => { try { return new URL(t.pr!.url).host.toLowerCase(); } catch { return ""; } })();
    const p = providerFor(cfg, host, f);
    if (!p) continue;
    try {
      const now = await p.status(t.pr);
      if (now.state !== t.pr.state || now.checks !== t.pr.checks) await report(t.id, now);
    } catch {}
  }
}
