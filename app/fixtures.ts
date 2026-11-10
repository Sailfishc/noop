// Shared by the UI tests (Team.test.tsx) and the screenshot run (screens.test.tsx):
// a pretend team server with two people, a Mac, an agent and two channels.

export const URL = "http://hub.test:8080";
export const SESSION = { "team.url": URL, "team.session": "sess", "team.email": "zw@corp.com" };
export const T0 = Date.now() - 3600_000;

export const zw = { id: "u_1", email: "zw@corp.com", handle: "zhangwei", name: "张伟", role: "admin", disabled: false };
export const wl = { id: "u_2", email: "wl@corp.com", handle: "wanglei", name: "王磊", role: "member", disabled: false };
export const mac = { id: "m_1", owner_id: "u_1", name: "张伟的 Mac", os: "darwin", arch: "arm64", runtimes: ["codex"], max_sessions: 3, online: true, last_seen: T0 };
export const acha = { id: "a_1", owner_id: "u_1", machine_id: "m_1", handle: "acha", name: "阿查", description: "", runtime: "codex", dispatch: "channel", confirm: true, autonomy: "assist", model: "" };
export const pay = { id: "c_1", slug: "pay", name: "支付后端", topic: "慢查询", archived: false, created: T0, members: [{ kind: "user", id: "u_1" }, { kind: "user", id: "u_2" }, { kind: "agent", id: "a_1" }], last_seq: 2 };
export const ops = { id: "c_2", slug: "ops", name: "运维", topic: "", archived: false, created: T0, members: [{ kind: "user", id: "u_2" }], last_seq: 0 };
export const msg = (over: Record<string, unknown>) => ({
  id: "msg_1", seq: 1, channel_id: "c_1", thread_id: null, author: { kind: "user", id: "u_2" }, text: "", mentions: [], attachments: [],
  client_id: null, created: T0, edited: null, reply_count: 0, last_reply_at: null, ...over,
});
export const m1 = msg({ id: "msg_1", seq: 1, text: "@acha 看下慢查询", mentions: [{ kind: "agent", id: "a_1", handle: "acha" }], reply_count: 1 });
export const r1 = msg({ id: "msg_2", seq: 2, thread_id: "msg_1", author: { kind: "agent", id: "a_1" }, text: "收到，在看" });

export type Log = { posts: any[]; patches: any[]; created: any[]; acts: string[] };
export const task = (over: Record<string, unknown>) => ({
  id: "T-0001", channel_id: "c_1", thread_id: "msg_1", agent_id: "a_1", created_by: "u_2", title: "看下慢查询", body: "@acha 看下慢查询",
  state: "pending", step: "", summary: "", decision: null, pr: null, branch: "agent/T-0001", claimed_by: null, confirmed_by: null, runs: 0,
  created: T0, updated: T0, ...over,
});
export function server(log: Log, over: Record<string, unknown> = {}, tasks: any[] = []) {
  let seq = 10;
  const live = new Map(tasks.map((t) => [t.id, t]));
  const act = (name: string, change: (t: any, body: any) => void) => (r: { url: string; body?: string | null }) => {
    const id = r.url.match(/tasks\/([^/]+)\//)![1];
    const body = r.body ? JSON.parse(r.body) : {};
    log.acts.push(`${id} ${name}${body.choice ? ` ${body.choice}` : ""}`);
    const t = { ...live.get(id) };
    change(t, body);
    live.set(id, t);
    return { body: t };
  };
  const triggers: any[] = [...((over as any).__triggers ?? [])];
  const waiting = () => [...live.values()].filter((t) => ["pending", "needs_decision", "review"].includes(t.state));
  return {
    [`GET ${URL}/api/v1/tasks?*`]: () => ({ body: { tasks: [...live.values()] } }),
    [`GET ${URL}/api/v1/inbox`]: () => ({ body: { tasks: waiting() } }),
    [`GET ${URL}/api/v1/reminders`]: { body: { reminders: [] } },
    [`GET ${URL}/api/v1/metrics?*`]: { body: { days: 7, since: T0, reply: { count: 9, median: 1_380_000, p90: 9_000_000, open: 2, oldest: 5_400_000 },
      reply_by: { confirm: { count: 3, median: 600_000, p90: 900_000, open: 0, oldest: 0 }, accept: { count: 6, median: 2_400_000, p90: 9_000_000, open: 2, oldest: 5_400_000 } },
      runs: { tasks: 7, mean: 1.9, median: 2, max: 4, three_plus: 2 }, cancelled: 2, redone: 1,
      agents: [{ agent_id: "a_1", tasks: 9, people: 2, others: 4, team: false, machine: "张伟的 Mac" }] } },
    [`POST ${URL}/api/v1/tasks/*/confirm`]: act("confirm", (t) => { t.state = "queued"; }),
    [`POST ${URL}/api/v1/tasks/*/decline`]: act("decline", (t) => { t.state = "closed"; }),
    [`POST ${URL}/api/v1/tasks/*/cancel`]: act("cancel", (t) => { t.state = "closed"; }),
    [`POST ${URL}/api/v1/tasks/*/accept`]: act("accept", (t) => { t.state = "done"; }),
    [`POST ${URL}/api/v1/tasks/*/track`]: act("track", (t) => { t.tracked = true; }),
    [`POST ${URL}/api/v1/tasks/*/takeover`]: act("takeover", (t, b) => {
      const xs = [...(t.mandate?.takeovers ?? [])];
      if (b.approve !== undefined) { // the agent's owner on a pending takeover
        const x = xs.pop();
        if (b.approve) { xs.push({ from: x.from, to: x.to, at: x.at }); t.created_by = x.to; }
        t.mandate = { ...t.mandate, by: t.created_by, takeovers: xs };
        return;
      }
      t.mandate = { ...(t.mandate ?? {}), by: "u_1", takeovers: [...xs, { from: t.created_by, to: "u_1", at: T0 }] };
      t.created_by = "u_1";
    }),
    [`POST ${URL}/api/v1/tasks/*/handoff`]: act("handoff", (t, b) => {
      t.handoffs = (t.handoffs ?? []).map((x: any) => (x.id === b.id ? { ...x, state: b.accept ? "accepted" : "declined", decided_by: "u_1", ...(b.accept ? { task: "T-0002" } : {}) } : x));
      t.holder = { kind: "agent", id: t.agent_id, why: "work" };
    }),
    [`GET ${URL}/api/v1/triggers?*`]: () => ({ body: { triggers } }),
    [`POST ${URL}/api/v1/triggers`]: (r: { body?: string | null }) => {
      const b = JSON.parse(r.body!);
      log.created.push({ trigger: b });
      const x = { id: `trg_${triggers.length + 1}`, channel_id: b.channel_id, agent_id: b.agent, created_by: "u_1", kind: b.kind, text: b.text, repeat: b.repeat ?? "",
        due: b.kind === "schedule" ? T0 + 86400_000 : undefined, repo: (b.repo ?? "").replace(/^https?:\/\//, ""), branch: b.branch ?? "", confirmed_by: "u_1", enabled: true, fired: null, fires: 0, created: T0, max_per_day: b.max_per_day ?? 10, skipped: 0 };
      triggers.push(x);
      return { body: x };
    },
    [`POST ${URL}/api/v1/triggers/*/confirm`]: (r: { url: string }) => {
      const id = r.url.match(/triggers\/([^/]+)\//)![1];
      log.acts.push(`${id} confirm`);
      const x = triggers.find((y) => y.id === id)!;
      x.confirmed_by = "u_1";
      return { body: x };
    },
    [`GET ${URL}/api/v1/team/config`]: { body: { repo: "" } },
    [`PUT ${URL}/api/v1/team/config`]: (r: { body?: string | null }) => {
      const b = JSON.parse(r.body!);
      log.patches.push({ team_config: b });
      return { body: { repo: b.repo } };
    },
    [`POST ${URL}/api/v1/tasks/*/reopen`]: act("reopen", (t) => { t.state = "queued"; }),
    [`POST ${URL}/api/v1/tasks/*/decide`]: act("decide", (t, b) => { t.state = "queued"; t.decision = { ...t.decision, answer: b.choice }; }),
    [`GET ${URL}/api/v1/me`]: { body: { user: zw, machines: [mac], agents: [acha] } },
    [`GET ${URL}/api/v1/users`]: { body: { users: [zw, wl] } },
    [`GET ${URL}/api/v1/agents`]: { body: { agents: [acha] } },
    [`GET ${URL}/api/v1/machines`]: { body: { machines: [mac] } },
    [`GET ${URL}/api/v1/channels`]: { body: { channels: [pay, ops] } },
    [`GET ${URL}/api/v1/updates?*`]: { body: { messages: [], more: false } },
    [`GET ${URL}/api/v1/channels/c_1/messages?*`]: { body: { messages: [m1], more: false } },
    [`GET ${URL}/api/v1/channels/c_2/messages?*`]: { body: { messages: [], more: false } },
    [`GET ${URL}/api/v1/messages/msg_1/thread`]: { body: { root: m1, replies: [r1] } },
    [`POST ${URL}/api/v1/channels/*/messages`]: (r: { url: string; body?: string | null }) => {
      const b = JSON.parse(r.body!);
      log.posts.push(b);
      const channel_id = r.url.match(/channels\/([^/]+)\/messages/)![1];
      return { body: msg({ id: `msg_${++seq}`, seq, channel_id, thread_id: b.thread_id ?? null, author: { kind: "user", id: "u_1" }, text: b.text, client_id: b.client_id }) };
    },
    [`POST ${URL}/api/v1/channels/c_2/members`]: { body: { ...ops, members: [...ops.members, { kind: "user", id: "u_1" }] } },
    [`POST ${URL}/api/v1/machines`]: (r: { body?: string | null }) => {
      log.created.push(JSON.parse(r.body!));
      return { body: { machine: { ...mac, id: "m_2", name: JSON.parse(r.body!).name, online: false, runtimes: [] }, token: "tam_" + "ab".repeat(32), join: "tj_first" } };
    },
    [`POST ${URL}/api/v1/machines/m_2/join`]: { body: { join: "tj_again" } },
    [`POST ${URL}/api/v1/machines/enroll`]: { body: { join: "te_first" } },
    [`PATCH ${URL}/api/v1/machines/m_1`]: (r: { body?: string | null }) => {
      log.patches.push({ machine: JSON.parse(r.body!) });
      return { body: { machine: { ...mac, ...JSON.parse(r.body!) } } };
    },
    [`PATCH ${URL}/api/v1/agents/a_1`]: (r: { body?: string | null }) => {
      const p = JSON.parse(r.body!);
      log.patches.push(p);
      return { body: { ...acha, ...p } };
    },
    [`PATCH ${URL}/api/v1/tasks/*`]: (r: { url: string; body?: string | null }) => {
      const id = r.url.match(/tasks\/([^/?]+)/)![1];
      const b = JSON.parse(r.body!);
      const t = { ...live.get(id), ...b, ...(b.repo !== undefined ? { repo: b.repo.replace(/^https?:\/\//, "") } : {}) };
      log.acts.push(`${id} ${Object.keys(b).join(",")}${b.repo !== undefined ? ` ${b.repo}` : ""}`);
      live.set(id, t);
      return { body: t };
    },
    [`GET ${URL}/api/v1/repos`]: { body: { repos: [{ remote: "github.com/acme/pay", name: "pay", machines: ["m_1"] }, { remote: "code.corp.com/fin/ledger", name: "ledger", machines: [] }] } },
    [`PATCH ${URL}/api/v1/channels/c_1`]: (r: { body?: string | null }) => {
      const b = JSON.parse(r.body!);
      log.patches.push({ channel: b });
      return { body: { ...pay, repo: String(b.repo ?? "").replace(/^https?:\/\//, ""), conventions: b.conventions ?? "" } };
    },
    [`POST ${URL}/api/v1/invites`]: { body: { code: "INVITECODE123", path: "/invite/INVITECODE123", expires: Date.now() + 7 * 86400_000 } },
    [`POST ${URL}/api/v1/logout`]: { body: { ok: true } },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "__triggers")),
  };
}
export const newLog = (): Log => ({ posts: [], patches: [], created: [], acts: [] });
