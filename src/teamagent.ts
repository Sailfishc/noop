// TeamAgent: this machine as one person's machine on a team server (server/, /api/v1). Outbound only.
// Turned on when [server] token is a per-machine token ("tam_…", made in the app under 我的机器) and [cloud] url
// points at the team server. The machine reports what it can run, keeps one socket open (that is what "online"
// means to the team), hears every message in the channels its agents are in, and runs their tasks (teamwork.ts).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Cfg, HOME_DIR } from "./core";
import { createWorker, type AfterRun, type TeamTask, type WorkerOptions } from "./teamwork";
import { gitAfterRun, refreshPRs } from "./gitflow";
import { repoBook, type RepoBook } from "./repos";

export type TeamAgent = {
  id: string; handle: string; name: string; owner_id: string; machine_id: string | null; runtime: string; dispatch: string; autonomy: string;
  confirm?: boolean; model?: string; description?: string; repo?: string; memory?: string;
};
export type TeamMessage = {
  id: string; seq: number; channel_id: string; thread_id: string | null; author: { kind: "user" | "agent"; id: string };
  text: string; mentions: { kind: "user" | "agent"; id: string; handle: string }[]; created: number; attachments?: string[] | null;
};

export const isMachineToken = (t: unknown) => typeof t === "string" && t.startsWith("tam_");
export const teamEnabled = (cfg: Cfg) => !!cfg.cloud?.url && isMachineToken(cfg.server?.token);

/** What this machine tells the team: its OS, CPU, the runtimes it can start, how many sessions at once. */
export function machineReport(cfg: Cfg, which: (bin: string) => boolean = (b) => Bun.which(b) !== null) {
  return {
    os: process.platform === "darwin" ? "macOS" : process.platform,
    arch: process.arch,
    runtimes: ["codex", "claude", "pi"].filter(which),
    max_sessions: Number(cfg.host?.max_parallel) || 3,
  };
}

/** models: what the agent's owner can pick from (the runtime's own default is always there too: ""). */
export type RuntimeInfo = { name: string; version: string; installed: boolean; logged_in: boolean | null; models: string[] };
export type GitCred = { provider: "github" | "gitlab"; host: string; configured: boolean; user: string; via: string };
type Run = (cmd: string[]) => { code: number; out: string } | null;
const run: Run = (cmd) => {
  if (!Bun.which(cmd[0]!)) return null;
  try {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    return { code: p.exitCode ?? 1, out: (p.stdout.toString() + p.stderr.toString()).trim() };
  } catch { return null; }
};
const versionOf = (s: string) => s.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? "";

/** Claude Code's model aliases and the current full ids. */
export const CLAUDE_MODELS = ["opus", "sonnet", "haiku", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];

/** The model in Codex's own config (~/.codex/config.toml), so the default can be named. */
function codexModels(home = homedir()): string[] {
  try {
    const m = readFileSync(join(home, ".codex", "config.toml"), "utf8").match(/^\s*model\s*=\s*"([^"]+)"/m);
    return m ? [m[1]!] : [];
  } catch { return []; }
}

/** `pi --list-models` prints the models pi has credentials for, one per row: "provider  model  context …". */
export function piModels(out: string): string[] {
  const rows = out.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 2 && /^[\w.-]+$/.test(c[0]!));
  return [...new Set(rows.map((c) => `${c[0]}/${c[1]}`))].slice(0, 80);
}

/** Which runtimes are installed here, their versions, whether they are logged in (null: can't tell), and their models. */
export function detectRuntimes(r: Run = run, home = homedir()): RuntimeInfo[] {
  const out: RuntimeInfo[] = [];
  const codex = r(["codex", "--version"]);
  if (codex) {
    const st = r(["codex", "login", "status"]);
    out.push({ name: "codex", version: versionOf(codex.out), installed: codex.code === 0,
      logged_in: st ? st.code === 0 && !/not logged in/i.test(st.out) : null, models: codexModels(home) });
  }
  const claude = r(["claude", "--version"]);
  if (claude) {
    const st = r(["claude", "auth", "status"]);
    const logged = st ? st.code === 0 && !/not logged in|"loggedIn":\s*false/i.test(st.out) : null;
    out.push({ name: "claude", version: versionOf(claude.out), installed: claude.code === 0, logged_in: logged, models: CLAUDE_MODELS });
  }
  const pi = r(["pi", "--version"]);
  if (pi) {
    const ls = r(["pi", "--list-models"]);
    const models = ls && ls.code === 0 ? piModels(ls.out) : [];
    out.push({ name: "pi", version: versionOf(pi.out), installed: pi.code === 0, logged_in: ls ? models.length > 0 : null, models });
  }
  return out;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
/** Which Git platforms this machine can push to and as whom. Only the status goes to the server, never a token. */
export async function detectGit(cfg: Cfg, f: Fetch = fetch, r: Run = run): Promise<GitCred[]> {
  const who = async (url: string, headers: Record<string, string>, key: string) => {
    try {
      const res = await f(url, { headers, signal: AbortSignal.timeout(8_000) });
      return res.ok ? String(((await res.json()) as any)[key] ?? "") : "";
    } catch { return ""; }
  };
  const out: GitCred[] = [];
  let gh = cfg.git?.github?.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN, via = "token";
  if (!gh) { const p = r(["gh", "auth", "token"]); if (p?.code === 0 && p.out) { gh = p.out.split("\n")[0]; via = "gh"; } }
  out.push({ provider: "github", host: "github.com", configured: !!gh, via: gh ? via : "",
    user: gh ? await who("https://api.github.com/user", { authorization: `Bearer ${gh}`, accept: "application/vnd.github+json" }, "login") : "" });
  const list: any[] = Array.isArray(cfg.git?.gitlab) ? cfg.git.gitlab : cfg.git?.gitlab ? [cfg.git.gitlab] : [];
  for (const g of list.slice(0, 15)) {
    const host = String(g.host ?? "").toLowerCase();
    if (!host) continue;
    const api = g.api ? String(g.api).replace(/\/$/, "") : `https://${host}/api/v4`;
    out.push({ provider: "gitlab", host, configured: !!g.token, via: g.token ? "token" : "",
      user: g.token ? await who(`${api}/user`, { "private-token": String(g.token) }, "username") : "" });
  }
  return out;
}

/** The agents of this machine a message is for: @mentioned, or (a reply) in a thread one of them is in. */
export function addressedTo(m: TeamMessage, mine: TeamAgent[], threadAgents: Set<string> = new Set()): TeamAgent[] {
  if (m.author.kind === "agent" && mine.some((a) => a.id === m.author.id)) return []; // our own words
  return mine.filter((a) => m.mentions.some((x) => x.kind === "agent" && x.id === a.id) || threadAgents.has(a.id));
}

type Handler = (m: TeamMessage, agents: TeamAgent[]) => void | Promise<void>;
let handler: Handler = (m, agents) => console.log(`teamagent: ${agents.map((a) => `@${a.handle}`).join(" ")} ← ${m.text.slice(0, 80)}`);
/** Who acts on a message for this machine's agents (M2: the dispatcher). */
export const onAgentMessage = (h: Handler) => { handler = h; };

export function startTeamAgent(cfg: Cfg, opts: { stateFile?: string; log?: (s: string) => void; afterRun?: AfterRun; worker?: Partial<WorkerOptions>; repos?: RepoBook } = {}) {
  if (!teamEnabled(cfg)) return null;
  const base = String(cfg.cloud.url).replace(/\/$/, "");
  const auth = { Authorization: `Bearer ${cfg.server.token}` };
  const log = opts.log ?? ((s: string) => console.log(`teamagent: ${s}`));
  const stateFile = opts.stateFile ?? join(HOME_DIR, "teamagent.json");
  const state = (() => { try { return JSON.parse(readFileSync(stateFile, "utf8")) as { url?: string; after?: number }; } catch { return {}; } })();
  let after = state.url === base ? Number(state.after) || 0 : 0;
  let agents: TeamAgent[] = [];
  const save = () => { try { mkdirSync(dirname(stateFile), { recursive: true }); writeFileSync(stateFile, JSON.stringify({ url: base, after })); } catch {} };

  const api = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(base + path, { ...init, headers: { ...auth, "content-type": "application/json" }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!r) return null;
    if (r.status === 401) log("服务端不认这个机器 token（机器被移除了？）：在 App 的「我的机器」里重新添加");
    return r.ok ? (r.json() as Promise<any>) : null;
  };
  // the checkouts here, by remote; tasks name their repository by remote and the machine finds (or clones) it
  const roots = Array.isArray(cfg.teamagent?.roots) ? cfg.teamagent.roots.map(String) : undefined;
  const repos = opts.repos ?? repoBook({ roots, clones: join(HOME_DIR, "teamagent", "repos"), extra: () => agents.map((a) => a.repo ?? "").filter(Boolean) });
  // runtimes and Git credentials change rarely and cost a few process spawns and HTTP calls: look every 10 minutes
  let probe: { at: number; runtime_info: RuntimeInfo[]; git: GitCred[] } | null = null;
  const report = async () => {
    if (!probe || Date.now() - probe.at > 10 * 60_000) probe = { at: Date.now(), runtime_info: detectRuntimes(), git: await detectGit(cfg) };
    const body = { ...machineReport(cfg), runtime_info: probe.runtime_info, git: probe.git, repos: repos.list() };
    const r = await api("/api/v1/machine", { method: "PUT", body: JSON.stringify(body) });
    if (r?.agents) agents = r.agents;
    return r;
  };
  // a message can come twice (live on the socket and in a catch-up page at the same moment): once is enough
  const seen = new Set<string>();
  const deliver = async (m: TeamMessage) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    if (seen.size > 2000) seen.delete(seen.values().next().value!);
    if (m.seq > after) { after = m.seq; save(); }
    const to = addressedTo(m, agents);
    if (to.length) await handler(m, to);
  };
  const catchUp = async () => {
    for (let more = true; more;) {
      const r = await api(`/api/v1/updates?after=${after}`);
      if (!r) return;
      for (const m of r.messages as TeamMessage[]) await deliver(m);
      more = r.more;
    }
  };

  const worker = createWorker({
    api: (path, init) => api(path, init), server: base, maxParallel: machineReport(cfg).max_sessions, log, afterRun: opts.afterRun ?? gitAfterRun(cfg),
    resolveRepo: async (remote) => { const p = await repos.resolve(remote); void report(); return p; },
    files: {
      async upload(taskId, name, data) {
        const r = await fetch(`${base}/api/v1/tasks/${taskId}/outputs/file?name=${encodeURIComponent(name)}`, { method: "POST", headers: { ...auth, "content-type": "" }, body: data, signal: AbortSignal.timeout(120_000) }).catch(() => null);
        return !!r?.ok;
      },
      async preview(taskId, query, data) {
        const r = await fetch(`${base}/api/v1/tasks/${taskId}/outputs/preview?${query}`, { method: "POST", headers: auth, body: data, signal: AbortSignal.timeout(60_000) }).catch(() => null);
        return !!r?.ok;
      },
      async download(path) {
        const r = await fetch(base + path, { headers: auth, signal: AbortSignal.timeout(120_000) }).catch(() => null);
        return r?.ok ? new Uint8Array(await r.arrayBuffer()) : null;
      },
    },
    workRoot: join(HOME_DIR, "teamagent", "work"), logDir: join(HOME_DIR, "logs", "teamagent"), ...opts.worker,
  });
  const mine = (agentId: string) => agents.some((a) => a.id === agentId);

  let ws: WebSocket | null = null, stopped = false, backoff = 2_000;
  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(base.replace(/^http/i, "ws") + "/api/v1/stream", { headers: auth } as any);
    let ping: ReturnType<typeof setInterval> | undefined;
    ws.onopen = () => {
      backoff = 2_000;
      ping = setInterval(() => { try { ws?.send("ping"); } catch {} }, 60_000);
      void report().then(catchUp).then(worker.poll);
    };
    ws.onmessage = (e) => {
      let d: any; try { d = JSON.parse(String(e.data)); } catch { return; } // "pong"
      if (d?.type === "message") void deliver(d.message);
      else if (d?.type === "task") worker.onTask(d.task as TeamTask, mine);
      else if (d?.type === "agent" || d?.type === "agent_removed" || d?.type === "channel") void report(); // our agents or their channels changed
    };
    ws.onclose = () => {
      clearInterval(ping);
      if (stopped) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 60_000);
    };
    ws.onerror = () => {};
  };
  const tick = setInterval(() => void report().then(worker.poll).then(worker.checkWaits), 60_000);
  // the PRs this machine opened: their state and CI, every two minutes (a GitLab webhook also tells the server at once)
  const prTick = setInterval(async () => {
    const r = await api("/api/v1/machine/tasks?prs=1");
    if (r?.tasks) await refreshPRs(cfg, r.tasks, (id, pr) => api(`/api/v1/tasks/${id}/report`, { method: "POST", body: JSON.stringify({ pr }) }));
  }, 120_000);
  void report().then((r) => {
    if (r) log(`已接入 ${base}：${r.machine?.name ?? "?"}，Agent ${agents.map((a) => `@${a.handle}`).join(" ") || "（还没有）"}`);
  });
  connect();
  return {
    agents: () => agents,
    worker,
    stop: () => { stopped = true; clearInterval(tick); clearInterval(prTick); worker.stop(); ws?.close(); },
  };
}
