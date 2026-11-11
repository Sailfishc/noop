import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { combineChecks, gitAfterRun, github, gitlab, parseRemote, prBody, providerFor, refreshPRs } from "../src/gitflow";
import { prepareWorkdir, type Claim } from "../src/teamwork";

const sh = (cwd: string, ...cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  return (p.stdout.toString() + p.stderr.toString()).trim();
};

/** A fetch that answers from a table of "METHOD url-prefix" → body, and records the calls. */
function fakeFetch(routes: Record<string, unknown>, calls: { method: string; url: string; body?: any; headers: any }[]) {
  return (async (url: string, init: any = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
    if (!key) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as unknown as typeof fetch;
}

test("remotes in every form", () => {
  expect(parseRemote("https://github.com/acme/pay.git")).toEqual({ host: "github.com", path: "acme/pay" });
  expect(parseRemote("git@github.com:acme/pay.git")).toEqual({ host: "github.com", path: "acme/pay" });
  expect(parseRemote("ssh://git@code.corp.com:2222/team/sub/orders.git")).toEqual({ host: "code.corp.com", path: "team/sub/orders" });
  expect(parseRemote("/tmp/x")).toBe(null);
});

test("checks: one failure fails, anything running is pending, none is none", () => {
  expect(combineChecks([])).toBe("none");
  expect(combineChecks(["success", "skipped"])).toBe("success");
  expect(combineChecks(["success", "in_progress"])).toBe("pending");
  expect(combineChecks(["success", "failure", "queued"])).toBe("failure");
});

test("GitHub: finds the open PR of the branch or opens one; status reads checks and merge", async () => {
  const calls: any[] = [];
  const f = fakeFetch({
    "GET https://api.github.com/repos/acme/pay/pulls?state=open": [],
    "POST https://api.github.com/repos/acme/pay/pulls": { html_url: "https://github.com/acme/pay/pull/7", number: 7, title: "t", state: "open" },
    "GET https://api.github.com/repos/acme/pay/pulls/7": { html_url: "https://github.com/acme/pay/pull/7", number: 7, title: "t", state: "closed", merged_at: "x", head: { sha: "abc" } },
    "GET https://api.github.com/repos/acme/pay/commits/abc/check-runs": { check_runs: [{ status: "completed", conclusion: "success" }] },
    "GET https://api.github.com/repos/acme/pay/commits/abc/status": { statuses: [] },
  }, calls);
  const p = github("tok", f);
  const pr = await p.ensurePR({ path: "acme/pay", branch: "agent/T-0001", base: "main", title: "t", body: "b" });
  expect(pr).toMatchObject({ provider: "github", number: 7, state: "open", repo: "acme/pay" });
  expect(calls[0].url).toContain("head=acme%3Aagent%2FT-0001");
  expect(calls[1].body).toEqual({ title: "t", head: "agent/T-0001", base: "main", body: "b" });
  expect(calls[1].headers.authorization).toBe("Bearer tok");
  expect(await p.status(pr)).toMatchObject({ state: "merged", checks: "success" });
});

test("Ant Code (GitLab v4): a merge request, called a PR; its pipeline is the checks", async () => {
  const calls: any[] = [];
  const f = fakeFetch({
    "GET https://code.corp/api/v4/projects/team%2Forders/merge_requests?state=opened": [],
    "POST https://code.corp/api/v4/projects/team%2Forders/merge_requests": { web_url: "https://code.corp/team/orders/-/merge_requests/3", iid: 3, title: "t", state: "opened" },
    "GET https://code.corp/api/v4/projects/team%2Forders/merge_requests/3": { web_url: "https://code.corp/team/orders/-/merge_requests/3", iid: 3, state: "opened", head_pipeline: { status: "running" } },
  }, calls);
  const p = gitlab("code.corp", "glt", f);
  const pr = await p.ensurePR({ path: "team/orders", branch: "agent/T-0002", base: "master", title: "t", body: "b" });
  expect(pr).toMatchObject({ provider: "gitlab", number: 3, state: "open", checks: "none" });
  expect(calls[1].body).toMatchObject({ source_branch: "agent/T-0002", target_branch: "master" });
  expect(calls[1].headers["private-token"]).toBe("glt");
  expect(await p.status(pr)).toMatchObject({ state: "open", checks: "pending" });
  expect(providerFor({ git: { gitlab: [{ host: "code.corp", token: "glt" }] } }, "code.corp", f)?.name).toBe("gitlab");
  expect(providerFor({ git: { gitlab: [{ host: "code.corp", token: "glt" }] } }, "other.corp", f)).toBe(null);
});

test("refreshPRs reports only the PRs whose state or checks changed", async () => {
  const f = fakeFetch({ "GET https://code.corp/api/v4/projects/team%2Forders/merge_requests/3": { web_url: "https://code.corp/x", iid: 3, state: "merged", head_pipeline: { status: "success" } } }, []);
  const reported: string[] = [];
  const cfg = { git: { gitlab: { host: "code.corp", token: "glt" } } };
  await refreshPRs(cfg, [
    { id: "T-1", pr: { provider: "gitlab", url: "https://code.corp/x", number: 3, state: "open", checks: "pending", repo: "team/orders" } },
    { id: "T-2", pr: null },
  ], async (id, pr) => { reported.push(`${id}:${pr.state}:${pr.checks}`); }, f);
  expect(reported).toEqual(["T-1:merged:success"]);
});

const claim = (repo: string): Claim => ({
  task: { id: "T-0001", channel_id: "c", thread_id: "m", agent_id: "a", created_by: "u", title: "加索引", body: "", state: "running", step: "", summary: "",
    decision: null, pr: null, branch: "agent/T-0001", session: "", claimed_by: "m", runs: 1 },
  agent: { id: "a", handle: "acha", name: "阿查", owner_id: "u2", machine_id: "m", runtime: "codex", dispatch: "confirm", autonomy: "assist", repo },
  channel: { id: "c", name: "支付", topic: "" }, recent: [], thread: [], new: [], names: {}, creator: { name: "张伟", handle: "zhangwei" }, resumed: false,
});

test("after a run: the task branch is pushed and its PR opened; nothing to push, nothing opened", async () => {
  const W = mkdtempSync(join(tmpdir(), "gitflow-"));
  try {
    const origin = join(W, "origin.git"), repo = join(W, "repo");
    sh(W, "git", "init", "-q", "--bare", "-b", "main", origin);
    sh(W, "git", "clone", "-q", origin, repo);
    writeFileSync(join(repo, "a.txt"), "a\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-qm", "init");
    sh(repo, "git", "push", "-q", "origin", "HEAD:main");
    sh(repo, "git", "remote", "set-head", "origin", "main");
    const c = claim(repo);
    const wd = await prepareWorkdir(c, join(W, "work"));
    const after = gitAfterRun({});
    expect(await after(c, { status: "review", summary: "看了，不用改" }, wd)).toBe(null);

    writeFileSync(join(wd.cwd, "b.txt"), "b\n");
    sh(wd.cwd, "git", "add", ".");
    sh(wd.cwd, "git", "commit", "-qm", "index");
    writeFileSync(join(wd.cwd, "c.txt"), "left over\n");
    const r = await after(c, { status: "review", summary: "加了索引" }, wd);
    expect(sh(origin, "git", "branch", "--list", "agent/*")).toContain("agent/T-0001");
    expect(r?.pr).toBeUndefined(); // a local origin: no platform to open a PR on
    expect(r?.note).toContain("没提交的改动");
    expect(r?.note).toContain("已推送分支 agent/T-0001；origin 不是 GitHub 或 GitLab 的地址");

    await expect(after(c, { status: "review", summary: "" }, { ...wd, branch: "main" })).rejects.toThrow("只推 agent/");
    expect(prBody(c, { status: "review", summary: "加了索引" })).toContain("@acha（阿查）替 张伟 完成 · 任务 T-0001");
    expect(prBody(c, { status: "review", summary: "" })).not.toContain("换过来");
    // its owner switched this task to another runtime (换引擎继续): the PR says which did it
    const switched = { ...c, agent: { ...c.agent, runtime: "claude" }, task: { ...c.task, runtime: "claude", engine: { from: "codex", to: "claude", reason: "quota", state: "switched" } } };
    expect(prBody(switched as any, { status: "review", summary: "加了索引" })).toContain("任务 T-0001 · 用 Claude Code 完成（这个任务从 Codex 换过来）");
  } finally {
    rmSync(W, { recursive: true, force: true });
  }
});

test("after a run in a repository with no origin: the work stays on the local task branch", async () => {
  const W = mkdtempSync(join(tmpdir(), "gitflow-"));
  try {
    const repo = join(W, "repo");
    sh(W, "git", "init", "-q", "-b", "main", repo);
    writeFileSync(join(repo, "a.txt"), "a\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-qm", "init");
    const c = claim(repo);
    const wd = await prepareWorkdir(c, join(W, "work"));
    writeFileSync(join(wd.cwd, "b.txt"), "b\n");
    sh(wd.cwd, "git", "add", ".");
    sh(wd.cwd, "git", "commit", "-qm", "b");
    const r = await gitAfterRun({})(c, { status: "review", summary: "加了 b" }, wd);
    expect(r?.note).toBe("改动在本地分支 agent/T-0001 上；仓库没有 origin，没有推送也没有开 PR");
    expect(sh(repo, "git", "branch", "--list", "agent/*")).toContain("agent/T-0001");
  } finally {
    rmSync(W, { recursive: true, force: true });
  }
});
