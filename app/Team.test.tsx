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

type Log = { posts: any[]; patches: any[]; created: any[] };
function server(log: Log, over: Record<string, unknown> = {}) {
  let seq = 10;
  return {
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
const newLog = (): Log => ({ posts: [], patches: [], created: [] });

describe("team sign in", () => {
  test("an invite link: name and @handle, bind the authenticator, then the workspace", async () => {
    const accepts: any[] = [];
    const app = await open("./App.tsx", {
      width: 1200, height: 800,
      network: {
        ...server(newLog()),
        [`GET ${URL}/api/v1/invites/INVITECODE123`]: { body: { email: "zw@corp.com", role: "admin" } },
        [`POST ${URL}/api/v1/invites/INVITECODE123/accept`]: (r: { body?: string | null }) => {
          const b = JSON.parse(r.body!);
          accepts.push(b);
          if (!b.totp) return { body: { secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/TeamAgent:zw@corp.com?secret=JBSWY3DPEHPK3PXP" } };
          return b.totp === "123456" ? { body: { session: "sess", user: zw } } : { status: 400, body: { error: "验证码不对" } };
        },
      },
    });
    await app.waitFor("id:team-signin");
    await app.press("id:signin-mode-invite");
    await app.type("id:invite-link", `${URL}/invite/INVITECODE123`);
    await app.press("id:invite-open");
    await app.waitFor("text:/zw@corp.com/");
    expect(app.value("id:invite-handle")).toBe("zw");
    await app.type("id:invite-name", "张伟");
    await app.clear("id:invite-handle");
    await app.type("id:invite-handle", "zhangwei");
    await app.press("id:invite-next");
    await app.waitFor("id:invite-secret");
    expect(app.shows("text:JBSW Y3DP EHPK 3PXP")).toBe(true);
    await app.type("id:invite-totp", "000000");
    await app.waitFor("验证码不对");
    await app.type("id:invite-totp", "123456");
    await app.waitFor("id:team-composer");
    expect(accepts).toEqual([
      { name: "张伟", handle: "zhangwei" },
      { name: "张伟", handle: "zhangwei", totp: "000000" },
      { name: "张伟", handle: "zhangwei", totp: "123456" },
    ]);
    expect(app.storage()["team.session"]).toBe("sess");
    expect(app.storage()["team.url"]).toBe(URL);
  });

  test("email and the authenticator's 6 digits sign in; a wrong code is explained", async () => {
    const logins: any[] = [];
    const app = await open("./App.tsx", {
      width: 1200, height: 800,
      network: {
        ...server(newLog()),
        [`POST ${URL}/api/v1/login`]: (r: { body?: string | null }) => {
          const b = JSON.parse(r.body!);
          logins.push(b);
          return b.totp === "654321" ? { body: { session: "sess", user: zw } } : { status: 401, body: { error: "邮箱或验证码不对" } };
        },
      },
    });
    await app.type("id:team-url", "hub.test:8080/");
    await app.type("id:team-email", "zw@corp.com");
    await app.type("id:team-totp", "111111");
    await app.waitFor("邮箱或验证码不对");
    expect(app.value("id:team-totp")).toBe("");
    await app.type("id:team-totp", "654321");
    await app.waitFor("id:team-composer");
    expect(logins).toEqual([{ email: "zw@corp.com", totp: "111111" }, { email: "zw@corp.com", totp: "654321" }]);
    expect(app.storage()["team.email"]).toBe("zw@corp.com");
  });

  test("an unreachable server is told apart; a 401 later sends you back to sign in", async () => {
    const app = await open("./App.tsx", { width: 1200, height: 800, network: {} });
    await app.type("id:team-url", "nowhere.test:1");
    await app.type("id:team-email", "zw@corp.com");
    await app.type("id:team-totp", "123456");
    await app.waitFor("text:/连不上服务器|Can’t reach/");

    const expired = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: { ...server(newLog()), [`GET ${URL}/api/v1/me`]: { status: 401 } } });
    await expired.waitFor("text:/session expired|登录已过期/");
    expect(expired.storage()["team.session"]).toBe(undefined);
    expect(expired.value("id:team-email")).toBe("zw@corp.com");
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
