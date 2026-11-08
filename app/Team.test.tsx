import { describe, expect, open, test } from "nsh/test";

const URL = "http://hub.test:8080";
const SESSION = { "team.url": URL, "team.session": "sess", "team.email": "zw@corp.com" };
const T0 = Date.now() - 3600_000;

const zw = { id: "u_1", email: "zw@corp.com", handle: "zhangwei", name: "张伟", role: "admin", disabled: false };
const wl = { id: "u_2", email: "wl@corp.com", handle: "wanglei", name: "王磊", role: "member", disabled: false };
const mac = { id: "m_1", owner_id: "u_1", name: "张伟的 Mac", os: "darwin", arch: "arm64", runtimes: ["codex"], max_sessions: 3, online: true, last_seen: T0 };
const acha = { id: "a_1", owner_id: "u_1", machine_id: "m_1", handle: "acha", name: "阿查", description: "", runtime: "codex", dispatch: "confirm", autonomy: "assist" };
const pay = { id: "c_1", slug: "pay", name: "支付后端", topic: "慢查询", archived: false, created: T0, members: [{ kind: "user", id: "u_1" }, { kind: "user", id: "u_2" }, { kind: "agent", id: "a_1" }], last_seq: 2 };
const ops = { id: "c_2", slug: "ops", name: "运维", topic: "", archived: false, created: T0, members: [{ kind: "user", id: "u_2" }], last_seq: 0 };
const msg = (over: Record<string, unknown>) => ({
  id: "msg_1", seq: 1, channel_id: "c_1", thread_id: null, author: { kind: "user", id: "u_2" }, text: "", mentions: [], attachments: [],
  client_id: null, created: T0, edited: null, reply_count: 0, last_reply_at: null, ...over,
});
const m1 = msg({ id: "msg_1", seq: 1, text: "@acha 看下慢查询", mentions: [{ kind: "agent", id: "a_1", handle: "acha" }], reply_count: 1 });
const r1 = msg({ id: "msg_2", seq: 2, thread_id: "msg_1", author: { kind: "agent", id: "a_1" }, text: "收到，在看" });

type Log = { posts: any[]; patches: any[]; created: any[]; acts: string[] };
const task = (over: Record<string, unknown>) => ({
  id: "T-0001", channel_id: "c_1", thread_id: "msg_1", agent_id: "a_1", created_by: "u_2", title: "看下慢查询", body: "@acha 看下慢查询",
  state: "pending", step: "", summary: "", decision: null, pr: null, branch: "agent/T-0001", claimed_by: null, confirmed_by: null, runs: 0,
  created: T0, updated: T0, ...over,
});
function server(log: Log, over: Record<string, unknown> = {}, tasks: any[] = []) {
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
  const waiting = () => [...live.values()].filter((t) => ["pending", "needs_decision", "review"].includes(t.state));
  return {
    [`GET ${URL}/api/v1/tasks?*`]: () => ({ body: { tasks: [...live.values()] } }),
    [`GET ${URL}/api/v1/inbox`]: () => ({ body: { tasks: waiting() } }),
    [`POST ${URL}/api/v1/tasks/*/confirm`]: act("confirm", (t) => { t.state = "queued"; }),
    [`POST ${URL}/api/v1/tasks/*/decline`]: act("decline", (t) => { t.state = "closed"; }),
    [`POST ${URL}/api/v1/tasks/*/cancel`]: act("cancel", (t) => { t.state = "closed"; }),
    [`POST ${URL}/api/v1/tasks/*/accept`]: act("accept", (t) => { t.state = "done"; }),
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
      return { body: { machine: { ...mac, id: "m_2", name: JSON.parse(r.body!).name, online: false, runtimes: [] }, token: "tam_" + "ab".repeat(32) } };
    },
    [`PATCH ${URL}/api/v1/agents/a_1`]: (r: { body?: string | null }) => {
      const p = JSON.parse(r.body!);
      log.patches.push(p);
      return { body: { ...acha, ...p } };
    },
    [`POST ${URL}/api/v1/invites`]: { body: { code: "INVITECODE123", path: "/invite/INVITECODE123", expires: Date.now() + 7 * 86400_000 } },
    [`POST ${URL}/api/v1/logout`]: { body: { ok: true } },
    ...over,
  };
}
const newLog = (): Log => ({ posts: [], patches: [], created: [], acts: [] });

describe("team sign in", () => {
  test("an invite link: name and @handle, then the workspace", async () => {
    const accepts: any[] = [];
    const app = await open("./App.tsx", {
      width: 1200, height: 800,
      network: {
        ...server(newLog()),
        [`GET ${URL}/api/v1/invites/INVITECODE123`]: { body: { email: "zw@corp.com", role: "admin" } },
        [`POST ${URL}/api/v1/invites/INVITECODE123/accept`]: (r: { body?: string | null }) => {
          const b = JSON.parse(r.body!);
          accepts.push(b);
          return b.handle === "taken" ? { status: 409, body: { error: "@taken 已经被占用了" } } : { body: { session: "sess", user: zw } };
        },
      },
    });
    await app.waitFor("id:team-signin");
    expect(app.shows("id:team-logo")).toBe(true);
    await app.press("id:signin-mode-invite");
    await app.type("id:invite-link", `${URL}/invite/INVITECODE123`);
    await app.press("id:invite-open");
    await app.waitFor("text:/zw@corp.com/");
    expect(app.value("id:invite-handle")).toBe("zw");
    await app.type("id:invite-name", "张伟");
    await app.clear("id:invite-handle");
    await app.type("id:invite-handle", "taken");
    await app.press("id:invite-join");
    await app.waitFor("@taken 已经被占用了");
    await app.clear("id:invite-handle");
    await app.type("id:invite-handle", "zhangwei");
    await app.press("id:invite-join");
    await app.waitFor("id:team-composer");
    expect(accepts).toEqual([{ name: "张伟", handle: "taken" }, { name: "张伟", handle: "zhangwei" }]);
    expect(app.storage()["team.session"]).toBe("sess");
    expect(app.storage()["team.url"]).toBe(URL);
  });

  test("a login code, or a pasted login link that brings its server, signs in", async () => {
    const logins: any[] = [];
    const net = {
      ...server(newLog()),
      [`POST ${URL}/api/v1/login`]: (r: { body?: string | null }) => {
        const b = JSON.parse(r.body!);
        logins.push(b);
        return b.code.toUpperCase().endsWith("EFGH") ? { body: { session: "sess", user: zw } } : { status: 401, body: { error: "登录码不对或已过期" } };
      },
    };
    const app = await open("./App.tsx", { width: 1200, height: 800, network: net });
    await app.type("id:team-url", "hub.test:8080/");
    await app.type("id:team-code", "WXYZ-2345");
    await app.press("id:team-login");
    await app.waitFor("登录码不对或已过期");
    await app.clear("id:team-code");
    await app.type("id:team-code", "abcd-efgh");
    await app.press("id:team-login");
    await app.waitFor("id:team-composer");
    expect(logins).toEqual([{ code: "WXYZ-2345" }, { code: "abcd-efgh" }]);
    expect(app.storage()["team.email"]).toBe("zw@corp.com");

    const linked = await open("./App.tsx", { width: 1200, height: 800, network: net });
    await linked.type("id:team-code", `${URL}/login/ABCD-EFGH`);
    await linked.press("id:team-login");
    await linked.waitFor("id:team-composer");
    expect(linked.storage()["team.url"]).toBe(URL);
  });

  test("an unreachable server is told apart; a 401 later sends you back to sign in", async () => {
    const app = await open("./App.tsx", { width: 1200, height: 800, network: {} });
    await app.type("id:team-url", "nowhere.test:1");
    await app.type("id:team-code", "ABCD-EFGH");
    await app.press("id:team-login");
    await app.waitFor("text:/连不上服务器|Can’t reach/");

    const expired = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: { ...server(newLog()), [`GET ${URL}/api/v1/me`]: { status: 401 } } });
    await expired.waitFor("text:/session expired|登录已过期/");
    expect(expired.storage()["team.session"]).toBe(undefined);
    expect(expired.value("id:team-url")).toBe(URL);
  });
});

describe("team channels", () => {
  test("a channel shows its messages and @mentions; sending posts to it", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(log) });
    await app.waitFor("id:team-composer");
    expect(app.shows("text:/1 replies|1 条回复/")).toBe(true);
    expect(app.shows("text:/@acha/")).toBe(true);
    await app.type("id:team-composer", "@acha 顺便看下索引");
    await app.press("id:team-composer-send");
    await app.waitFor("text:@acha 顺便看下索引");
    expect(log.posts.length).toBe(1);
    expect(log.posts[0].text).toBe("@acha 顺便看下索引");
    expect(typeof log.posts[0].client_id).toBe("string");
    expect(app.value("id:team-composer")).toBe("");
  });

  test("a thread opens beside the channel; a reply goes into it and counts on the root", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(log) });
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("收到，在看");
    await app.type("id:thread-composer", "好的");
    await app.press("id:thread-composer-send");
    await app.waitFor("text:好的");
    expect(log.posts[0]).toMatchObject({ text: "好的", thread_id: "msg_1" });
    await app.waitFor("text:/2 replies|2 条回复/");
    await app.press("id:close-thread");
    expect(app.shows("id:thread")).toBe(false);
  });

  test("a channel you're not in can be read and joined", async () => {
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(newLog()) });
    await app.press("id:channel-ops");
    await app.waitFor("id:join");
    expect(app.shows("id:team-composer")).toBe(false);
    await app.press("id:join");
    await app.waitFor("id:team-composer");
  });

  test("a phone shows one pane at a time", async () => {
    const app = await open("./App.tsx", { storage: SESSION, network: server(newLog()) });
    await app.waitFor("id:channel-pay");
    expect(app.shows("id:team-composer")).toBe(false);
    await app.press("id:channel-pay");
    await app.waitFor("id:team-composer");
    await app.press("id:thread-msg_1");
    await app.waitFor("收到，在看");
    expect(app.shows("id:team-composer")).toBe(false);
    await app.press("id:back");
    await app.waitFor("id:team-composer");
    await app.press("id:back");
    await app.waitFor("id:channel-ops");
  });
});

describe("agents and machines", () => {
  test("adding a machine shows its token once, ready to paste; an agent's dispatch changes", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 900, network: server(log) });
    await app.press("id:open-settings");
    await app.waitFor("id:agent-acha");
    await app.press("id:machine-add");
    await app.type("id:machine-name", "构建机");
    await app.press("id:machine-create");
    await app.waitFor("id:machine-token");
    expect(log.created).toEqual([{ name: "构建机" }]);
    expect(app.shows(`text:/token = "tam_abab/`)).toBe(true);
    expect(app.shows(`text:/url = "${URL}"/`)).toBe(true);
    await app.press("id:agent-dispatch-acha-open");
    await app.waitUntil(() => log.patches.length === 1);
    expect(log.patches).toEqual([{ dispatch: "open" }]);
  });

  test("an admin invites someone and gets the link to send", async () => {
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 900, network: server(newLog()) });
    await app.press("id:open-settings");
    await app.type("id:invite-email", "new@corp.com");
    await app.press("id:invite-create");
    await app.waitFor("id:invite-url");
    expect(app.shows(`text:${URL}/invite/INVITECODE123`)).toBe(true);
  });

  test("a login code for another device; an admin makes a login link for a member", async () => {
    const made: any[] = [];
    const app = await open("./App.tsx", {
      storage: SESSION, width: 1200, height: 900,
      network: {
        ...server(newLog()),
        [`POST ${URL}/api/v1/login-codes`]: (r: { body?: string | null }) => {
          const b = JSON.parse(r.body!);
          made.push(b);
          const code = b.user_id ? "MEMB-ER22" : "ABCD-EFGH";
          return { body: { code, path: `/login/${code}`, expires: Date.now() + 900_000 } };
        },
      },
    });
    await app.press("id:open-settings");
    await app.press("id:login-code-create");
    await app.waitFor("id:login-code");
    expect(app.shows("text:ABCD-EFGH")).toBe(true);
    expect(app.shows(`text:${URL}/login/ABCD-EFGH`)).toBe(true);
    expect(app.shows("id:login-link-zhangwei")).toBe(false); // not for yourself
    await app.press("id:login-link-wanglei");
    await app.waitFor(`text:${URL}/login/MEMB-ER22`);
    expect(made).toEqual([{}, { user_id: "u_2" }]);
  });

  test("the language switches and is kept; sign out forgets the session", async () => {
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(newLog()) });
    await app.press("id:toggle-lang");
    await app.waitFor("text:Agent 与机器");
    expect(app.storage()["hub.lang"]).toBe("zh");
    await app.press("id:sign-out");
    await app.waitFor("id:team-signin");
    expect(app.storage()["team.session"]).toBe(undefined);
  });
});

describe("tasks", () => {
  test("an @agent's task shows on its message; the owner starts it; it waits for the machine", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(log, {}, [task({})]) });
    await app.waitFor("id:task-T-0001");
    expect(app.shows("text:Waiting for its owner")).toBe(true);
    await app.press("id:task-T-0001-confirm");
    await app.waitFor("text:Waiting for its machine");
    expect(log.acts).toEqual(["T-0001 confirm"]);
    expect(app.shows("text:/张伟的 Mac will pick it up/")).toBe(true);
    expect(app.shows("id:task-T-0001-confirm")).toBe(false);
  });

  test("a decision card: the recommended option is marked, a press answers it", async () => {
    const log = newLog();
    const t = task({ created_by: "u_1", state: "needs_decision", decision: { question: "现在上线吗？", options: ["A: 现在上", "B: 夜里再上"], recommendation: "B" } });
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(log, {}, [t]) });
    await app.waitFor("text:现在上线吗？");
    await app.press("id:task-T-0001-option-1");
    await app.waitFor("text:Waiting for its machine");
    expect(log.acts).toEqual(["T-0001 decide B: 夜里再上"]);
  });

  test("ready for review: the PR and its checks show, and the creator accepts it", async () => {
    const log = newLog();
    const t = task({ created_by: "u_1", state: "review", pr: { provider: "gitlab", url: "https://code.corp/pay/-/merge_requests/3", number: 3, state: "open", checks: "success" } });
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(log, {}, [t]) });
    await app.waitFor("id:task-T-0001-pr");
    expect(app.shows("text:PR #3 · checks passed")).toBe(true);
    await app.press("id:task-T-0001-accept");
    await app.waitFor("text:Done");
    expect(log.acts).toEqual(["T-0001 accept"]);
  });

  test("waiting for you: the sidebar counts it, the list opens its thread", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(log, {}, [task({}), task({ id: "T-0002", state: "running", step: "运行 bun test" })]) });
    await app.waitFor("id:open-inbox-unread");
    expect(app.shows("text:@acha · 运行 bun test")).toBe(true);
    await app.press("id:open-inbox");
    await app.waitFor("id:task-T-0001-open");
    expect(app.shows("id:task-T-0002")).toBe(false);
    await app.press("id:task-T-0001-open");
    await app.waitFor("收到，在看");
  });

  test("an agent's repository is set in Agents & machines", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 900, network: server(log) });
    await app.press("id:open-settings");
    await app.type("id:agent-repo-acha", "~/work/pay");
    await app.press("id:agent-repo-save-acha");
    await app.waitUntil(() => log.patches.length === 1);
    expect(log.patches).toEqual([{ repo: "~/work/pay" }]);
  });
});
