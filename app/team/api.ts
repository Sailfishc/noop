// TeamAgent's client side of the Go server's /api/v1: the types, plain helpers, and one store per signed-in person
// (people, agents, machines, channels, messages, threads), kept live by the server's socket and, without it, by
// polling /api/v1/updates.
import { signal, untracked } from "nsh";
import { L } from "../i18n";

export type Member = { kind: "user" | "agent"; id: string };
export type Mention = Member & { handle: string };
export type User = { id: string; email: string; handle: string; name: string; role: "admin" | "member"; disabled: boolean };
/** A runtime its machine found: installed or not, its version, and whether it is logged in (null: can't tell). */
export type RuntimeInfo = { name: string; version: string; installed: boolean; logged_in: boolean | null; models?: string[] | null };
/** Whether its machine can push to a Git platform, and as whom; the token itself never leaves the machine. */
export type GitCred = { provider: "github" | "gitlab"; host: string; configured: boolean; user: string; via: string };
export type Machine = {
  id: string; owner_id: string; name: string; os: string; arch: string; runtimes: string[]; max_sessions: number; online: boolean; last_seen: number | null;
  runtime_info?: RuntimeInfo[]; git?: GitCred[];
  /** The repositories it has checkouts of, by remote (host/owner/name). */
  repos?: RepoRef[] | null;
};
/** A repository, named by its remote the same way on every machine: host/owner/name. */
export type RepoRef = { remote: string; name: string };
export type Repo = RepoRef & { machines: string[] };
/** "github.com/acme/pay" → "acme/pay" (the host only when it is not GitHub). */
export const repoLabel = (remote: string) => (remote.startsWith("github.com/") ? remote.slice("github.com/".length) : remote);
export type GitPlatform = { kind: "gitlab" | "github"; name: string; host: string; api: string };
export type GitEvent = { at: number; kind: string; project: string; branch: string; number: number; state: string; task: string };
export type GitSettings = { platforms: GitPlatform[]; webhook: { path: string; secret_set: boolean }; events: GitEvent[] };
export type Device = { id: string; ua: string; created: number; last_seen: number; current: boolean };
/** Who may hand an agent work: only its owner, members of a channel it is in, or anyone in the team. */
export type Dispatch = "owner" | "channel" | "team";
export type Autonomy = "cautious" | "assist" | "auto";
export type Agent = { id: string; owner_id: string; machine_id: string | null; handle: string; name: string; description: string; runtime: string; dispatch: Dispatch;
  /** Work from people other than the owner waits for the owner's yes. */
  confirm: boolean; autonomy: Autonomy; model?: string; repo?: string; archived?: boolean;
  /** Its memory.md: what it keeps between tasks. */
  memory?: string };
export type TaskState = "pending" | "queued" | "running" | "waiting" | "needs_decision" | "review" | "blocked" | "failed" | "done" | "closed";
export type Decision = { question: string; options: string[] | null; recommendation?: string; answer?: string; answered_by?: string };
export type PR = { provider: "github" | "gitlab"; url: string; number: number; title?: string; state: "open" | "merged" | "closed"; checks: "pending" | "success" | "failure" | "none"; repo?: string };
/** On whose word the agent works and how far it may go, fixed when the task was made. */
export type Mandate = { by: string; rule: Dispatch; confirm: boolean; joined?: boolean; autonomy: Autonomy; branch: string; runtime: string; model?: string };
export type Task = {
  id: string; channel_id: string; thread_id: string; agent_id: string; created_by: string; title: string; body: string;
  /** The run's state (the machines go by it); people see statusOf(state): five statuses and a "needs you" mark. */
  state: TaskState;
  step: string; summary: string; decision: Decision | null; pr: PR | null; branch: string; claimed_by: string | null; confirmed_by: string | null;
  runs: number; created: number; updated: number; acceptance?: string; mandate?: Mandate | null;
  /** Where it runs: host/owner/name; "" = a general task (or the agent's own repo path). */
  repo?: string;
  /** What came out of it: its PR first, files from out/, results kept by outside services. */
  outputs?: Output[] | null;
  /** What it waits for while "waiting" (and why it woke, until its next run). */
  wait?: Wait | null;
  /** A task people track (on the board); false: a request the agent only answered, or has not claimed yet. Older
   * servers send none: every run was a task then. */
  tracked?: boolean;
  /** Whether the agent saw the outcome itself, or only handed the work over. */
  result?: "confirmed" | "unconfirmed" | "";
};
/** A task waiting for an outside result: the platform only wakes the agent (a callback, a check, a time). */
export type Wait = {
  how: "callback" | "poll" | "timer"; every?: number; expect?: number; deadline: number; since: number; next_at?: number;
  checked?: number; checks?: number; errors?: number; note?: string; what?: string;
  wake?: { reason: string; note?: string; at: number } | null;
};
/** How many times a task may hand work to an outside service before a person decides. */
export const EXTERNAL_TRIES = 3;
export type Output = {
  id: string; kind: "pr" | "file" | "external"; title: string;
  /** pending | ready | failed; a PR: open | merged | closed */
  status: string; url?: string; name?: string; mime?: string; size?: number; version?: number;
  service?: string; external_id?: string;
  /** progress or why it failed; a PR: its checks */
  note?: string; preview?: boolean; updated: number;
};
/** The one line that connects a computer as a machine: installs the daemon, trades the code for its token, runs it as a service. */
export const installCommand = (server: string, code: string) => {
  const url = server.replace(/\/+$/, "");
  return `curl -fsSL ${url}/api/v1/install.sh | bash -s -- ${url} ${code}`;
};
/** A server address only the server's own computer can reach. */
export const isLoopback = (server: string) => /^https?:\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(server);

export type Channel = { id: string; slug: string; name: string; topic: string; archived: boolean; created: number; members: Member[]; last_seq: number;
  /** The default repository of its tasks (host/owner/name), "" for none. */
  repo?: string };
export type Message = {
  id: string; seq: number; channel_id: string; thread_id: string | null; author: Member; text: string;
  mentions: Mention[] | null; attachments: string[] | null; client_id?: string | null; created: number; edited: number | null;
  reply_count: number; last_reply_at: number | null;
  /** Who put which emoji on it, oldest first (an agent's 👀: it took the message up). */
  reactions?: { emoji: string; author: Member }[];
};
/** A file on a message: what the server knows of it, and a link (15 minutes) to show or download it. */
export type Attachment = { path: string; name: string; mime: string; size: number; url?: string };
export type Session = { url: string; session: string };
export type Conn = "connecting" | "live" | "offline" | "unauthorized";
export type Reply = { ok: boolean; status: number; data: any };

export const TEAM_KEYS = { url: "team.url", session: "team.session", email: "team.email" } as const;

/** "hub.corp:8080/" → "http://hub.corp:8080": an intranet server is often plain http. */
export function normalizeServer(s: string): string {
  const t = s.trim().replace(/\/+$/, "");
  if (!t) return "";
  return /^https?:\/\//i.test(t) ? t : `http://${t}`;
}

/** An invite as pasted: the link the admin sent ("http://hub:8080/invite/CODE") or the code alone. */
export function parseInvite(text: string, server: string): { server: string; code: string } | null {
  const t = text.trim();
  const m = t.match(/^(.*?)\/invite\/([A-Za-z0-9_-]{8,})\/?$/);
  if (m) return { server: normalizeServer(m[1]) || normalizeServer(server), code: m[2] };
  if (/^[A-Za-z0-9_-]{8,}$/.test(t) && server.trim()) return { server: normalizeServer(server), code: t };
  return null;
}

/** A login link as pasted ("http://hub:8080/login/ABCD-EFGH"): its server; the code is sent as typed. */
export function loginServer(text: string): string {
  const m = text.trim().match(/^(.*?)\/login\/[A-Za-z0-9-]+\/?$/);
  return m ? normalizeServer(m[1]) : "";
}

export const wsUrl = (base: string, token: string) => `${base.replace(/^http/, "ws")}/api/v1/stream?token=${encodeURIComponent(token)}`;

/** One JSON call; never throws (status 0: unreachable). */
export async function call(base: string, method: string, path: string, token = "", body?: unknown): Promise<Reply> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let r: Response;
  try {
    r = await fetch(`${base}${path}`, method === "GET" ? { headers } : { method, headers, body: JSON.stringify(body ?? {}) });
  } catch {
    return { ok: false, status: 0, data: {} };
  }
  let data: any = {};
  try {
    data = (await r.json()) ?? {};
  } catch {
    /* no body */
  }
  return { ok: r.ok, status: r.status, data };
}

/** The server's words for a failed call, or a fallback. */
export const errorOf = (r: Reply, fallback: string) => (typeof r.data?.error === "string" && r.data.error ? r.data.error : fallback);

/** Messages by id, in server order (seq). */
export function mergeMessages(list: readonly Message[], incoming: readonly Message[]): Message[] {
  if (!incoming.length) return list as Message[];
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, { ...byId.get(m.id), ...m });
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

const upsert = <T extends { id: string }>(list: readonly T[], item: T): T[] =>
  list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];

/** The runtimes an agent can run on. */
export const RUNTIMES = [
  { name: "codex", label: "Codex", ready: true },
  { name: "claude", label: "Claude Code", ready: true },
  { name: "pi", label: "Pi", ready: true },
] as const;

/** The models its machine says a runtime offers (the runtime's own default, "", is always a choice too). */
export const modelsOn = (m: Machine | undefined, runtime: string): string[] => runtimeOn(m, runtime)?.models ?? [];
export const runtimeLabel = (name: string) => RUNTIMES.find((r) => r.name === name)?.label ?? name;

/** What its machine says about a runtime (an old daemon reports only names: installed, login unknown). */
export function runtimeOn(m: Machine | undefined, name: string): RuntimeInfo | undefined {
  if (!m) return undefined;
  return m.runtime_info?.find((r) => r.name === name) ?? (m.runtimes.includes(name) ? { name, version: "", installed: true, logged_in: null } : undefined);
}

/** Why an agent can't take work now ("" when it can): no machine, the machine offline, its runtime missing or logged out. */
export function blockedReason(a: Agent, m: Machine | undefined, en: boolean): string {
  const rt = runtimeLabel(a.runtime);
  if (!a.machine_id || !m) return en ? "no machine" : "没有机器";
  if (!m.online) return en ? `${m.name} is offline` : `${m.name} 离线`;
  const r = runtimeOn(m, a.runtime);
  if (!r || !r.installed) return en ? `${rt} isn’t installed on ${m.name}` : `${m.name} 上没装 ${rt}`;
  if (r.logged_in === false) return en ? `${rt} isn’t logged in on ${m.name}` : `${m.name} 上的 ${rt} 没登录`;
  return "";
}

/** Who must say yes before a message @ing this agent becomes work: none (it starts), its owner, or it won't take it. */
export function dispatchFor(a: Agent, me: User | null): "start" | "confirm" | "refused" {
  if (me && me.id === a.owner_id) return "start";
  return a.dispatch === "owner" ? "refused" : a.confirm ? "confirm" : "start";
}

/** The trailing "@prefix" being typed at the end of `text` (null when the end isn't a mention). */
export function mentionAt(text: string): { start: number; query: string } | null {
  const m = text.match(/(^|[^\w@])@([a-z0-9_-]{0,32})$/i);
  return m ? { start: text.length - m[2].length - 1, query: m[2].toLowerCase() } : null;
}

export const isMember = (c: Channel, kind: Member["kind"], id: string) => c.members.some((m) => m.kind === kind && m.id === id);

/** The pieces of a message's text, with @mentions marked (only the ones the server resolved). */
export function textParts(text: string, mentions: readonly Mention[] | null): { text: string; mention?: Mention }[] {
  const known = new Map((mentions ?? []).map((m) => [m.handle, m]));
  const out: { text: string; mention?: Mention }[] = [];
  const re = /(^|[^\w@])@([a-z][a-z0-9_-]{1,31})/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const at = m.index + m[1].length, mention = known.get(m[2]);
    if (!mention) continue;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ text: `@${m[2]}`, mention });
    last = at + 1 + m[2].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

const RETRY_MS = 3000;
const OFFLINE_AFTER = 3;
const POLL_MS = 10_000;

export function createTeam(s: Session) {
  const conn = signal<Conn>("connecting");
  const me = signal<User | null>(null);
  const users = signal<User[]>([]);
  const agents = signal<Agent[]>([]);
  const machines = signal<Machine[]>([]);
  const channels = signal<Channel[]>([]);
  const loaded = signal(false);
  /** Top-level messages of the channels opened so far. */
  const top = signal<Record<string, Message[]>>({});
  const more = signal<Record<string, boolean>>({});
  /** Replies of the threads opened so far, by root id. */
  const threads = signal<Record<string, Message[]>>({});
  /** Tasks by id (the ones of the channels opened so far, and the inbox's). */
  const tasks = signal<Record<string, Task>>({});
  /** What waits for this person (tasks to confirm, decisions, results to accept). */
  const inbox = signal<string[]>([]);
  /** Tasks waiting for an outside result: shown, never notified. */
  const waiting = signal<string[]>([]);
  /** New top-level messages from others since a channel was last looked at. */
  const unread = signal<Record<string, number>>({});
  let viewing: string | null = null;
  let after = 0; // the newest message seq seen
  let disposed = false;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  async function api(method: string, path: string, body?: unknown): Promise<Reply> {
    const r = await call(s.url, method, path, s.session, body);
    if (r.status === 401) conn.set("unauthorized");
    return r;
  }

  function seen(m: Message) {
    if (m.seq > after) after = m.seq;
  }

  /** A message from the socket, a catch-up page, or our own post. */
  function applyMessage(m: Message, live: boolean) {
    seen(m);
    if (m.thread_id) {
      const root = m.thread_id;
      const known = (untracked(threads)[root] ?? []).some((x) => x.id === m.id);
      if (untracked(threads)[root]) threads.update((t) => ({ ...t, [root]: mergeMessages(t[root], [m]) }));
      if (!known) {
        top.update((t) => {
          const list = t[m.channel_id];
          if (!list?.some((x) => x.id === root)) return t;
          return { ...t, [m.channel_id]: list.map((x) => (x.id === root ? { ...x, reply_count: x.reply_count + 1, last_reply_at: m.created } : x)) };
        });
      }
      return;
    }
    const list = untracked(top)[m.channel_id];
    const isNew = !list?.some((x) => x.id === m.id);
    if (list) top.update((t) => ({ ...t, [m.channel_id]: mergeMessages(t[m.channel_id], [m]) }));
    const mine = m.author.kind === "user" && m.author.id === untracked(me)?.id;
    if (live && isNew && !mine && viewing !== m.channel_id) unread.update((u) => ({ ...u, [m.channel_id]: (u[m.channel_id] ?? 0) + 1 }));
  }

  function applyFrame(f: any) {
    switch (f?.type) {
      case "message":
      case "message_edited":
        if (f.message) applyMessage(f.message as Message, f.type === "message");
        break;
      case "channel":
        if (f.channel) channels.update((cs) => upsert(cs, f.channel as Channel));
        break;
      case "user":
        if (f.user) users.update((us) => upsert(us, f.user as User));
        break;
      case "agent":
        if (f.agent) agents.update((as) => upsert(as, f.agent as Agent));
        break;
      case "agent_removed":
        agents.update((as) => as.filter((a) => a.id !== f.id));
        break;
      case "machine":
        if (f.machine) machines.update((ms) => upsert(ms, f.machine as Machine));
        break;
      case "task":
        if (f.task) {
          putTasks([f.task as Task]);
          refreshInbox();
        }
        break;
    }
  }

  function putTasks(ts: Task[]) {
    if (ts.length) tasks.update((x) => ({ ...x, ...Object.fromEntries(ts.map((t) => [t.id, t])) }));
  }
  let inboxTimer: ReturnType<typeof setTimeout> | undefined;
  /** Soon (task frames come in bursts). */
  function refreshInbox() {
    clearTimeout(inboxTimer);
    inboxTimer = setTimeout(loadInbox, 300);
  }
  /** The tracked tasks (of one channel, or of every channel this person can see): the task views. */
  async function loadTasks(channelId?: string) {
    const r = await api("GET", `/api/v1/tasks?tracked=1&limit=500${channelId ? `&channel=${channelId}` : ""}`);
    if (r.ok) putTasks(r.data.tasks as Task[]);
  }
  async function loadInbox() {
    const r = await api("GET", "/api/v1/inbox");
    if (!r.ok) return;
    putTasks(r.data.tasks as Task[]);
    inbox.set((r.data.tasks as Task[]).map((t) => t.id));
    const w = await api("GET", "/api/v1/tasks?state=waiting&limit=100");
    if (!w.ok) return;
    putTasks(w.data.tasks as Task[]);
    waiting.set((w.data.tasks as Task[]).map((t) => t.id));
  }

  async function load() {
    const [m, u, a, ma, c] = await Promise.all([
      api("GET", "/api/v1/me"), api("GET", "/api/v1/users"), api("GET", "/api/v1/agents"), api("GET", "/api/v1/machines"), api("GET", "/api/v1/channels"),
    ]);
    if (m.ok) me.set(m.data.user as User);
    if (u.ok) users.set(u.data.users as User[]);
    if (a.ok) agents.set(a.data.agents as Agent[]);
    if (ma.ok) machines.set(ma.data.machines as Machine[]);
    if (c.ok) {
      const cs = c.data.channels as Channel[];
      channels.set(cs);
      for (const ch of cs) if (ch.last_seq > after) after = ch.last_seq;
    }
    loaded.set(true);
    if (m.ok) void loadInbox();
    return m.ok;
  }

  /** Every message after the newest one seen, in the channels this person is in. */
  let catching = false;
  async function catchUp() {
    if (catching) return;
    catching = true;
    try {
      for (let page = 0; page < 20; page++) {
        const r = await api("GET", `/api/v1/updates?after=${after}`);
        if (!r.ok) break;
        for (const m of r.data.messages as Message[]) applyMessage(m, true);
        if (!r.data.more) break;
      }
    } finally {
      catching = false;
    }
  }

  function stream() {
    if (disposed || untracked(conn) === "unauthorized") return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(s.url, s.session));
    } catch {
      return scheduleRetry();
    }
    socket = ws;
    ws.onopen = () => {
      failures = 0;
      conn.set("live");
      catchUp();
    };
    ws.onmessage = (e: { data: unknown }) => {
      try {
        applyFrame(JSON.parse(String(e.data)));
      } catch {
        /* not JSON (a pong) */
      }
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      scheduleRetry();
    };
  }
  function scheduleRetry() {
    if (disposed) return;
    if (++failures >= OFFLINE_AFTER && untracked(conn) !== "unauthorized") conn.set("offline");
    clearTimeout(retry);
    retry = setTimeout(async () => {
      await catchUp();
      stream();
    }, RETRY_MS);
  }
  const poll = setInterval(() => untracked(conn) !== "live" && untracked(conn) !== "unauthorized" && catchUp(), POLL_MS);

  async function openChannel(id: string) {
    viewing = id;
    unread.update((u) => ({ ...u, [id]: 0 }));
    if (untracked(top)[id]) return;
    void api("GET", `/api/v1/tasks?channel=${id}&limit=200`).then((t) => t.ok && putTasks(t.data.tasks as Task[]));
    const r = await api("GET", `/api/v1/channels/${id}/messages?limit=50`);
    if (!r.ok) return;
    for (const m of r.data.messages as Message[]) seen(m);
    top.update((t) => ({ ...t, [id]: mergeMessages(t[id] ?? [], r.data.messages) }));
    more.update((x) => ({ ...x, [id]: !!r.data.more }));
  }
  function leaveView() {
    viewing = null;
  }
  async function loadOlder(id: string) {
    const list = untracked(top)[id];
    if (!list?.length || !untracked(more)[id]) return;
    const r = await api("GET", `/api/v1/channels/${id}/messages?limit=50&before=${list[0].seq}`);
    if (!r.ok) return;
    top.update((t) => ({ ...t, [id]: mergeMessages(t[id] ?? [], r.data.messages) }));
    more.update((x) => ({ ...x, [id]: !!r.data.more }));
  }
  async function openThread(rootId: string) {
    const r = await api("GET", `/api/v1/messages/${rootId}/thread`);
    if (!r.ok) return null;
    threads.update((t) => ({ ...t, [r.data.root.id]: mergeMessages(t[r.data.root.id] ?? [], r.data.replies) }));
    return r.data.root as Message;
  }

  let counter = 0;
  /** Puts a file on the server for a message: its "/media/…" path, or the reason it failed. */
  async function upload(file: Blob, name: string): Promise<{ path: string } | { error: string }> {
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${s.session}` };
      if (file.type) headers["Content-Type"] = file.type;
      const r = await fetch(`${s.url}/api/v1/uploads?name=${encodeURIComponent(name)}`, { method: "POST", headers, body: file });
      if (r.status === 401) conn.set("unauthorized");
      const data: any = await r.json().catch(() => ({}));
      return r.ok && data.path ? { path: String(data.path) } : { error: data.error || L(`Couldn’t upload ${name} (${r.status})`, `${name} 上传失败（${r.status}）`) };
    } catch {
      return { error: L(`Couldn’t upload ${name}: the server is unreachable`, `${name} 上传失败：连不上服务器`) };
    }
  }
  /** A message's files, each with a short-lived link to show or download it. */
  async function attachments(messageId: string): Promise<Attachment[]> {
    const r = await api("GET", `/api/v1/messages/${messageId}/attachments`);
    return r.ok ? (r.data.attachments as Attachment[]).map((a) => ({ ...a, url: a.url ? s.url.replace(/\/$/, "") + a.url : undefined })) : [];
  }
  /** asTask: the composer's "as task" (a top-level message that @s an agent): tracked as a task from the start. */
  async function send(channelId: string, text: string, threadId: string | null = null, files: string[] = [], asTask = false): Promise<string | null> {
    const client_id = `c${Date.now().toString(36)}${(counter++).toString(36)}`;
    const r = await api("POST", `/api/v1/channels/${channelId}/messages`, { text, client_id, ...(threadId ? { thread_id: threadId } : {}), ...(files.length ? { attachments: files } : {}), ...(asTask ? { as_task: true } : {}) });
    if (!r.ok) return errorOf(r, `发送失败（${r.status || "连不上服务器"}）`);
    applyMessage(r.data as Message, false);
    return null;
  }

  async function createChannel(name: string, topic: string, members: Member[]): Promise<Reply> {
    const r = await api("POST", "/api/v1/channels", { name, topic, members });
    if (r.ok) channels.update((cs) => upsert(cs, r.data as Channel));
    return r;
  }
  async function join(channelId: string) {
    const r = await api("POST", `/api/v1/channels/${channelId}/members`, {});
    if (r.ok && r.data?.id) channels.update((cs) => upsert(cs, r.data as Channel));
    return r;
  }
  async function addMember(channelId: string, m: Member) {
    const r = await api("POST", `/api/v1/channels/${channelId}/members`, m);
    if (r.ok && r.data?.id) channels.update((cs) => upsert(cs, r.data as Channel));
    return r;
  }
  /** name, topic, or the default repository (an address; "" clears it). */
  async function patchChannel(channelId: string, patch: { name?: string; topic?: string; repo?: string }) {
    const r = await api("PATCH", `/api/v1/channels/${channelId}`, patch);
    if (r.ok && r.data?.id) channels.update((cs) => upsert(cs, r.data as Channel));
    return r;
  }
  /** The repositories the team's machines have. */
  const repos = async (): Promise<Repo[]> => {
    const r = await api("GET", "/api/v1/repos");
    return r.ok ? (r.data.repos as Repo[]) : [];
  };
  async function removeMember(channelId: string, m: Member) {
    const r = await api("DELETE", `/api/v1/channels/${channelId}/members/${m.kind}/${m.id}`);
    if (r.ok && r.data?.id) channels.update((cs) => upsert(cs, r.data as Channel));
    return r;
  }

  async function createAgent(body: Partial<Agent>) {
    const r = await api("POST", "/api/v1/agents", body);
    if (r.ok) agents.update((as) => upsert(as, r.data as Agent));
    return r;
  }
  async function patchAgent(id: string, patch: Partial<Agent>) {
    const r = await api("PATCH", `/api/v1/agents/${id}`, patch);
    if (r.ok) agents.update((as) => upsert(as, r.data as Agent));
    return r;
  }
  async function deleteAgent(id: string) {
    const r = await api("DELETE", `/api/v1/agents/${id}`);
    if (r.ok) agents.update((as) => as.filter((a) => a.id !== id));
    return r;
  }
  async function createMachine(name: string) {
    const r = await api("POST", "/api/v1/machines", { name });
    if (r.ok) machines.update((ms) => upsert(ms, r.data.machine as Machine));
    return r;
  }
  /** A command that adds my computers: each reports in by itself when it runs it (an hour). */
  async function enrollMachine() {
    return api("POST", "/api/v1/machines/enroll");
  }
  async function renameMachine(id: string, name: string) {
    const r = await api("PATCH", `/api/v1/machines/${id}`, { name });
    if (r.ok) machines.update((ms) => upsert(ms, r.data.machine as Machine));
    return r;
  }
  /** A new one-time join code for a machine (an hour); joining with it replaces the machine's token. */
  async function machineJoinCode(id: string) {
    return api("POST", `/api/v1/machines/${id}/join`);
  }
  async function deleteMachine(id: string) {
    const r = await api("DELETE", `/api/v1/machines/${id}`);
    if (r.ok) {
      machines.update((ms) => ms.filter((m) => m.id !== id));
      agents.update((as) => as.map((a) => (a.machine_id === id ? { ...a, machine_id: null } : a)));
    }
    return r;
  }
  const invite = (email: string, role: "admin" | "member") => api("POST", "/api/v1/invites", { email, role });
  /** A one-time login code: for this person's other device, or (an admin) for a member who lost theirs. */
  const loginCode = (userId?: string) => api("POST", "/api/v1/login-codes", userId ? { user_id: userId } : {});

  const devices = () => api("GET", "/api/v1/sessions");
  const removeDevice = (id: string) => api("DELETE", `/api/v1/sessions/${id}`);
  const gitSettings = () => api("GET", "/api/v1/git");
  const saveGitPlatforms = (platforms: GitPlatform[]) => api("PUT", "/api/v1/git/platforms", { platforms });

  /** confirm | decline | cancel | accept (done) | decide ({choice}) | reopen ({note}) | track (convert to a task). */
  async function act(id: string, action: "confirm" | "decline" | "cancel" | "accept" | "decide" | "reopen" | "track", body: unknown = {}) {
    const r = await api("POST", `/api/v1/tasks/${id}/${action}`, body);
    if (r.ok) {
      putTasks([r.data as Task]);
      refreshInbox();
    }
    return r;
  }
  /** The creator or the agent's owner writes down what "done" means. */
  async function setAcceptance(id: string, acceptance: string) {
    const r = await api("PATCH", `/api/v1/tasks/${id}`, { acceptance });
    if (r.ok) putTasks([r.data as Task]);
    return r;
  }
  /** A link (15 minutes, no session needed) to a file output, its preview, or an older version. */
  async function outputLink(id: string, o: { preview?: boolean; version?: number } = {}): Promise<string | null> {
    const q = o.preview ? "?preview=1" : o.version ? `?v=${o.version}` : "";
    const r = await api("GET", `/api/v1/outputs/${id}/link${q}`);
    return r.ok ? s.url.replace(/\/$/, "") + r.data.url : null;
  }
  /** Where a task runs, before it ever ran (an address; "" = a general task). */
  async function setTaskRepo(id: string, repo: string) {
    const r = await api("PATCH", `/api/v1/tasks/${id}`, { repo });
    if (r.ok) putTasks([r.data as Task]);
    return r;
  }
  const taskOfThread = (rootId: string) => Object.values(tasks()).filter((t) => t.thread_id === rootId).sort((a, b) => a.created - b.created);

  async function logout() {
    await call(s.url, "POST", "/api/v1/logout", s.session);
  }

  function dispose() {
    disposed = true;
    clearInterval(poll);
    clearTimeout(retry);
    clearTimeout(inboxTimer);
    socket?.close();
  }

  const userById = (id: string) => untracked(users).find((u) => u.id === id);
  const agentById = (id: string) => untracked(agents).find((a) => a.id === id);

  load().then((ok) => {
    if (ok) stream();
  });

  return {
    url: s.url, conn, me, users, agents, machines, channels, loaded, top, more, threads, unread, tasks, inbox, waiting, act, setAcceptance, setTaskRepo, outputLink, taskOfThread, loadInbox, loadTasks,
    openChannel, leaveView, loadOlder, openThread, send, upload, attachments, createChannel, join, addMember, removeMember, patchChannel, repos,
    createAgent, patchAgent, deleteAgent, createMachine, enrollMachine, renameMachine, machineJoinCode, deleteMachine, invite, loginCode, devices, removeDevice, gitSettings, saveGitPlatforms, logout, dispose, applyFrame, catchUp,
    userById, agentById,
  };
}
export type Team = ReturnType<typeof createTeam>;

/** May this person act on the task as its creator or its agent's owner (admins may too)? */
export const isParty = (t: Task, me: User | null, agent: Agent | undefined) => !!me && (me.id === t.created_by || me.id === agent?.owner_id || me.role === "admin");
