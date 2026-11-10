import { describe, expect, open, test } from "nsh/test";
import { URL, SESSION, T0, zw, wl, mac, acha, pay, ops, msg, m1, r1, type Log, task, server, newLog } from "./fixtures";

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

  test("asking to join: the request waits for an admin; once approved this device signs in, even after a restart", async () => {
    const asks: any[] = [];
    let state = "pending";
    const net = {
      ...server(newLog()),
      [`GET ${URL}/api/v1/workspace`]: { body: { id: "w_1", name: "支付团队", signup: true } },
      [`POST ${URL}/api/v1/signup`]: (r: { body?: string | null }) => {
        asks.push(JSON.parse(r.body!));
        return { status: 201, body: { id: "s_1", token: "tsu_abc", state: "pending" } };
      },
      [`GET ${URL}/api/v1/signup/tsu_abc`]: () => ({ body: { state, email: "wl@corp.com" } }),
      [`POST ${URL}/api/v1/signup/tsu_abc/session`]: () => (state === "approved" ? { body: { session: "sess2", user: wl } } : { status: 409, body: { error: "还在等管理员审批" } }),
    };
    const app = await open("./App.tsx", { width: 1200, height: 800, network: net });
    await app.press("id:signin-mode-ask");
    await app.type("id:ask-url", "hub.test:8080");
    await app.type("id:ask-name", "王磊");
    await app.type("id:ask-handle", "wanglei");
    await app.type("id:ask-email", "wl@corp.com");
    await app.type("id:ask-note", "支付组新人");
    await app.press("id:ask-send");
    await app.waitFor("id:ask-waiting");
    expect(app.shows("text:/支付团队/")).toBe(true);
    expect(asks).toEqual([{ email: "wl@corp.com", name: "王磊", handle: "wanglei", note: "支付组新人" }]);
    expect(JSON.parse(app.storage()["team.signup"]).token).toBe("tsu_abc");
    await app.press("id:ask-check");
    expect(app.shows("id:ask-waiting")).toBe(true);

    state = "approved";
    const again = await open("./App.tsx", { width: 1200, height: 800, storage: { "team.signup": app.storage()["team.signup"] }, network: net });
    await again.waitFor("id:team-composer");
    expect(again.storage()["team.session"]).toBe("sess2");
    expect(again.storage()["team.signup"]).toBe(undefined);
  });

  test("a rejected request says so; a closed team says to ask for an invite", async () => {
    const net = {
      ...server(newLog()),
      [`GET ${URL}/api/v1/workspace`]: { body: { id: "w_1", name: "", signup: false } },
      [`GET ${URL}/api/v1/signup/tsu_abc`]: { body: { state: "rejected", email: "wl@corp.com" } },
    };
    const app = await open("./App.tsx", { width: 1200, height: 800, storage: { "team.signup": JSON.stringify({ server: URL, token: "tsu_abc", email: "wl@corp.com", team: "" }) }, network: net });
    await app.waitFor("text:/没有通过|didn’t approve/");
    await app.press("id:ask-again");
    await app.type("id:ask-url", URL);
    await app.type("id:ask-name", "王磊");
    await app.type("id:ask-handle", "wanglei");
    await app.type("id:ask-email", "wl@corp.com");
    await app.press("id:ask-send");
    await app.waitFor("text:/没有开放申请|doesn’t take requests/");
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
    await app.waitFor("text:/顺便看下索引/");
    expect(log.posts.length).toBe(1);
    expect(log.posts[0].text).toBe("@acha 顺便看下索引");
    expect(typeof log.posts[0].client_id).toBe("string");
    expect(app.value("id:team-composer")).toBe("");
  });

  test("a message's copy button puts its text on the clipboard", async () => {
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(newLog()) });
    await app.waitFor("id:team-composer");
    await app.press("id:copy-msg_1");
    expect(app.clipboard()).toBe(m1.text);
    await app.waitFor("label:/Copied|已复制/");
  });

  test("search finds messages and tasks in every channel, and a result opens its thread", async () => {
    const asked: string[] = [];
    const app = await open("./App.tsx", {
      storage: SESSION, width: 1200, height: 800,
      network: {
        ...server(newLog()),
        [`GET ${URL}/api/v1/search?*`]: (r: { url: string }) => {
          asked.push(decodeURIComponent((r.url.match(/[?&]q=([^&]*)/)?.[1] ?? "").replace(/\+/g, " ")));
          return { body: { messages: [m1], tasks: [task({ state: "review", title: "看下慢查询" })] } };
        },
      },
    });
    await app.waitFor("id:team-composer");
    await app.press("id:open-search");
    await app.type("id:search-input", "慢查询");
    await app.waitFor("id:search-msg-msg_1");
    expect(asked.at(-1)).toBe("慢查询");
    expect(app.shows("id:search-task-T-0001")).toBe(true);
    await app.press("id:search-msg-msg_1");
    await app.waitFor("text:收到，在看");
  });

  test("reminders: a message's bell, /remind in the box, and the ones that went off in 待你决定", async () => {
    const made: any[] = [];
    const seen: string[] = [];
    const rem = (over: Record<string, unknown>) => ({ id: "rem_1", by: "u_1", target: { kind: "user", id: "u_1" }, channel_id: "c_1", thread_id: "msg_1",
      message_id: "msg_1", text: "@acha 看下慢查询", due: Date.now() + 3600_000, repeat: "", created: Date.now(), fired: null, seen: null, done: false, ...over });
    let list = [rem({ id: "rem_0", due: Date.now() - 60_000, fired: Date.now() - 60_000, done: true })];
    const app = await open("./App.tsx", {
      storage: SESSION, width: 1200, height: 800,
      network: {
        ...server(newLog()),
        [`GET ${URL}/api/v1/reminders`]: () => ({ body: { reminders: list } }),
        [`POST ${URL}/api/v1/reminders`]: (r: { body?: string | null }) => {
          const b = JSON.parse(r.body!);
          made.push(b);
          const made1 = rem({ id: `rem_${made.length}`, repeat: b.command?.startsWith("每天") ? "daily" : "" });
          list = [...list, made1]; // the server lists what it made
          return { body: made1 };
        },
        [`POST ${URL}/api/v1/reminders/*/seen`]: (r: { url: string }) => {
          seen.push(r.url.match(/reminders\/([^/]+)\//)![1]);
          list = [];
          return { body: {} };
        },
      },
    });
    await app.waitFor("id:team-composer");
    await app.waitFor("id:open-inbox-unread"); // the one that went off
    await app.press("id:remind-msg_1");
    await app.press("id:remind-msg_1-1h");
    expect(made[0]).toEqual({ message_id: "msg_1", when: "1h" });

    await app.type("id:team-composer", "/remind 每天 9:00 @acha 汇总告警");
    await app.submit("id:team-composer");
    await app.waitFor("id:team-composer-sent");
    expect(made[1]).toEqual({ command: "每天 9:00 @acha 汇总告警", channel_id: "c_1", thread_id: null });

    // said in words, it is a reminder too (not a message)
    await app.type("id:team-composer", "2分钟后提醒我 看下构建");
    await app.submit("id:team-composer");
    await app.waitUntil(() => made.length === 3);
    expect(made[2]).toEqual({ command: "2分钟 看下构建", channel_id: "c_1", thread_id: null });

    await app.press("id:open-inbox");
    await app.waitFor("id:reminder-rem_0");
    expect(app.shows("id:reminders-later")).toBe(true);
    await app.press("id:reminder-rem_0-done");
    expect(seen).toEqual(["rem_0"]);
  });

  test("\"as task\" shows once the message @s an agent, and sends it as a task", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(log) });
    await app.waitFor("id:team-composer");
    await app.type("id:team-composer", "整理一下");
    expect(app.shows("id:team-composer-as-task")).toBe(false);
    await app.type("id:team-composer", " @acha 慢查询清单");
    await app.waitFor("id:team-composer-as-task");
    await app.press("id:team-composer-as-task");
    await app.press("id:team-composer-send");
    await app.waitUntil(() => log.posts.length === 1);
    expect(log.posts[0]).toMatchObject({ text: "整理一下 @acha 慢查询清单", as_task: true });
    expect(app.shows("id:team-composer-as-task")).toBe(false);
  });

  test("the composer is a plain box; Markdown typed in it shows in the message", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(log) });
    await app.waitFor("id:team-composer");
    expect(app.shows("id:team-composer-bold")).toBe(false);
    expect(app.shows("id:team-composer-code")).toBe(false);
    await app.type("id:team-composer", "- 第一条");
    await app.press("id:team-composer-send");
    await app.waitFor("text:/第一条/");
    expect(log.posts[0].text).toBe("- 第一条");
  });

  test("files: pasted, picked or dropped, shown before sending, uploaded with the message, shown on it", async () => {
    const log = newLog();
    const uploads: string[] = [];
    const withFiles = msg({ id: "msg_1", seq: 1, text: "@acha 看下这个", mentions: [{ kind: "agent", id: "a_1", handle: "acha" }], attachments: ["/media/1-a-shot.png", "/media/1-b-spec.pdf"] });
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(log, {
      [`GET ${URL}/api/v1/channels/c_1/messages?*`]: { body: { messages: [withFiles], more: false } },
      [`GET ${URL}/api/v1/messages/msg_1/attachments`]: { body: { attachments: [
        { path: "/media/1-a-shot.png", name: "截图.png", mime: "image/png", size: 2048, url: "/api/v1/media/1-a-shot.png/signed?x" },
        { path: "/media/1-b-spec.pdf", name: "需求.pdf", mime: "application/pdf", size: 3 << 20, url: "/api/v1/media/1-b-spec.pdf/signed?x" },
        { path: "/media/1-c-run.log", name: "run.log", mime: "text/plain", size: 9000, url: "/api/v1/media/1-c-run.log/signed?x",
          preview: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"), more: true },
      ] } },
      [`GET ${URL}/api/v1/media/*`]: { body: "" },
      [`POST ${URL}/api/v1/uploads?*`]: (r: { url: string }) => {
        const name = decodeURIComponent(r.url.split("name=")[1]);
        uploads.push(name);
        return { body: { path: `/media/9-x-${uploads.length}`, name, mime: "", size: 1 } };
      },
    }) });
    await app.waitFor("id:message-file");
    expect(app.shows("text:需求.pdf")).toBe(true);
    expect(app.shows("text:3.0 MB")).toBe(true);
    expect(app.shows("id:message-picture")).toBe(true);
    expect(app.shows("text:/line 8/")).toBe(true); // a text file shows its first lines
    expect(app.shows("text:/line 9/")).toBe(false);
    await app.press("id:message-text-more");
    await app.waitFor("text:/Open the whole file|打开完整文件/");

    app.onPick(() => [{ name: "notes.md", type: "text/markdown", data: new TextEncoder().encode("# hi") }]);
    await app.press("id:team-composer-attach");
    await app.waitFor("id:team-composer-file");
    expect(app.shows("text:notes.md")).toBe(true);
    await app.press("id:team-composer-unattach");
    expect(app.shows("id:team-composer-file")).toBe(false);
    await app.press("id:team-composer-attach");
    await app.waitFor("id:team-composer-file");
    await app.press("id:team-composer-send"); // files alone are a message
    await app.waitUntil(() => log.posts.length === 1);
    expect(uploads).toEqual(["notes.md"]);
    expect(log.posts[0].attachments).toEqual(["/media/9-x-1"]);
    expect(app.shows("id:team-composer-file")).toBe(false);
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

  test("the thread column widens when its edge is dragged, and keeps its width", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: SESSION, width: 1400, height: 800, network: server(log) });
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("id:side-resize");
    await app.drag("id:side-resize", { x: -200 });
    await app.waitUntil(() => app.storage()["team.sideWidth"] === "580");
    await app.drag("id:side-resize", { x: -2000 });
    await app.waitUntil(() => app.storage()["team.sideWidth"] === String(1400 - 248 - 360));
    await app.drag("id:side-resize", { x: 2000 });
    await app.waitUntil(() => app.storage()["team.sideWidth"] === "320");
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

describe("settings", () => {
  const settings = async (app: any, tab: string) => {
    await app.press("id:user-menu");
    await app.press("id:menu-settings");
    await app.waitFor("id:settings");
    await app.press(`id:settings-nav-${tab}`);
  };

  test("the bottom-left menu and ⌘, open Settings, a page of its own; back returns to the channel", async () => {
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: { ...server(newLog()), [`GET ${URL}/api/v1/sessions`]: { body: { sessions: [] } } } });
    await app.waitFor("id:team-composer");
    expect(app.shows("id:open-settings")).toBe(false); // no settings rows in the sidebar any more
    expect(app.shows("id:toggle-lang")).toBe(false);
    await app.keyboard.press("mod+,");
    await app.waitFor("id:settings");
    expect(app.shows("id:team-composer")).toBe(false);
    expect(app.shows("id:profile-name")).toBe(true);
    await app.press("id:settings-back");
    await app.waitFor("id:team-composer");
    await app.press("id:user-menu");
    await app.press("id:menu-agents");
    await app.waitFor("id:agent-detail-acha");
  });

  test("adding a machine gives one command; the computer names itself and can be renamed; or a token by hand; an agent's dispatch scope and confirmation change", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 900, network: server(log) });
    await settings(app, "machines");
    await app.press("id:machine-add");
    await app.waitFor("id:machine-command");
    expect(app.shows(`text:curl -fsSL ${URL}/api/v1/install.sh | bash -s -- ${URL} te_first`)).toBe(true);
    expect(app.shows("id:machine-name")).toBe(false); // nothing to name: the computer reports in by itself
    expect(app.shows("id:machine-loopback")).toBe(false);
    await app.press("id:machine-rename-m_1");
    await app.clear("id:machine-rename-input-m_1");
    await app.type("id:machine-rename-input-m_1", "张伟的 MacBook");
    await app.press("id:machine-rename-save-m_1");
    await app.waitUntil(() => log.patches.length === 1);
    expect(log.patches[0]).toEqual({ machine: { name: "张伟的 MacBook" } });
    await app.waitFor("text:张伟的 MacBook");
    log.patches.length = 0;
    await app.press("id:machine-manual");
    await app.type("id:machine-name", "构建机");
    await app.press("id:machine-create");
    await app.waitFor("id:machine-token");
    expect(log.created).toEqual([{ name: "构建机" }]);
    expect(app.shows(`text:/token = "tam_abab/`)).toBe(true);
    expect(app.shows(`text:/url = "${URL}"/`)).toBe(true);
    await app.press("id:machine-join-m_2"); // offline: a command that reconnects it
    await app.waitFor(`text:/tj_again$/`);
    expect(app.shows("text:/new token/")).toBe(true);
    await app.press("id:settings-nav-agents");
    expect(app.shows("text:Members of its channels")).toBe(true);
    expect(app.shows("text:Needs my confirmation")).toBe(true);
    await app.press("id:agent-dispatch-acha-team");
    await app.waitUntil(() => log.patches.length === 1);
    expect(log.patches).toEqual([{ dispatch: "team" }]);
    await app.waitFor("text:/joins a channel it isn’t in yet/");
    await app.press("id:agent-dispatch-acha-confirm");
    await app.waitUntil(() => log.patches.length === 2);
    expect(log.patches[1]).toEqual({ confirm: false });
    await app.press("id:agent-dispatch-acha-owner");
    await app.waitUntil(() => log.patches.length === 3);
    expect(app.shows("id:agent-dispatch-acha-confirm")).toBe(false); // only the owner: nobody else to confirm
  });

  test("an agent's model: the runtime's default, one its machine reported, or another name; a new runtime resets it", async () => {
    const log = newLog();
    const reported = { ...mac, runtime_info: [{ name: "codex", version: "0.46.0", installed: true, logged_in: true, models: ["gpt-6-luna"] },
      { name: "claude", version: "2.1.0", installed: true, logged_in: true, models: ["opus", "sonnet", "haiku"] }] };
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 900, network: { ...server(log), [`GET ${URL}/api/v1/machines`]: { body: { machines: [reported] } } } });
    await settings(app, "agents");
    await app.waitFor("id:agent-model-acha-default");
    expect(app.shows("id:agent-model-acha-gpt-6-luna")).toBe(true);
    await app.press("id:agent-model-acha-gpt-6-luna");
    await app.waitUntil(() => log.patches.length === 1);
    expect(log.patches[0]).toEqual({ model: "gpt-6-luna" });
    await app.type("id:agent-model-acha-input", "gpt-6-luna-mini");
    await app.press("id:agent-model-acha-use");
    await app.waitUntil(() => log.patches.length === 2);
    expect(log.patches[1]).toEqual({ model: "gpt-6-luna-mini" });
    expect(app.enabled("id:agent-runtime-acha-claude")).toBe(true); // Claude Code is in this version
    await app.press("id:agent-runtime-acha-claude");
    await app.waitUntil(() => log.patches.length === 3);
    expect(log.patches[2]).toEqual({ runtime: "claude", model: "" });
  });

  test("a machine shows its runtimes, their login, and the agents on it; removing it says who loses it", async () => {
    const reported = { ...mac, runtime_info: [{ name: "codex", version: "0.46.0", installed: true, logged_in: true }, { name: "claude", version: "1.0.98", installed: true, logged_in: null }] };
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 900, network: { ...server(newLog()), [`GET ${URL}/api/v1/machines`]: { body: { machines: [reported] } } } });
    await settings(app, "machines");
    await app.waitFor("id:machine-m_1-runtime-codex");
    expect(app.shows("text:v0.46.0")).toBe(true);
    expect(app.shows("text:✓ logged in")).toBe(true);
    expect(app.shows("id:machine-m_1-agent-acha")).toBe(true);
    await app.press("id:machine-remove-m_1");
    await app.waitFor("text:/@acha/");
    expect(app.shows("id:machine-remove-confirm-m_1")).toBe(true);
  });

  test("a new agent: a machine first, then a runtime on it and its model, then who can use it", async () => {
    const created: any[] = [];
    const reported = { ...mac, runtime_info: [{ name: "codex", version: "0.46.0", installed: true, logged_in: true },
      { name: "claude", version: "2.1.0", installed: true, logged_in: true, models: ["opus", "sonnet"] }] };
    const app = await open("./App.tsx", {
      storage: SESSION, width: 1200, height: 900,
      network: {
        ...server(newLog()),
        [`GET ${URL}/api/v1/machines`]: { body: { machines: [reported] } },
        [`POST ${URL}/api/v1/agents`]: (r: { body?: string | null }) => {
          const b = JSON.parse(r.body!);
          created.push(b);
          return { body: { ...acha, ...b, id: "a_9" } };
        },
      },
    });
    await settings(app, "agents");
    await app.press("id:agent-add");
    await app.waitFor("id:new-agent");
    expect(app.shows("text:/Installed v0.46.0, logged in/")).toBe(true);
    expect(app.enabled("id:new-agent-runtime-pi")).toBe(false); // not installed there
    expect(app.shows("text:Not installed on 张伟的 Mac")).toBe(true);
    await app.press("id:new-agent-runtime-claude");
    await app.press("id:new-agent-model-sonnet");
    await app.press("id:new-agent-dispatch-team");
    await app.press("id:new-agent-dispatch-confirm");
    await app.type("id:agent-name", "阿测");
    await app.type("id:agent-handle", "ace");
    await app.type("id:agent-desc", "补测试");
    await app.type("id:agent-repo-new", "~/work/pay");
    expect(app.shows("text:阿测 · Claude Code sonnet · 张伟的 Mac")).toBe(true);
    await app.press("id:agent-create");
    await app.waitUntil(() => created.length === 1);
    expect(created[0]).toEqual({ handle: "ace", name: "阿测", description: "补测试", machine_id: "m_1", runtime: "claude", model: "sonnet", repo: "~/work/pay", dispatch: "team", confirm: false });
    await app.waitFor("id:agent-detail-ace");
  });

  test("an admin invites someone and gets the link to send", async () => {
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 900, network: server(newLog()) });
    await settings(app, "people");
    await app.type("id:invite-email", "new@corp.com");
    await app.press("id:invite-create");
    await app.waitFor("id:invite-url");
    expect(app.shows(`text:${URL}/invite/INVITECODE123`)).toBe(true);
  });

  test("people asking to join wait in 待你决定 and in 成员与邀请; an admin lets them in or rejects them", async () => {
    const decided: string[] = [];
    const li = { id: "s_1", email: "li@corp.com", handle: "lina", name: "李娜", note: "支付组新人", state: "pending", created: T0 };
    const zz = { id: "s_2", email: "zz@corp.com", handle: "zz", name: "赵", note: "", state: "pending", created: T0 };
    const app = await open("./App.tsx", {
      storage: SESSION, width: 1200, height: 900,
      network: {
        ...server(newLog()),
        [`GET ${URL}/api/v1/inbox`]: { body: { tasks: [], signups: [li, zz] } },
        [`POST ${URL}/api/v1/signups/s_1/approve`]: () => { decided.push("s_1 approve"); return { body: { user: { id: "u_3", email: li.email, handle: "lina", name: "李娜", role: "member", disabled: false } } }; },
        [`POST ${URL}/api/v1/signups/s_2/reject`]: () => { decided.push("s_2 reject"); return { body: { ok: true } }; },
      },
    });
    await app.waitFor("id:team-composer");
    await app.press("id:open-inbox");
    await app.waitFor("id:signup-lina");
    expect(app.shows("text:支付组新人")).toBe(true);
    await app.press("id:signup-zz-reject");
    await app.waitUntil(() => !app.shows("id:signup-zz"));
    await settings(app, "people");
    await app.waitFor("id:signup-lina");
    await app.press("id:signup-lina-approve");
    await app.waitFor("id:person-lina");
    await app.waitUntil(() => !app.shows("id:signup-lina"));
    expect(app.shows("id:signup-lina")).toBe(false);
    expect(decided).toEqual(["s_2 reject", "s_1 approve"]);
  });

  test("the team's id shows; an admin renames it and closes asking to join", async () => {
    const patches: any[] = [];
    const app = await open("./App.tsx", {
      storage: SESSION, width: 1200, height: 900,
      network: {
        ...server(newLog()),
        [`GET ${URL}/api/v1/me`]: { body: { user: zw, machines: [mac], agents: [acha], workspace: { id: "w_7f3a", name: "", signup: true } } },
        [`PATCH ${URL}/api/v1/workspace`]: (r: { body?: string | null }) => {
          const b = JSON.parse(r.body!);
          patches.push(b);
          return { body: { id: "w_7f3a", name: b.name ?? "支付团队", signup: b.signup ?? true } };
        },
      },
    });
    await settings(app, "people");
    await app.waitFor("id:workspace-id");
    expect(app.shows("text:/w_7f3a/")).toBe(true);
    await app.type("id:workspace-name", "支付团队");
    await app.press("id:workspace-save");
    await app.press("id:workspace-signup");
    await app.waitUntil(() => patches.length === 2);
    expect(patches).toEqual([{ name: "支付团队" }, { signup: false }]);
  });

  test("a login code for another device; signed-in devices; an admin makes a login link for a member", async () => {
    const made: any[] = [];
    const removed: string[] = [];
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
        [`GET ${URL}/api/v1/sessions`]: { body: { sessions: [
          { id: "aaaaaaaaaaaaaaaa", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120", created: T0, last_seen: T0, current: true },
          { id: "bbbbbbbbbbbbbbbb", ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604", created: T0, last_seen: T0, current: false },
        ] } },
        [`DELETE ${URL}/api/v1/sessions/bbbbbbbbbbbbbbbb`]: () => { removed.push("b"); return { body: { ok: true } }; },
      },
    });
    await app.press("id:user-menu");
    await app.press("id:menu-login-code");
    await app.press("id:login-code-create");
    await app.waitFor("id:login-code");
    expect(app.shows("text:ABCD-EFGH")).toBe(true);
    expect(app.shows(`text:${URL}/login/ABCD-EFGH`)).toBe(true);
    expect(app.shows("text:This device")).toBe(true);
    expect(app.shows("id:device-remove-aaaaaaaaaaaaaaaa")).toBe(false);
    await app.press("id:device-remove-bbbbbbbbbbbbbbbb");
    await app.waitUntil(() => removed.length === 1);
    await app.waitUntil(() => !app.shows("id:device-bbbbbbbbbbbbbbbb"));
    await app.press("id:settings-nav-people");
    expect(app.shows("id:login-link-zhangwei")).toBe(false); // not for yourself
    await app.press("id:login-link-wanglei");
    await app.waitFor(`text:${URL}/login/MEMB-ER22`);
    expect(made).toEqual([{}, { user_id: "u_2" }]);
  });

  test("links and install commands use the server's public address, not the one this device connects through", async () => {
    const PUB = "http://remi.corp:8080";
    const app = await open("./App.tsx", {
      storage: SESSION, width: 1200, height: 900,
      network: {
        ...server(newLog()),
        [`GET ${URL}/api/v1/me`]: { body: { user: zw, machines: [mac], agents: [acha], public_url: `${PUB}/` } },
        [`POST ${URL}/api/v1/login-codes`]: { body: { code: "ABCD-EFGH", path: "/login/ABCD-EFGH", expires: Date.now() + 900_000 } },
      },
    });
    await app.press("id:user-menu");
    await app.press("id:menu-login-code");
    await app.waitFor("id:server-url");
    expect(app.shows(`text:${PUB}`)).toBe(true);
    expect(app.shows("id:server-connected")).toBe(true);
    expect(app.shows("id:server-loopback")).toBe(false);
    await app.press("id:login-code-create");
    await app.waitFor(`text:${PUB}/login/ABCD-EFGH`);
    await app.press("id:settings-nav-machines");
    await app.press("id:machine-add");
    await app.waitFor(`text:curl -fsSL ${PUB}/api/v1/install.sh | bash -s -- ${PUB} te_first`);
  });

  test("a loopback address in links warns how to set the public one", async () => {
    const app = await open("./App.tsx", {
      storage: SESSION, width: 1200, height: 900,
      network: { ...server(newLog()), [`GET ${URL}/api/v1/me`]: { body: { user: zw, machines: [mac], agents: [acha], public_url: "http://127.0.0.1:18080" } } },
    });
    await app.press("id:user-menu");
    await app.press("id:menu-login-code");
    await app.waitFor("id:server-loopback");
    expect(app.shows("text:/-public-url/")).toBe(true);
  });

  test("协作数据: the three numbers, and which agents people go to", async () => {
    const asked: string[] = [];
    const base = server(newLog());
    const app = await open("./App.tsx", {
      storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 900,
      network: { ...base, [`GET ${URL}/api/v1/metrics?*`]: (r: { url: string }) => { asked.push(r.url.split("?")[1]!); return (base as any)[`GET ${URL}/api/v1/metrics?*`]; } },
    });
    await settings(app, "metrics");
    await app.waitFor("id:metrics-redone");
    expect(app.shows("text:中位 23 分钟 · 90% 在 2.5 小时内 · 共 9 次")).toBe(true);
    expect(app.shows("text:7 个，平均 1.9 轮，中位 2，最多 4")).toBe(true);
    expect(app.shows("text:还有 2 件在等，最久的已经等了 1.5 小时。")).toBe(true);
    expect(app.shows("text:@acha")).toBe(true);
    await app.press("text:最近 30 天");
    await app.waitUntil(() => asked.length === 2);
    expect(asked).toEqual(["days=7", "days=30"]);
  });

  test("Git platforms: an admin adds a GitLab-based platform; its webhook and each machine's credentials show, never a token", async () => {
    const saved: any[] = [];
    const reported = { ...mac, git: [{ provider: "github", host: "github.com", configured: true, user: "zw", via: "gh" }, { provider: "gitlab", host: "code.corp.com", configured: false, user: "", via: "" }] };
    const app = await open("./App.tsx", {
      storage: SESSION, width: 1200, height: 900,
      network: {
        ...server(newLog()),
        [`GET ${URL}/api/v1/machines`]: { body: { machines: [reported] } },
        [`GET ${URL}/api/v1/git`]: { body: { platforms: [], webhook: { path: "/api/v1/hooks/gitlab", secret_set: true }, events: [] } },
        [`PUT ${URL}/api/v1/git/platforms`]: (r: { body?: string | null }) => {
          const b = JSON.parse(r.body!);
          saved.push(b);
          return { body: { platforms: b.platforms.map((p: any) => ({ ...p, api: p.api || `https://${p.host}/api/v4` })) } };
        },
      },
    });
    await settings(app, "git");
    await app.waitFor("id:git-platform-github.com");
    expect(app.shows("text:✓ gh login · zw")).toBe(true);
    await app.press("id:git-platform-add");
    expect(app.texts().some((x) => x.includes("Ant Code"))).toBe(false); // the UI says "GitLab-based", no product names
    await app.type("id:git-host", "code.corp.com");
    await app.press("id:git-platform-save");
    await app.waitFor("id:git-webhook-url");
    expect(saved).toEqual([{ platforms: [{ kind: "gitlab", name: "", host: "code.corp.com", api: "" }] }]);
    expect(app.shows(`text:${URL}/api/v1/hooks/gitlab`)).toBe(true);
    expect(app.shows("text:/Secret set/")).toBe(true);
    expect(app.shows("id:git-cred-m_1-code.corp.com")).toBe(true);
    expect(app.shows("text:not set up")).toBe(true);
  });

  test("the language switches and is kept; sign out forgets the session", async () => {
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: { ...server(newLog()), [`GET ${URL}/api/v1/sessions`]: { body: { sessions: [] } } } });
    await settings(app, "general");
    await app.press("id:lang-zh");
    await app.waitFor("text:返回工作区");
    expect(app.storage()["hub.lang"]).toBe("zh");
    await app.press("id:settings-nav-account");
    await app.press("id:sign-out");
    await app.waitFor("id:team-signin");
    expect(app.storage()["team.session"]).toBe(undefined);
  });

  test("the appearance: system, light, dark or black, kept on the device", async () => {
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(newLog()) });
    await settings(app, "general");
    expect(app.shows("id:appearance-system")).toBe(true);
    await app.press("id:appearance-black");
    await app.waitUntil(() => app.storage()["team.appearance"] === "black");
    await app.press("id:appearance-light");
    await app.waitUntil(() => app.storage()["team.appearance"] === "light");
    await app.press("id:appearance-dark");
    await app.waitUntil(() => app.storage()["team.appearance"] === "dark");
    const again = await open("./App.tsx", { storage: { ...SESSION, "team.appearance": "black" }, width: 1200, height: 800, network: server(newLog()) });
    await settings(again, "general");
    await again.waitFor("id:appearance-black");
  });
});

describe("channel v2", () => {
  test("@ opens a picker of the channel's agents (runtime, state) then people; Enter inserts", async () => {
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(newLog()) });
    await app.waitFor("id:team-composer");
    expect(app.shows("text:/Type @ to pick/")).toBe(false); // no standing hint under the box
    await app.type("id:team-composer", "请 @");
    await app.waitFor("id:mention-picker");
    expect(app.shows("id:mention-acha")).toBe(true);
    expect(app.shows("id:mention-wanglei")).toBe(true);
    expect(app.shows("text:Codex")).toBe(true);
    expect(app.shows("text:/张伟’s agent/")).toBe(true);
    await app.type("id:team-composer", "ac");
    expect(app.shows("id:mention-wanglei")).toBe(false);
    await app.submit("id:team-composer");
    expect(app.value("id:team-composer")).toBe("请 @acha ");
    expect(app.shows("id:mention-picker")).toBe(false);
  });

  test("the line under the box says where the work goes and who confirms", async () => {
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(newLog()) });
    await app.waitFor("id:team-composer");
    await app.type("id:team-composer", "@acha 看下");
    await app.waitFor("text:To 阿查 · Codex · 张伟的 Mac, starts without confirmation"); // the owner's own agent
  });

  test("a team-wide agent from elsewhere is offered in the picker and joins the channel it is called in", async () => {
    const roam = { ...acha, id: "a_2", handle: "roam", name: "游侠", dispatch: "team", confirm: false };
    const net = { ...server(newLog()), [`GET ${URL}/api/v1/agents`]: { body: { agents: [acha, roam] } } };
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: net });
    await app.waitFor("id:team-composer");
    await app.type("id:team-composer", "@ro");
    await app.waitFor("id:mention-roam");
    expect(app.shows("text:/joins this channel when called/")).toBe(true);
    await app.submit("id:team-composer");
    await app.type("id:team-composer", "看下");
    await app.waitFor("text:/To 游侠 · Codex · 张伟的 Mac, starts without confirmation, and it joins this channel/");
  });

  test("an agent that can't take work says why: its runtime isn't logged in", async () => {
    const out = { ...mac, runtime_info: [{ name: "codex", version: "0.46.0", installed: true, logged_in: false }] };
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: { ...server(newLog()), [`GET ${URL}/api/v1/machines`]: { body: { machines: [out] } } } });
    await app.waitFor("id:side-agent-acha-state");
    expect(app.shows("text:/Codex isn’t logged in on 张伟的 Mac/")).toBe(true);
  });

  test("the header counts people and agents; the members panel groups agents by owner and adds members", async () => {
    const added: any[] = [];
    const app = await open("./App.tsx", {
      storage: SESSION, width: 1200, height: 800,
      network: { ...server(newLog()), [`POST ${URL}/api/v1/channels/c_1/members`]: (r: { body?: string | null }) => { added.push(JSON.parse(r.body!)); return { body: pay }; } },
    });
    await app.waitFor("text:2 people · 1 agents");
    await app.press("id:channel-members");
    await app.waitFor("id:members");
    expect(app.shows("text:张伟’s agents")).toBe(true);
    expect(app.shows("id:member-acha")).toBe(true);
    expect(app.shows("id:member-wanglei")).toBe(true);
    await app.press("id:close-members");
    expect(app.shows("id:members")).toBe(false);
  });

  test("a task's thread shows its facts on top, its run log, and that replies go to its session", async () => {
    const t = task({ created_by: "u_1", state: "running", step: "运行 bun test", runs: 1, pr: { provider: "gitlab", url: "https://code.corp/pay/-/merge_requests/3", number: 3, state: "open", checks: "pending" } });
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(newLog(), {}, [t]) });
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("id:task-T-0001-facts");
    expect(app.shows("text:/· T-0001$/")).toBe(true); // "#channel · T-0001" above its title
    expect(app.shows("text:/^(\\d+ h )?\\d+ min$/")).toBe(true); // how long it has run
    expect(app.shows("text:@acha (张伟’s agent)")).toBe(true);
    expect(app.shows("text:PR #3 · checks running")).toBe(true);
    expect(app.shows("text:/^Goes straight to/")).toBe(false); // no standing hint under the box
    expect(app.shows("text:/new line/")).toBe(false);
    expect(app.shows("id:task-T-0001-runlog")).toBe(false); // folded
    await app.press("id:task-T-0001-fold-log");
    await app.waitFor("text:Now: 运行 bun test");
  });

  test("a task's facts: its mandate, and acceptance criteria its creator writes", async () => {
    const log = newLog();
    const t = task({ created_by: "u_1", state: "running", confirmed_by: "u_1",
      mandate: { by: "u_2", rule: "channel", confirm: true, autonomy: "assist", branch: "agent/T-0001", runtime: "codex" } });
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(log, {}, [t]) });
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("id:task-T-0001-fold-mandate");
    await app.press("id:task-T-0001-fold-mandate");
    await app.waitFor("id:task-T-0001-mandate");
    expect(app.shows("text:asked by 王磊 · rule: Members of its channels · confirmed by 张伟 · autonomy: Assist · may only push agent/T-0001 and open a PR")).toBe(true);
    await app.press("id:task-T-0001-fold-acceptance");
    await app.waitFor("id:task-T-0001-acceptance");
    expect(app.shows("text:/^None yet: the agent proposes/")).toBe(true);
    await app.press("id:task-T-0001-acceptance-edit");
    await app.type("id:task-T-0001-acceptance-input", "P99 < 200ms");
    await app.press("id:task-T-0001-acceptance-save");
    await app.waitUntil(() => log.acts.includes("T-0001 acceptance"));
    await app.waitFor("text:P99 < 200ms");
  });

  test("where a task runs: a general task until a repository is picked, before it first runs", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(log, {}, [task({ created_by: "u_1", state: "pending" })]) });
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("id:task-T-0001-fold-repo");
    await app.press("id:task-T-0001-fold-repo");
    await app.waitFor("id:task-T-0001-repo");
    expect(app.shows("text:none yet: the agent checks one out if the work needs it")).toBe(true);
    expect(app.shows("text:/^Branch/")).toBe(false); // no repository, no branch
    await app.press("id:task-T-0001-repo-edit");
    await app.waitFor("id:task-T-0001-repo-picker-pay");
    expect(app.shows("text:code.corp.com/fin/ledger")).toBe(true);
    await app.press("id:task-T-0001-repo-picker-pay");
    await app.waitUntil(() => log.acts.includes("T-0001 repo github.com/acme/pay"));
    await app.waitFor("id:task-T-0001-repo-label");
    expect(app.shows("text:acme/pay")).toBe(true);
  });

  test("a task's outputs: its PR, a file to preview and download, an outside result", async () => {
    const outputs = [
      { id: "T-0001-pr", kind: "pr", title: "orders: 加索引", status: "open", url: "https://github.com/acme/pay/pull/3", note: "success", updated: T0 },
      { id: "o_1", kind: "file", title: "report.md", name: "report.md", mime: "text/markdown; charset=utf-8", size: 2048, version: 2, status: "ready", updated: T0 },
      { id: "o_2", kind: "external", title: "底座模型", service: "3D 云", external_id: "job-1", status: "pending", note: "排队中", url: "https://3d.example.com/m/1", updated: T0 },
    ];
    const links: string[] = [];
    const app = await open("./App.tsx", {
      storage: SESSION, width: 1200, height: 900,
      network: {
        ...server(newLog(), {}, [task({ created_by: "u_1", state: "review", runs: 1, outputs })]),
        [`GET ${URL}/api/v1/outputs/o_1/link`]: () => { links.push("o_1"); return { body: { url: "/api/v1/outputs/o_1/content?v=0&exp=1&sig=x" } }; },
        [`GET ${URL}/api/v1/outputs/o_1/content?*`]: { body: "# 复盘\n第二版" },
      },
    });
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("id:output-o_1");
    expect(app.shows("text:orders: 加索引")).toBe(true);
    expect(app.shows("text:checks passed")).toBe(true);
    expect(app.shows("text:v2 · 2.0 KB")).toBe(true);
    expect(app.shows("text:/3D 云/")).toBe(false); // two show; the rest behind "All 3 outputs"
    await app.press("id:task-T-0001-outputs-all");
    expect(app.shows("text:3D 云 · in progress · 排队中")).toBe(true);
    expect(app.shows("id:output-o_2-preview")).toBe(false); // no preview picture yet
    await app.press("id:output-o_1-preview");
    await app.waitFor("id:output-o_1-text");
    expect(app.shows("text:/第二版/")).toBe(true);
    expect(links).toEqual(["o_1"]);
  });

  test("a waiting task says what it waits for, how sure its result is, and sits apart from what waits for you", async () => {
    const wait = { how: "poll", every: 90, expect: T0 + 3_600_000, deadline: T0 + 7_200_000, since: T0, checked: T0 + 60_000, checks: 2, note: "排队第 3 位", what: "3D 云渲染底座模型" };
    const outputs = [{ id: "o_2", kind: "external", title: "底座模型", service: "3D 云", external_id: "job-1", status: "pending", updated: T0 }];
    const app = await open("./App.tsx", {
      storage: SESSION, width: 1200, height: 900,
      network: server(newLog(), {}, [task({ created_by: "u_1", state: "waiting", runs: 1, wait, result: "unconfirmed", outputs })]),
    });
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("id:task-T-0001-wait");
    expect(app.shows("text:In progress")).toBe(true); // waiting is in progress; what for is on its second line
    expect(app.shows("text:3D 云渲染底座模型 · checked now and then")).toBe(true);
    expect(app.shows("text:/^checked 2×/")).toBe(true);
    expect(app.shows("text:排队第 3 位")).toBe(true);
    expect(app.shows("text:submitted, result not confirmed")).toBe(true);
    expect(app.shows("text:outside 1/3")).toBe(true);
    await app.press("id:open-inbox");
    await app.waitFor("id:inbox-waiting");
    expect(app.shows("id:inbox-empty")).toBe(true); // nothing for you to do
    expect(app.shows("id:task-T-0001-cancel")).toBe(true);
  });

  test("an agent's question to you: on its card, in 待你决定, answered by replying in the thread", async () => {
    const asked = [{ user: "u_1", question: "版本号用 3.2 还是 4.0？", message: "msg_9", at: T0 }, { user: "u_2", question: "早答过了", message: "msg_8", at: T0, answered: T0 + 1 }];
    const t1 = task({ created_by: "u_2", state: "running", runs: 1, tracked: false, asked });
    const app = await open("./App.tsx", {
      storage: SESSION, width: 1200, height: 900,
      network: { ...server(newLog(), {}, [t1]), [`GET ${URL}/api/v1/inbox`]: { body: { tasks: [t1] } } },
    });
    await app.press("id:open-inbox");
    await app.waitFor("id:task-T-0001-asked-u_1");
    expect(app.shows("text:@acha asks you")).toBe(true);
    expect(app.shows("text:版本号用 3.2 还是 4.0？")).toBe(true);
    expect(app.shows("text:Reply in the thread; it keeps working meanwhile.")).toBe(true);
    expect(app.shows("text:早答过了")).toBe(false); // answered ones are gone
    expect(app.shows("id:inbox-empty")).toBe(false);
  });

  test("a task that already ran keeps its repository", async () => {
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(newLog(), {}, [task({ created_by: "u_1", state: "review", runs: 1, repo: "github.com/acme/pay" })]) });
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("id:task-T-0001-fold-repo");
    await app.press("id:task-T-0001-fold-repo");
    await app.waitFor("id:task-T-0001-repo");
    expect(app.shows("text:acme/pay")).toBe(true);
    expect(app.shows("id:task-T-0001-repo-edit")).toBe(false);
  });

  test("a channel's usual repository (a hint for agents) is set from its members panel", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(log) });
    await app.waitFor("id:channel-members");
    await app.press("id:channel-members");
    await app.waitFor("id:channel-repo");
    expect(app.shows("text:/^None: agents pick a repository/")).toBe(true);
    await app.press("id:channel-repo-edit");
    await app.type("id:channel-repo-picker-input", "https://github.com/acme/web");
    await app.press("id:channel-repo-picker-save");
    await app.waitUntil(() => log.patches.length === 1);
    expect(log.patches[0]).toEqual({ channel: { repo: "https://github.com/acme/web" } });
    await app.waitFor("id:channel-repo-label");
    expect(app.shows("text:acme/web")).toBe(true);
  });
});

describe("tasks", () => {
  test("an @agent's task shows on its message; the owner starts it; it waits for the machine", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(log, {}, [task({})]) });
    await app.waitFor("id:task-T-0001");
    expect(app.shows("text:To do")).toBe(true);
    expect(app.shows("text:Waits for your OK")).toBe(true); // I own @acha
    await app.press("id:task-T-0001-confirm");
    await app.waitFor("text:In progress");
    expect(app.shows("id:task-T-0001-needs")).toBe(false);
    expect(log.acts).toEqual(["T-0001 confirm"]);
    expect(app.shows("text:/张伟的 Mac will pick it up/")).toBe(true);
    expect(app.shows("id:task-T-0001-confirm")).toBe(false);
  });

  test("a decision card: the recommended option is marked, a press answers it", async () => {
    const log = newLog();
    const t = task({ created_by: "u_1", state: "needs_decision", decision: { question: "现在上线吗？", options: ["A: 现在上", "B: 夜里再上"], recommendation: "B" } });
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(log, {}, [t]) });
    await app.waitFor("text:现在上线吗？");
    expect(app.shows("text:Waits for your decision")).toBe(true);
    await app.press("id:task-T-0001-option-1");
    await app.waitFor("text:In progress");
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

  test("five statuses: a blocked run is in progress with a mark; people may call it done, and reopen it", async () => {
    const log = newLog();
    const t = task({ created_by: "u_1", state: "blocked", summary: "没有数据库权限" });
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(log, {}, [t]) });
    await app.waitFor("id:task-T-0001-needs");
    expect(app.shows("text:In progress")).toBe(true);
    expect(app.shows("text:Blocked")).toBe(true);
    await app.press("id:task-T-0001-done");
    await app.waitFor("text:Done");
    await app.press("id:task-T-0001-reopen");
    await app.waitFor("text:In progress");
    expect(log.acts).toEqual(["T-0001 accept", "T-0001 reopen"]);
  });

  test("a question the agent only answered is no task card; its asker may convert it", async () => {
    const log = newLog();
    const t = task({ created_by: "u_1", state: "done", tracked: false, summary: "有两个索引" });
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(log, {}, [t]) });
    await app.waitFor("id:track-T-0001");
    expect(app.shows("id:task-T-0001")).toBe(false);
    await app.press("id:track-T-0001");
    await app.waitFor("id:task-T-0001");
    expect(log.acts).toEqual(["T-0001 track"]);
  });

  test("an untracked request that needs a person still shows its card", async () => {
    const t = task({ created_by: "u_1", state: "pending", tracked: false });
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(newLog(), {}, [t]) });
    await app.waitFor("id:task-T-0001-needs");
  });

  test("a channel's Tasks tab: a board by status, or a list; a press opens the task's thread", async () => {
    const ts = [
      task({ id: "T-0001", state: "running", tracked: true }),
      task({ id: "T-0002", thread_id: "msg_1", state: "blocked", tracked: true, title: "加索引" }),
      task({ id: "T-0003", state: "review", tracked: true, title: "写周报" }),
      task({ id: "T-0004", state: "done", tracked: false, title: "问个问题" }),
    ];
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(newLog(), {}, ts) });
    await app.waitFor("id:channel-tab-tasks");
    await app.press("id:channel-tab-tasks");
    await app.waitFor("id:tasks-board");
    const count = (label: string) => { const xs = app.texts(); return xs[xs.lastIndexOf(label) + 1]; };
    expect(count("In progress")).toBe("2");
    expect(count("In review")).toBe("1");
    expect(count("Done")).toBe("0"); // an answer is no task
    expect(app.shows("id:taskrow-T-0004")).toBe(false);
    await app.press("id:tasks-layout-list");
    await app.waitFor("id:tasks-list");
    expect(app.shows("text:Blocked")).toBe(true);
    await app.press("id:taskrow-T-0002");
    await app.waitFor("id:close-thread");
  });

  test("the Tasks page shows what concerns me first; views and filters narrow it", async () => {
    const ts = [
      task({ id: "T-0001", state: "running", tracked: true, created_by: "u_1" }),
      task({ id: "T-0002", state: "review", tracked: true, created_by: "u_2", agent_id: "a_9" }),
    ];
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(newLog(), {}, ts) });
    await app.waitFor("id:open-tasks");
    await app.press("id:open-tasks");
    await app.waitFor("id:taskrow-T-0001");
    expect(app.shows("id:taskrow-T-0002")).toBe(false); // someone else's, for someone else's agent
    expect(app.shows("text:/· T-0001$/")).toBe(true); // "#channel · T-0001"
    await app.press("id:tasks-filter-all");
    await app.waitFor("id:taskrow-T-0002");
    expect(app.shows("text:Waits for 王磊 to accept")).toBe(true);
    await app.press("id:tasks-filter-mine");
    await app.waitUntil(() => !app.shows("id:taskrow-T-0002"));
    expect(app.shows("id:taskrow-T-0001")).toBe(true);
    await app.press("id:tasks-filter-agents");
    await app.waitUntil(() => app.shows("id:taskrow-T-0001") && !app.shows("id:taskrow-T-0002"));
  });

  test("a task whose request named me to take it waits for me, not for its creator", async () => {
    const ts = [task({ id: "T-0003", state: "review", tracked: true, created_by: "u_2", agent_id: "a_9", handler: "u_1" })];
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(newLog(), {}, ts) });
    await app.waitFor("id:open-tasks");
    await app.press("id:open-tasks");
    await app.waitFor("id:taskrow-T-0003"); // it concerns me: it waits for me
    expect(app.shows("text:Waits for your acceptance")).toBe(true);
  });

  test("a finished task's card shows its conclusion in the channel; the agent's 👀 shows it took the message up", async () => {
    const log = newLog();
    const t = task({ created_by: "u_1", state: "done", summary: "7 个开放 PR，其中 6 个草稿。\n\n详情：#145 和 #144 检查失败" });
    const m = msg({ ...m1, reactions: [{ emoji: "👀", author: { kind: "agent", id: "a_1" } }] });
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(log, {
      [`GET ${URL}/api/v1/channels/c_1/messages?*`]: { body: { messages: [m], more: false } },
    }, [t]) });
    await app.waitFor("id:task-T-0001-summary");
    expect(app.shows("text:7 个开放 PR，其中 6 个草稿。")).toBe(true);
    expect(app.shows("text:/#145/")).toBe(false); // only the first paragraph
    expect(app.shows("id:task-T-0001-accept")).toBe(false);
    expect(app.shows("id:msg-msg_1-reaction")).toBe(true);
    expect(app.shows("text:阿查")).toBe(true);
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

  test("an agent's repository is set in Settings › My agents", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 900, network: server(log) });
    await app.press("id:user-menu");
    await app.press("id:menu-agents");
    await app.type("id:agent-repo-acha", "~/work/pay");
    await app.press("id:agent-repo-save-acha");
    await app.waitUntil(() => log.patches.length === 1);
    expect(log.patches).toEqual([{ repo: "~/work/pay" }]);
  });

  test("an agent's memory is edited in Settings › My agents; its machine lists the repositories it has", async () => {
    const log = newLog();
    const withRepos = { ...mac, repos: [{ remote: "github.com/acme/pay", name: "pay" }] };
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 900, network: { ...server(log), [`GET ${URL}/api/v1/machines`]: { body: { machines: [withRepos] } } } });
    await app.press("id:user-menu");
    await app.press("id:menu-agents");
    await app.type("id:agent-memory-acha", "- 支付服务用 make test");
    await app.press("id:agent-memory-save-acha");
    await app.waitUntil(() => log.patches.length === 1);
    expect(log.patches).toEqual([{ memory: "- 支付服务用 make test" }]);
    await app.press("id:settings-nav-machines");
    await app.waitFor("id:machine-m_1-repos");
    expect(app.shows("text:acme/pay")).toBe(true);
  });
});
