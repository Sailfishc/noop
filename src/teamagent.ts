// TeamAgent: this machine as one person's machine on a team server (server/, /api/v1). Outbound only.
// Turned on when [server] token is a per-machine token ("tam_…", made in the app under 我的机器) and [cloud] url
// points at the team server. The machine reports what it can run, keeps one socket open (that is what "online"
// means to the team), hears every message in the channels its agents are in, and runs their tasks (teamwork.ts).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Cfg, HOME_DIR } from "./core";
import { createWorker, type AfterRun, type TeamTask, type WorkerOptions } from "./teamwork";
import { gitAfterRun, refreshPRs } from "./gitflow";

export type TeamAgent = {
  id: string; handle: string; name: string; owner_id: string; machine_id: string | null; runtime: string; dispatch: string; autonomy: string;
  description?: string; repo?: string;
};
export type TeamMessage = {
  id: string; seq: number; channel_id: string; thread_id: string | null; author: { kind: "user" | "agent"; id: string };
  text: string; mentions: { kind: "user" | "agent"; id: string; handle: string }[]; created: number;
};

export const isMachineToken = (t: unknown) => typeof t === "string" && t.startsWith("tam_");
export const teamEnabled = (cfg: Cfg) => !!cfg.cloud?.url && isMachineToken(cfg.server?.token);

/** What this machine tells the team: its OS, CPU, the runtimes it can start, how many sessions at once. */
export function machineReport(cfg: Cfg, which: (bin: string) => boolean = (b) => Bun.which(b) !== null) {
  return {
    os: process.platform === "darwin" ? "macOS" : process.platform,
    arch: process.arch,
    runtimes: ["codex", "claude"].filter(which),
    max_sessions: Number(cfg.host?.max_parallel) || 3,
  };
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

export function startTeamAgent(cfg: Cfg, opts: { stateFile?: string; log?: (s: string) => void; afterRun?: AfterRun; worker?: Partial<WorkerOptions> } = {}) {
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
  const report = async () => {
    const r = await api("/api/v1/machine", { method: "PUT", body: JSON.stringify(machineReport(cfg)) });
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
    api: (path, init) => api(path, init), maxParallel: machineReport(cfg).max_sessions, log, afterRun: opts.afterRun ?? gitAfterRun(cfg),
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
  const tick = setInterval(() => void report().then(worker.poll), 60_000);
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
