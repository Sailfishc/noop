import { describe, expect, open, test } from "nsh/test";
import { URL, SESSION, T0, zw, wl, mac, acha, pay, ops, msg, m1, r1, type Log, task, server, newLog, rem } from "./fixtures";

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

  test("扫码 opens the camera on a phone, and isn't offered on the web", async () => {
    const phone = await open("./App.tsx", { platform: "ios", network: server(newLog()) });
    await phone.waitFor("id:team-signin");
    expect(phone.shows("id:scan-camera")).toBe(false);
    // a phone starts from one 扫码登录; the other ways are a page each, with a way back
    expect(phone.shows("id:team-code")).toBe(false);
    for (const way of ["signin-code", "signin-invite", "signin-ask"]) expect(phone.shows(`id:${way}`)).toBe(true);
    await phone.press("id:signin-invite");
    await phone.waitFor("id:invite-link");
    await phone.press("id:back");
    await phone.waitFor("id:signin-home");
    // headless has no web page to answer the scanner: it falls back to typing the code, saying why
    await phone.press("id:team-scan");
    await phone.waitFor("id:team-code");
    await phone.waitFor("id:scan-camera", { state: "gone" });
    expect(phone.shows("text:/scanner page/")).toBe(true);

    const web = await open("./App.tsx", { platform: "web", width: 1200, height: 800, network: server(newLog()) });
    await web.waitFor("id:team-signin");
    expect(web.shows("id:team-login")).toBe(true);
    expect(web.shows("id:team-scan")).toBe(false);
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

    // the whole link pasted into the server box (the bad case): it still signs in, with the link's code
    const misplaced = await open("./App.tsx", { width: 1200, height: 800, network: net });
    await misplaced.type("id:team-url", `${URL}/login/ABCD-EFGH`);
    await misplaced.press("id:team-login");
    await misplaced.waitFor("id:team-composer");
    expect(misplaced.storage()["team.url"]).toBe(URL);
    expect(logins.at(-1)).toEqual({ code: "ABCD-EFGH" });
  });

  test("a scanned login QR opens the app and signs in; signed in already, it is dropped with a word", async () => {
    const logins: any[] = [];
    const net = {
      ...server(newLog()),
      [`POST ${URL}/api/v1/login`]: (r: { body?: string | null }) => {
        logins.push(JSON.parse(r.body!));
        return { body: { session: "sess", user: zw } };
      },
    };
    const qr = `remi://login?server=${encodeURIComponent(URL)}&code=ABCD-EFGH`;
    const app = await open("./App.tsx", { width: 390, height: 844, network: net, urlScheme: qr });
    await app.waitUntil(() => app.storage()["team.session"] === "sess");
    await app.waitFor("text:支付后端");
    expect(logins).toEqual([{ code: "ABCD-EFGH" }]);
    expect(app.storage()["team.url"]).toBe(URL);

    await app.openWithUrl(`remi://login?server=${encodeURIComponent(URL)}&code=WXYZ-2345`);
    await app.waitFor("text:This device is already signed in. Sign out first to switch accounts.");
    expect(logins.length).toBe(1);

    // a link that isn't a login (or names no http server) is ignored
    const other = await open("./App.tsx", { width: 390, height: 844, network: net, urlScheme: "remi://login?server=javascript%3Aalert(1)&code=ABCD-EFGH" });
    await other.waitFor("id:team-signin");
    await other.wait(50);
    expect(logins.length).toBe(1);
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
    // ⌘K: the palette; what's typed there is searched as its last group
    await app.press("id:open-search");
    await app.waitFor("id:palette");
    await app.type("id:palette-command", "慢查询");
    await app.waitFor("text:Search messages for “慢查询”");
    await app.press("text:Search messages for “慢查询”");
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
    // the system's back (a swipe from the left edge on iOS, back on Android) goes back a page the same way
    await app.press("id:channel-pay");
    await app.waitFor("id:team-composer");
    await app.press("id:thread-msg_1");
    await app.waitFor("收到，在看");
    await app.back();
    await app.waitFor("id:team-composer");
    expect(app.shows("收到，在看")).toBe(false);
    await app.back();
    await app.waitFor("id:channel-ops");
    expect(app.shows("id:tab-chat")).toBe(true);
  });
});

describe("settings", () => {
  const settings = async (app: any, tab: string) => {
    await app.press("id:user-menu");
    await app.press("id:menu-settings");
    await app.waitFor("id:settings");
    await app.press(`id:settings-nav-${tab}`);
  };

  test("「提案什么时候给我」: once a workday by default; twice shows the second time; saved as one's own", async () => {
    const saved: any[] = [];
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 900, network: { ...server(newLog()),
      [`GET ${URL}/api/v1/sessions`]: { body: { sessions: [] } },
      [`PATCH ${URL}/api/v1/users/u_1`]: (r: { body?: string | null }) => { saved.push(JSON.parse(r.body!)); return { body: zw }; } } });
    await app.waitFor("id:team-composer");
    await app.keyboard.press("mod+,");
    await app.waitFor("id:digest-at");
    expect(app.value("id:digest-at")).toBe("09:30");
    expect(app.shows("id:digest-at2")).toBe(false);
    expect(app.enabled("id:digest-save")).toBe(false);
    await app.press("id:digest-every-twice");
    await app.waitFor("id:digest-at2");
    await app.clear("id:digest-at2");
    await app.type("id:digest-at2", "16:00");
    await app.press("id:digest-save");
    await app.waitUntil(() => saved.length === 1);
    expect(saved[0]).toEqual({ digest: { every: "twice", at: "09:30", at2: "16:00", quiet: "22:00-08:00" } });
    await app.waitFor("text:已保存");
  });

  test("「我的偏好」: one's own words for the agents, its explanation behind the ⓘ, saved with a PATCH of oneself", async () => {
    const saved: any[] = [];
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 800, network: { ...server(newLog()),
      [`GET ${URL}/api/v1/sessions`]: { body: { sessions: [] } },
      [`PATCH ${URL}/api/v1/users/u_1`]: (r: { body?: string | null }) => { saved.push(JSON.parse(r.body!)); return { body: zw }; } } });
    await app.waitFor("id:team-composer");
    await app.keyboard.press("mod+,");
    await app.waitFor("id:preferences-input");
    expect(app.value("id:preferences-input")).toBe("回复用中文；PR 描述先写改了什么再写为什么。");
    expect(app.shows("id:preferences-note")).toBe(false);
    await app.press("id:preferences-info");
    await app.waitFor("text:/别写密码和密钥/");
    expect(app.enabled("id:preferences-save")).toBe(false);
    await app.clear("id:preferences-input");
    await app.type("id:preferences-input", "不确定的地方先问我");
    await app.press("id:preferences-save");
    await app.waitUntil(() => saved.length === 1);
    expect(saved[0]).toEqual({ preferences: "不确定的地方先问我" });
    await app.waitFor("text:已保存");
  });

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

  test("an agent on several of one's computers: tick them and put them in order", async () => {
    const saved: any[] = [];
    const desk = { ...mac, id: "m_3", name: "张伟的台式机", runtime_info: [{ name: "codex", installed: true, logged_in: true }] };
    let agent = { ...acha };
    const app = await open("./App.tsx", {
      storage: SESSION, width: 1200, height: 900,
      network: {
        ...server(newLog()),
        [`GET ${URL}/api/v1/machines`]: { body: { machines: [mac, desk] } },
        [`GET ${URL}/api/v1/agents`]: () => ({ body: { agents: [agent] } }),
        [`PATCH ${URL}/api/v1/agents/a_1`]: (r: { body?: string | null }) => {
          const b = JSON.parse(r.body!);
          saved.push(b);
          agent = { ...agent, machines: b.machines, machine_id: b.machines[0] ?? null };
          return { body: agent };
        },
      },
    });
    await settings(app, "agents");
    await app.waitFor("id:agent-acha-machine-m_3-on");
    expect(app.shows("id:agent-acha-machine-m_1-up")).toBe(false); // one computer: nothing to order
    await app.press("id:agent-acha-machine-m_3-on");
    await app.waitUntil(() => saved.length === 1);
    expect(saved[0]).toEqual({ machines: ["m_1", "m_3"] });
    await app.waitFor("id:agent-acha-machine-m_3-up");
    await app.press("id:agent-acha-machine-m_3-up");
    await app.waitUntil(() => saved.length === 2);
    expect(saved[1]).toEqual({ machines: ["m_3", "m_1"] });
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
    await app.scroll("id:new-agent-dispatch-team", 300); // the dialog's last step sits under its footer until scrolled to
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
    expect(app.shows("id:login-code-qr")).toBe(true);
    expect(app.shows("id:login-code-server")).toBe(true);
    // the link with the code in it is not on screen (people typed it into the server box); it's behind 复制链接
    expect(app.shows(`text:${URL}/login/ABCD-EFGH`)).toBe(false);
    await app.press("id:login-code-copy-link");
    expect(app.clipboard()).toBe(`${URL}/login/ABCD-EFGH`);
    await app.press("id:login-code-copy");
    expect(app.clipboard()).toBe("ABCD-EFGH");
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
    await app.waitFor("id:login-code-qr");
    await app.press("id:login-code-copy-link");
    expect(app.clipboard()).toBe(`${PUB}/login/ABCD-EFGH`);
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
    expect(app.shows("text:/OTHER AGENTS · JOIN WHEN CALLED/")).toBe(true);
    expect(app.shows("text:/AGENTS · THIS CHANNEL/")).toBe(false); // it isn't in this one
    await app.submit("id:team-composer");
    await app.type("id:team-composer", "看下");
    await app.waitFor("text:/To 游侠 · Codex · 张伟的 Mac, starts without confirmation, and it joins this channel/");
  });

  test("the picker offers only the channel's people: an @ never reaches someone outside it", async () => {
    const lin = { ...wl, id: "u_3", handle: "linfang", name: "林芳", email: "lf@example.com" };
    const net = { ...server(newLog()), [`GET ${URL}/api/v1/users`]: { body: { users: [zw, wl, lin] } } };
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: net });
    await app.waitFor("id:team-composer");
    await app.type("id:team-composer", "@");
    await app.waitFor("id:mention-wanglei"); // in #支付后端
    expect(app.shows("id:mention-linfang")).toBe(false); // not in it
    expect(app.shows("text:/not in this channel/")).toBe(false);
  });

  test("an agent that can't take work says why: its runtime isn't logged in", async () => {
    const out = { ...mac, runtime_info: [{ name: "codex", version: "0.46.0", installed: true, logged_in: false }] };
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: { ...server(newLog()), [`GET ${URL}/api/v1/machines`]: { body: { machines: [out] } } } });
    await app.waitFor("id:side-agent-acha-state");
    expect(app.shows("text:/Stuck/")).toBe(true); // the sidebar has the word; the members panel says why
    await app.press("id:channel-members");
    await app.waitFor("id:member-acha-state");
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
    expect(app.shows("text:none yet: the agent checks one out to read or change code")).toBe(true);
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
    expect(app.shows("id:channel-repo-label") && app.shows("text:None")).toBe(true);
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

describe("team ownership", () => {
  const settings = async (app: any, tab: string) => {
    await app.press("id:user-menu");
    await app.press("id:menu-settings");
    await app.waitFor("id:settings");
    await app.press(`id:settings-nav-${tab}`);
  };

  test("an admin makes a machine a team machine; its card shows its Git identity, skills, MCP and the team config sync", async () => {
    const log = newLog();
    const box = { ...mac, git: [{ provider: "gitlab", host: "code.corp.com", configured: true, user: "remi-bot", via: "token" }], skills: ["release-notes"], mcp: ["jira"],
      team_config: { repo: "git@code.corp.com:team/remi-config.git", commit: "abc1234", synced: T0, instructions: true, error: "MCP wiki：这台机器没有 WIKI_TOKEN" } };
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 900, network: { ...server(log), [`GET ${URL}/api/v1/machines`]: { body: { machines: [box] } } } });
    await settings(app, "machines");
    await app.waitFor("id:machine-m_1-git");
    expect(app.shows("text:code.corp.com · remi-bot")).toBe(true);
    expect(app.shows("text:release-notes")).toBe(true);
    expect(app.shows("text:MCP jira")).toBe(true);
    expect(app.shows("text:/团队配置 abc1234/")).toBe(true);
    expect(app.shows("text:/没有 WIKI_TOKEN/")).toBe(true);
    expect(app.shows("text:/团队配置仓库默认不同步到这里/")).toBe(true);
    await app.press("id:machine-syncconfig-m_1");
    await app.waitUntil(() => log.patches.length === 1);
    expect(log.patches[0]).toEqual({ machine: { sync_team_config: true } });
    await app.waitFor("text:停止同步");
    await app.press("id:machine-team-m_1");
    await app.waitUntil(() => log.patches.length === 2);
    expect(log.patches[1]).toEqual({ machine: { team: true } });
    await app.waitFor("text:取消团队机器");
    expect(app.shows("text:团队机器")).toBe(true);
    expect(app.shows("id:machine-syncconfig-m_1")).toBe(false);
  });

  test("a team agent: any admin changes it, and picks its responsible person", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 900,
      network: { ...server(log), [`GET ${URL}/api/v1/machines`]: { body: { machines: [{ ...mac, team: true }] } } } });
    await app.press("id:user-menu");
    await app.press("id:menu-agents");
    await app.waitFor("id:agent-owner-acha-u_2");
    expect(app.shows("text:/跑在团队机器 张伟的 Mac 上/")).toBe(true);
    await app.press("id:agent-owner-acha-u_2");
    await app.waitUntil(() => log.patches.length === 1);
    expect(log.patches[0]).toEqual({ owner_id: "u_2" });
  });

  test("团队配置: an admin names the repository; what goes in it; how each machine synced", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 900, network: server(log) });
    await settings(app, "teamconfig");
    await app.waitFor("id:teamconfig-repo");
    expect(app.shows("text:AGENTS.md")).toBe(true);
    expect(app.shows("text:/还没同步|—/")).toBe(true);
    await app.type("id:teamconfig-repo", "git@code.corp.com:team/remi-config.git");
    await app.press("id:teamconfig-save");
    await app.waitUntil(() => log.patches.length === 1);
    expect(log.patches[0]).toEqual({ team_config: { repo: "git@code.corp.com:team/remi-config.git" } });
  });

  test("a channel's conventions are written in its members panel", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(log) });
    await app.waitFor("id:channel-members");
    await app.press("id:channel-members");
    await app.waitFor("id:channel-conventions");
    // a box that opens the editor when pressed (an always-open multiline input took no clicks on the Mac)
    expect(app.shows("id:channel-conventions-input")).toBe(false);
    expect(app.shows("id:channel-conventions-save")).toBe(false);
    // what it is for stays behind the ⓘ until asked
    expect(app.shows("text:Every agent working in this channel reads this with its task.")).toBe(false);
    await app.press("id:channel-conventions-head-info");
    expect(app.shows("id:channel-conventions-head-note")).toBe(true);
    // on a touch screen the note is a sheet from the bottom; back (or the backdrop, or a swipe) closes it
    await app.back();
    await app.waitFor("id:channel-conventions-head-note", { state: "gone" });
    await app.press("id:channel-conventions-box");
    await app.waitFor("id:channel-conventions-input");
    await app.press("id:channel-conventions-cancel");
    expect(app.shows("id:channel-conventions-input")).toBe(false);
    await app.press("id:channel-conventions-box");
    await app.type("id:channel-conventions-input", "PR 标题用中文");
    await app.press("id:channel-conventions-save");
    await app.waitUntil(() => log.patches.length === 1);
    expect(log.patches[0]).toEqual({ channel: { conventions: "PR 标题用中文" } });
    await app.waitFor("id:channel-conventions-text");
    expect(app.shows("id:channel-conventions-input")).toBe(false);
    expect(app.shows("text:PR 标题用中文")).toBe(true);
  });

  test("someone in the channel takes over a task whose asker is away", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 800,
      network: server(log, {}, [task({ created_by: "u_2", state: "running", runs: 1, tracked: true })]) });
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("id:task-T-0001-takeover");
    await app.press("id:task-T-0001-takeover");
    await app.waitUntil(() => log.acts.includes("T-0001 takeover"));
    await app.waitFor("id:task-T-0001-takeover-note");
    expect(app.shows("text:/张伟 在 .* 从 王磊 手里接手/")).toBe(true);
    expect(app.shows("id:task-T-0001-takeover")).toBe(false);
  });

  test("someone asked to take over a task of an agent that needs its owner's yes: the owner says yes", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 800,
      network: server(log, {}, [task({ created_by: "u_1", state: "running", runs: 1, tracked: true,
        mandate: { by: "u_1", takeovers: [{ from: "u_1", to: "u_2", at: T0, pending: true }] } })]) });
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("id:task-T-0001-takeover-approve");
    expect(app.shows("text:/王磊 在 .* 想接手，等 @.* 同意/")).toBe(true);
    await app.press("id:task-T-0001-takeover-approve");
    await app.waitUntil(() => log.acts.includes("T-0001 takeover"));
    await app.waitUntil(() => app.shows("text:/王磊 在 .* 从 张伟 手里接手/"));
    expect(app.shows("id:task-T-0001-takeover-approve")).toBe(false);
  });
});

describe("passing the ball", () => {
  test("an agent's handoff card: the requester hands the work to the other agent; who has the ball shows", async () => {
    const log = newLog();
    const bei = { ...acha, id: "a_2", handle: "bei", name: "贝" };
    const t1 = task({ created_by: "u_1", state: "running", runs: 1, tracked: true, holder: { kind: "user", id: "u_1", why: "handoff_card" },
      handoffs: [{ id: "ho_1", to: "a_2", what: "改完后写发布说明", message: "msg_5", at: T0, state: "proposed" }] });
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 800,
      network: { ...server(log, {}, [t1]), [`GET ${URL}/api/v1/agents`]: { body: { agents: [acha, bei] } } } });
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("id:task-T-0001-holder");
    expect(app.shows("text:球在 你 手里 · 决定要不要交接")).toBe(true);
    expect(app.shows("text:@acha 建议交给 @bei")).toBe(true);
    await app.press("id:task-T-0001-handoff-ho_1-accept >> nth=1");
    await app.waitUntil(() => log.acts.includes("T-0001 handoff"));
    await app.waitFor("text:球在 @acha 手里 · 在做");
    expect(app.shows("id:task-T-0001-handoff-ho_1")).toBe(false);
  });

  test("a handoff card to someone else's agent: only its owner hands it over; the asker may only say no", async () => {
    const log = newLog();
    const bei = { ...acha, id: "a_2", handle: "bei", name: "贝", owner_id: "u_2" };
    const t1 = task({ created_by: "u_1", state: "running", runs: 1, tracked: true, holder: { kind: "user", id: "u_2", why: "handoff_card" },
      handoffs: [{ id: "ho_1", to: "a_2", what: "改完后写发布说明", message: "msg_5", at: T0, state: "proposed" }] });
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 800,
      network: { ...server(log, {}, [t1]), [`GET ${URL}/api/v1/agents`]: { body: { agents: [acha, bei] } } } });
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("id:task-T-0001-holder");
    expect(app.shows("text:球在 王磊 手里 · 决定要不要交接")).toBe(true);
    expect(app.shows("id:task-T-0001-handoff-ho_1-accept")).toBe(false);
    expect(app.shows("id:task-T-0001-handoff-ho_1-decline")).toBe(true);
    expect(app.shows("id:task-T-0001-handoff-ho_1-kind-info")).toBe(true);
  });

  test("a person the agent handed the ball to sees it as theirs", async () => {
    const t1 = task({ created_by: "u_2", state: "running", runs: 1, tracked: true, asked: [{ user: "u_1", question: "在测试环境点一下退款", message: "msg_9", at: T0, kind: "handoff" }] });
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 900,
      network: { ...server(newLog(), {}, [t1]), [`GET ${URL}/api/v1/inbox`]: { body: { tasks: [t1] } } } });
    await app.press("id:open-inbox");
    await app.waitFor("id:task-T-0001-asked-u_1");
    expect(app.shows("text:@acha handed this to you")).toBe(true);
    expect(app.shows("text:Reply in the thread when it’s done; the agent hears it.")).toBe(true);
  });

  test("a channel's triggers: one waits for the owner's yes; a new one is added from the members panel", async () => {
    const log = newLog();
    const waitingOne = { id: "trg_1", channel_id: "c_1", agent_id: "a_1", created_by: "u_2", kind: "schedule", text: "汇总告警", repeat: "weekdays", due: T0, confirmed_by: null, enabled: true, fired: null, fires: 0, created: T0 };
    const stuck = { ...waitingOne, id: "trg_9", confirmed_by: "u_1", fires: 5, fired: T0, max_per_day: 10, skipped: 4, skipped_run: 3, skip_reason: "busy", last_task: "T-0007" };
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 900, network: server(log, { __triggers: [waitingOne, stuck] }) });
    await app.waitFor("id:channel-members");
    await app.press("id:channel-members");
    await app.waitFor("id:trigger-trg_1");
    expect(app.shows("text:等 @zhangwei 确认一次")).toBe(true);
    expect(app.shows("text:已连续跳过 3 次，因为 T-0007 还在排队或运行")).toBe(true);
    expect(app.shows("text:/每天最多 10 次/")).toBe(false); // its limits wait behind the ⓘ
    await app.press("id:trigger-limits-trg_9-info");
    await app.waitFor("text:/每天最多 10 次；上一个任务还在排队或运行时跳过/");
    await app.press("id:trigger-confirm-trg_1");
    await app.waitUntil(() => log.acts.includes("trg_1 confirm"));
    await app.waitFor("text:还没触发过");
    await app.press("id:trigger-add");
    await app.press("id:trigger-kind-pr");
    await app.type("id:trigger-repo", "https://github.com/acme/pay");
    await app.type("id:trigger-text", "review 这个 PR");
    await app.clear("id:trigger-max");
    await app.type("id:trigger-max", "3");
    await app.press("id:trigger-save");
    await app.waitUntil(() => log.created.length === 1);
    expect(log.created[0]).toEqual({ trigger: { channel_id: "c_1", agent: "a_1", kind: "pr", text: "review 这个 PR", repo: "https://github.com/acme/pay", branch: "", max_per_day: 3, readonly: true } });
    await app.waitFor("text:/acme\\/pay 有新 PR/");
    expect(app.shows("id:trigger-readonly-trg_3")).toBe(true); // read-only unless switched off
    await app.press("id:trigger-limits-trg_3-info");
    await app.waitFor("text:每天最多 3 次"); // a PR is never skipped for an open task
  });

  test("a trigger's words and time can be changed", async () => {
    const log = newLog();
    const daily = { id: "trg_1", channel_id: "c_1", agent_id: "a_1", created_by: "u_1", kind: "schedule", text: "汇总告警", repeat: "weekdays", due: T0, confirmed_by: "u_1", enabled: true, fired: T0, fires: 2, created: T0, max_per_day: 10, skipped: 0, readonly: true };
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 900, network: server(log, { __triggers: [daily] }) });
    await app.waitFor("id:channel-members");
    await app.press("id:channel-members");
    await app.press("id:trigger-edit-trg_1");
    await app.press("id:trigger-edit-trg_1-repeat-every");
    await app.clear("id:trigger-edit-trg_1-every");
    await app.type("id:trigger-edit-trg_1-every", "30m");
    await app.clear("id:trigger-edit-trg_1-text");
    await app.type("id:trigger-edit-trg_1-text", "汇总告警和慢查询");
    await app.press("id:trigger-edit-trg_1-save");
    await app.waitUntil(() => log.patches.length === 1);
    expect(log.patches[0]).toEqual({ trigger: "trg_1", text: "汇总告警和慢查询", repeat: "30m", when: "" });
    await app.waitFor("text:汇总告警和慢查询");
    expect(app.shows("id:trigger-edit-trg_1-save")).toBe(false);
  });

  test("a repeating reminder for an agent: on its task card, paused and cancelled there; the ⏰ message stops it; the channel lists it", async () => {
    const log = newLog();
    const r = rem();
    const t1 = task({ id: "T-0001", state: "done", tracked: true, title: "汇报 MR 进展", created_by: "u_1", reminders: [r] });
    const fired = msg({ id: "msg_9", seq: 3, thread_id: "msg_1", author: { kind: "user", id: "u_1" }, text: `⏰ @acha ${r.text}` });
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 900, network: {
      ...server(log, { __reminders: [r] }, [t1]),
      [`GET ${URL}/api/v1/messages/msg_1/thread`]: { body: { root: m1, replies: [r1, fired] } },
    } });
    await app.waitFor("id:reminder-tag-rem_1");
    expect(app.shows("text:/每 10 分钟 · 下次/")).toBe(true); // on the card even when the task is done
    await app.press("id:reminder-tag-rem_1");
    await app.waitFor("text:/自动结束/"); // when it stops by itself, on top of its menu
    await app.press("id:reminder-tag-rem_1-pause");
    await app.waitUntil(() => log.patches.length === 1);
    expect(log.patches[0]).toEqual({ reminder: "rem_1", paused: true });
    await app.waitFor("text:每 10 分钟 · 已暂停");

    await app.press("id:channel-members");
    await app.waitFor("id:temporary-rem_1"); // the channel's 临时 duties
    await app.press("id:channel-members");

    await app.press("id:thread-msg_1");
    await app.waitFor("id:msg-msg_9");
    await app.press("id:remind-msg_9");
    await app.press("id:remind-msg_9-stop");
    await app.waitUntil(() => log.acts.includes("rem_1 cancel"));
  });

  test("a scheduled repeating reminder in 待你决定 can be paused", async () => {
    const log = newLog();
    let list = [rem({ target: { kind: "user", id: "u_1" }, by_agent: null, repeat: "daily", text: "交日报" })];
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 900, network: {
      ...server(log),
      [`GET ${URL}/api/v1/reminders`]: () => ({ body: { reminders: list } }),
      [`PATCH ${URL}/api/v1/reminders/*`]: (q: { body?: string | null }) => { list = [{ ...list[0]!, paused: JSON.parse(q.body!).paused }]; log.patches.push(JSON.parse(q.body!)); return { body: list[0] }; },
    } });
    await app.press("id:open-inbox");
    await app.waitFor("id:reminder-rem_1");
    expect(app.shows("text:/每天 · 下次 .* · .*自动结束/")).toBe(true);
    await app.press("id:reminder-rem_1-pause");
    await app.waitUntil(() => log.patches.length === 1);
    expect(log.patches[0]).toEqual({ paused: true });
    await app.waitFor("text:/每天 · 已暂停/");
    expect(app.shows("text:恢复")).toBe(true);
  });

  test("a duty: its triggers in one group with how the week went, one switch pauses them all, its history", async () => {
    const log = newLog();
    const base = { channel_id: "c_1", agent_id: "a_1", created_by: "u_1", kind: "schedule", repeat: "daily", due: T0, confirmed_by: "u_1", enabled: true, fired: T0, fires: 9, created: T0, max_per_day: 10, skipped: 0, duty: "看住主干", readonly: true };
    const ci = { ...base, id: "trg_1", text: "看主干的 CI", recent: { nochange: 31, nothing: 9 } };
    const deps = { ...base, id: "trg_2", text: "看过期的依赖", recent: { proposed: 2 } };
    const runs = [{ trigger_id: "trg_1", at: T0, outcome: "nothing", note: "主干是绿的", task_id: "T-0009" }, { trigger_id: "trg_2", at: T0 - 3600_000, outcome: "failed", note: "仓库打不开" }];
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 900, network: {
      ...server(log, { __triggers: [ci, deps] }),
      [`GET ${URL}/api/v1/triggers/runs?*`]: (r: { url: string }) => { log.acts.push(decodeURIComponent(r.url.split("?")[1]!)); return { body: { runs } }; },
      [`POST ${URL}/api/v1/triggers/duty`]: (r: { body?: string | null }) => { const b = JSON.parse(r.body!); log.patches.push({ duty: b }); ci.enabled = deps.enabled = b.enabled; return { body: { triggers: [ci, deps] } }; },
    } });
    await app.waitFor("id:channel-members");
    await app.press("id:channel-members");
    await app.waitFor("id:duty-trg_1");
    expect(app.shows("text:看住主干")).toBe(true);
    expect(app.shows("text:近 7 天：31 次没变化，9 次没发现，2 次提了案")).toBe(true);
    expect(app.shows("id:trigger-toggle-trg_1")).toBe(false); // paused as a duty, not one by one
    await app.press("id:duty-trg_1-history");
    await app.waitFor("id:duty-trg_1-runs");
    expect(log.acts).toContain("channel=c_1&agent=a_1&duty=看住主干");
    expect(app.shows("text:/没发现 · 主干是绿的 · T-0009/")).toBe(true);
    expect(app.shows("text:/失败 · 仓库打不开/")).toBe(true);
    await app.press("id:duty-trg_1-toggle");
    await app.waitUntil(() => log.patches.length === 1);
    expect(log.patches[0]).toEqual({ duty: { channel_id: "c_1", agent_id: "a_1", duty: "看住主干", enabled: false } });
    await app.waitFor("text:已暂停");
  });

  test("a check command: shown under what it asks, waits for the owner again when it changed; a schedule can be given one", async () => {
    const log = newLog();
    const changed = { id: "trg_1", channel_id: "c_1", agent_id: "a_1", created_by: "u_2", kind: "schedule", text: "主干 CI 红了就看看", repeat: "weekdays", due: T0, confirmed_by: "u_1", enabled: true, fired: T0, fires: 3, created: T0,
      max_per_day: 10, skipped: 0, readonly: true, check_cmd: "gh run list -b main -s failure -L 5", check_waits: true };
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 900, network: server(log, { __triggers: [changed] }) });
    await app.waitFor("id:channel-members");
    await app.press("id:channel-members");
    await app.waitFor("id:trigger-check-trg_1");
    expect(app.shows("text:$ gh run list -b main -s failure -L 5")).toBe(true);
    expect(app.shows("text:检查命令改了，等 @zhangwei 确认")).toBe(true);
    await app.press("id:trigger-confirm-trg_1");
    await app.waitUntil(() => log.acts.includes("trg_1 confirm gh run list -b main -s failure -L 5")); // the command as shown
    await app.waitFor("text:/触发过 3 次/");
    await app.press("id:trigger-add");
    expect(app.shows("text:/输出和上次一样/")).toBe(false); // what it does waits behind the ⓘ
    await app.press("id:trigger-check-about-info");
    await app.waitFor("text:/输出和上次一样就什么都不做/");
    await app.type("id:trigger-text", "有新告警就看看");
    await app.type("id:trigger-check", "cat alerts.txt");
    await app.press("id:trigger-save");
    await app.waitUntil(() => log.created.length === 1);
    expect(log.created[0]).toEqual({ trigger: { channel_id: "c_1", agent: "a_1", kind: "schedule", text: "有新告警就看看", when: "9:00", repeat: "weekdays", check_cmd: "cat alerts.txt", readonly: true } });
    await app.waitFor("text:$ cat alerts.txt");
  });

  test("a schedule every N minutes: an interval instead of a time, said as 每 10 分钟", async () => {
    const log = newLog();
    const every = { id: "trg_1", channel_id: "c_1", agent_id: "a_1", created_by: "u_1", kind: "schedule", text: "看一下 MR 进展", repeat: "10m", due: T0, confirmed_by: "u_1", enabled: true, fired: T0, fires: 3, created: T0, max_per_day: 144, skipped: 0, readonly: true };
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 900, network: server(log, { __triggers: [every] }) });
    await app.waitFor("id:channel-members");
    await app.press("id:channel-members");
    await app.waitFor("text:/每 10 分钟/");
    await app.press("id:trigger-add");
    await app.press("id:trigger-repeat-every");
    expect(app.shows("id:trigger-when")).toBe(false);
    await app.clear("id:trigger-every");
    await app.type("id:trigger-every", "30m");
    await app.type("id:trigger-text", "看一下 MR 和 CI");
    await app.press("id:trigger-save");
    await app.waitUntil(() => log.created.length === 1);
    expect(log.created[0]).toEqual({ trigger: { channel_id: "c_1", agent: "a_1", kind: "schedule", text: "看一下 MR 和 CI", when: "", repeat: "30m", readonly: true } });
  });
});

describe("proposals", () => {
  const prop = (id: string, num: number, title: string, extra: object = {}) => ({ id, channel_id: "c_1", agent_id: "a_1", task_id: "T-0009", title, why: `看到：${title}`, plan: `做到：${title}`, key: id, urgent: false, state: "open", num, created: T0, ...extra });
  const batch = { id: "pb_1", at: T0, urgent: false, proposals: [prop("p1", 1, "升级 lodash"), prop("p2", 2, "删掉没人管的分支"), prop("p3", 3, "补上 /orders 的测试")] };
  const urgent = { id: "pb_2", at: T0, urgent: true, proposals: [prop("p4", 1, "主干红了，今天发不了版", { urgent: true })] };

  test("one card, numbered; details on demand; 做 or 不做 each; numbers in the box; an urgent one on its own", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 900, network: server(log, { __proposals: [batch, urgent] }) });
    await app.waitFor("id:team-composer");
    await app.press("id:open-inbox");
    await app.waitFor("id:proposals-pb_1");
    expect(app.shows("text:/提案（3）/")).toBe(true);
    expect(app.shows("text:1. 升级 lodash")).toBe(true);
    expect(app.shows("text:/#支付后端 · @acha/")).toBe(true);
    expect(app.shows("text:做到：升级 lodash")).toBe(false); // the plan waits behind 详情
    await app.press("id:proposal-p1-more");
    await app.waitFor("text:打算：做到：升级 lodash");
    expect(app.shows("text:为什么：看到：升级 lodash")).toBe(true);
    expect(app.shows("text:/其余留在卡片上/")).toBe(false); // how the box works waits behind its ⓘ
    await app.press("id:proposals-pb_1-numbers-info");
    await app.waitFor("text:/其余留在卡片上/");
    await app.press("id:proposal-p2-no");
    await app.waitUntil(() => log.acts.includes("p2 no"));
    await app.waitUntil(() => !app.shows("id:proposal-p2"));
    await app.type("id:proposals-pb_1-text", "1 3");
    await app.press("id:proposals-pb_1-send");
    await app.waitUntil(() => log.acts.includes("pb_1 1 3"));
    await app.waitUntil(() => !app.shows("id:proposals-pb_1"));
    expect(app.shows("id:proposals-pb_2")).toBe(true);
    expect(app.shows("text:紧急提案")).toBe(true);
    expect(app.shows("id:proposals-pb_2-text")).toBe(false); // one proposal: no box
    await app.press("id:proposal-p4-do");
    await app.waitUntil(() => log.acts.includes("p4 do"));
  });
});

describe("private channels", () => {
  // 张伟's own project: him and @acha; 王磊 owns @bei (his channels' work only) and @helper (the whole team's)
  const home = { id: "c_3", slug: "p-1a2b3c4d", name: "私房菜", topic: "", archived: false, created: T0, private: true, created_by: "u_1",
    members: [{ kind: "user", id: "u_1" }, { kind: "agent", id: "a_1" }], last_seq: 0 };
  const bei = { ...acha, id: "a_2", handle: "bei", name: "贝", owner_id: "u_2", machine_id: null, machines: [], dispatch: "channel" };
  const helper = { ...acha, id: "a_3", handle: "helper", name: "帮手", owner_id: "u_2", machine_id: "m_2", machines: ["m_2"], dispatch: "team" };
  const wlMac = { ...mac, id: "m_2", owner_id: "u_2", name: "王磊的 Mac" };
  const net = (log: Log, over: Record<string, unknown> = {}, tasks: any[] = []) => ({
    ...server(log, {}, tasks),
    [`GET ${URL}/api/v1/channels`]: { body: { channels: [pay, ops, home] } },
    [`GET ${URL}/api/v1/agents`]: { body: { agents: [acha, bei, helper] } },
    [`GET ${URL}/api/v1/machines`]: { body: { machines: [mac, wlMac] } },
    [`GET ${URL}/api/v1/channels/c_3/messages?*`]: { body: { messages: [], more: false } },
    ...over,
  });

  test("a new channel can be private: only one's own or team-wide agents are offered, and others' say where they run", async () => {
    const log = newLog();
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 800, network: net(log, {
      [`POST ${URL}/api/v1/channels`]: (r: { body?: string | null }) => { const b = JSON.parse(r.body!); log.created.push(b); return { body: { ...home, id: "c_9", name: b.name } }; },
    }) });
    await app.waitFor("id:new-channel");
    await app.press("id:new-channel");
    await app.waitFor("id:channel-private-toggle");
    expect(app.shows("id:pick-a_2")).toBe(true);
    await app.press("id:channel-private-toggle");
    await app.waitUntil(() => !app.shows("id:pick-a_2"));
    expect(app.shows("id:channel-private-note")).toBe(false); // the explanation waits behind its ⓘ
    await app.press("id:channel-private-info");
    await app.waitFor("id:channel-private-note");
    expect(app.shows("text:/服务器管理员仍能接触数据库文件/")).toBe(true);
    expect(app.shows("id:pick-a_2")).toBe(false); // 王磊's, for his channels only
    expect(app.shows("id:pick-a_3")).toBe(true);
    expect(app.shows("text:/运行在王磊的电脑上/")).toBe(true);
    await app.type("id:channel-name", "私房菜");
    await app.press("id:pick-a_1");
    await app.press("id:channel-create");
    await app.waitUntil(() => log.created.length === 1);
    expect(log.created[0]).toEqual({ name: "私房菜", topic: "", members: [{ kind: "agent", id: "a_1" }], private: true });
  });

  test("a private channel: a lock, no joining; its members panel keeps others' agents out or says where they run; its creator makes it public", async () => {
    const log = newLog();
    const added: any[] = [];
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 800, network: net(log, {
      [`POST ${URL}/api/v1/channels/c_3/members`]: (r: { body?: string | null }) => { added.push(JSON.parse(r.body!)); return { body: { ...home, members: [...home.members, JSON.parse(r.body!)] } }; },
      [`PATCH ${URL}/api/v1/channels/c_3`]: (r: { body?: string | null }) => { log.patches.push(JSON.parse(r.body!)); return { body: { ...home, private: false } }; },
    }) });
    await app.waitFor("id:channel-p-1a2b3c4d");
    await app.press("id:channel-p-1a2b3c4d");
    await app.waitFor("id:header-icon");
    expect(app.shows("id:join")).toBe(false);
    await app.press("id:channel-members");
    await app.waitFor("id:channel-publish");
    await app.press("id:members-add");
    await app.waitFor("id:members-add-bei-why-info");
    expect(app.enabled("id:members-add-bei")).toBe(false);
    expect(app.shows("id:members-add-bei-why-note")).toBe(false);
    await app.press("id:members-add-bei-why-info");
    await app.waitFor("text:/只有它的主人能拉进私有频道/");
    await app.back();
    await app.waitFor("id:members-add-bei-why-note", { state: "gone" });
    await app.press("id:members-add-helper");
    await app.waitFor("id:members-host-warning");
    expect(app.shows("text:/@helper 运行在王磊的电脑上，频道内容会发到那里/")).toBe(true);
    expect(added.length).toBe(0);
    await app.press("id:members-host-ok");
    await app.waitUntil(() => added.length === 1);
    expect(added[0]).toEqual({ kind: "agent", id: "a_3" });
    await app.press("id:channel-publish-start");
    await app.waitFor("id:channel-publish-warning");
    expect(app.shows("text:/所有历史消息都会对全队可见/")).toBe(true);
    await app.press("id:channel-publish-ok");
    await app.waitUntil(() => log.patches.length === 1);
    expect(log.patches[0]).toEqual({ private: false });
  });

  test("私聊: my agents and my chats are listed, others' team-wide agents behind the +; the first message makes the chat, and needs no @", async () => {
    const log = newLog();
    const made: any[] = [];
    const chat = { id: "c_9", slug: "p-9f9f9f9f", name: "helper", topic: "", archived: false, created: T0, private: true, created_by: "u_1", dm_agent: "a_3",
      members: [{ kind: "user", id: "u_1" }, { kind: "agent", id: "a_3" }], last_seq: 0 };
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 800, network: net(log, {
      [`POST ${URL}/api/v1/channels`]: (r: { body?: string | null }) => { made.push(JSON.parse(r.body!)); return { body: chat }; },
      // the server has what was posted by the time the chat opens
      [`GET ${URL}/api/v1/channels/c_9/messages?*`]: () => ({ body: { messages: log.posts.map((p, i) => msg({ id: `msg_9${i}`, seq: i + 1, channel_id: "c_9", text: p.text })), more: false } }),
    }) });
    await app.waitFor("id:side-agent-acha");
    expect(app.shows("id:side-agent-helper")).toBe(false); // 王磊's: not listed until I start a chat with it
    expect(app.shows("id:side-agent-bei")).toBe(false); // 王磊's, his channels' only
    await app.press("id:side-chat-new");
    await app.waitFor("id:side-chat-new-helper"); // takes the whole team's work
    expect(app.shows("id:side-chat-new-bei")).toBe(false);
    await app.press("id:side-chat-new-helper");
    await app.waitFor("id:dm-draft-helper");
    expect(app.shows("id:side-agent-helper")).toBe(true); // the chat being started
    expect(app.shows("text:/^王磊的 · /")).toBe(true);
    expect(app.shows("text:私聊 · 运行在王磊的电脑上")).toBe(true);
    expect(made.length).toBe(0); // nothing made by opening it
    await app.type("id:team-composer", "整理一下菜谱");
    await app.waitFor("text:/将派给 帮手/");
    await app.press("id:team-composer-send");
    await app.waitUntil(() => log.posts.length === 1);
    expect(made).toEqual([{ dm_agent: "a_3" }]);
    expect(log.posts[0]).toMatchObject({ text: "整理一下菜谱" });
    await app.waitFor("text:整理一下菜谱");
    expect(app.shows("id:channel-members")).toBe(false); // its members are fixed
    expect(app.shows("id:channel-p-9f9f9f9f")).toBe(false); // not among the channels
  });

  test("a private chat whose agent was deleted keeps its history and takes no more messages", async () => {
    const log = newLog();
    const chat = { id: "c_8", slug: "p-8e8e8e8e", name: "gone", topic: "", archived: false, created: T0, private: true, created_by: "u_1", dm_agent: "a_9",
      members: [{ kind: "user", id: "u_1" }], last_seq: 1 };
    const said = msg({ id: "msg_80", seq: 1, channel_id: "c_8", text: "以前说过的话" });
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 800, network: net(log, {
      [`GET ${URL}/api/v1/channels`]: { body: { channels: [pay, ops, home, chat] } },
      [`GET ${URL}/api/v1/channels/c_8/messages?*`]: { body: { messages: [said], more: false } },
    }) });
    await app.waitFor("id:side-agent-gone");
    await app.press("id:side-agent-gone");
    await app.waitFor("text:以前说过的话");
    expect(app.shows("id:dm-closed")).toBe(true);
    expect(app.shows("id:team-composer")).toBe(false);
  });

  test("an agent's owner not in the private channel gets a row without what it is about, and still confirms it", async () => {
    const log = newLog();
    const hidden = task({ id: "T-0007", channel_id: "", thread_id: "", title: "", body: "", created_by: "u_2", state: "pending", tracked: true, redacted: true });
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 800, network: net(log, {}, [hidden]) });
    await app.waitFor("id:open-inbox");
    await app.press("id:open-inbox");
    await app.waitFor("id:task-T-0007");
    expect(app.shows("text:私有频道里的任务")).toBe(true);
    expect(app.shows("text:/@acha · 在一个私有频道里 · 发起人 王磊/")).toBe(true);
    expect(app.shows("id:task-T-0007-open")).toBe(false);
    await app.press("id:task-T-0007-confirm");
    await app.waitUntil(() => log.acts.length === 1);
    expect(log.acts[0]).toBe("T-0007 confirm");
  });

  test("an agent's owner not in the private channel clicks a handoff card to it from a row without its words", async () => {
    const log = newLog();
    const hidden = task({ id: "T-0008", agent_id: "a_9", channel_id: "", thread_id: "", title: "", body: "", created_by: "u_2", state: "running", tracked: true, redacted: true,
      holder: { kind: "user", id: "u_1", why: "handoff_card" }, handoffs: [{ id: "ho_7", to: "a_1", what: "", message: "", at: T0, state: "proposed" }] });
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 1200, height: 800, network: net(log, {}, [hidden]) });
    await app.waitFor("id:open-inbox");
    await app.press("id:open-inbox");
    await app.waitFor("id:task-T-0008-handoff-ho_7");
    expect(app.shows("text:私有频道里的任务")).toBe(true);
    await app.press("id:task-T-0008-handoff-ho_7-accept");
    await app.waitUntil(() => log.acts.length === 1);
    expect(log.acts[0]).toBe("T-0008 handoff");
  });
});

describe("desktop shell", () => {
  // two tasks wait for 张伟 (u_1): a decision, then an acceptance
  const two = () => [
    task({ id: "T-0001", created_by: "u_1", state: "needs_decision", tracked: true, title: "退款接口重构", updated: T0 + 2,
      decision: { question: "兼容旧版签名吗？", options: ["兼容 v1，半年后下线", "只支持 v2"], recommendation: "兼容 v1" } }),
    task({ id: "T-0002", thread_id: "msg_t2", created_by: "u_1", state: "review", tracked: true, title: "订单导出加时区", updated: T0 + 1 }),
  ];

  test("a phone opens on 待你决定 when something waits: the first one open with its buttons, a held row's menu from the bottom", async () => {
    const app = await open("./App.tsx", { storage: SESSION, network: server(newLog(), {}, two()) });
    await app.waitFor("id:task-T-0001");
    expect(app.shows("id:tab-inbox-badge")).toBe(true);
    // the first is open (its card and buttons), the next a row; pressing the row opens it instead
    expect(app.shows("id:triage-T-0002")).toBe(true);
    expect(app.shows("id:task-T-0002")).toBe(false);
    await app.longPress("id:triage-T-0002");
    await app.waitFor("id:triage-T-0002-later-1");
    await app.back();
    await app.waitFor("id:triage-T-0002-later-1", { state: "gone" });
    await app.press("id:triage-T-0002");
    await app.waitFor("id:task-T-0002");
    expect(app.shows("id:triage-T-0001")).toBe(true);
    // 消息 is the next tab; going there stays there
    await app.press("id:tab-chat");
    await app.waitFor("id:channel-pay");
  });

  test("⌘K opens the palette; G I and G T go to 待你决定 and 我的任务; C starts a dispatch", async () => {
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(newLog()) });
    await app.waitFor("id:team-composer");
    await app.keyboard.press("mod+k");
    await app.waitFor("id:palette");
    await app.type("id:palette-command", "New channel");
    await app.press("text:New channel");
    await app.waitFor("id:channel-name");
    await app.keyboard.press("g");
    await app.keyboard.press("i");
    await app.waitFor("id:inbox-empty");
    await app.keyboard.press("g");
    await app.keyboard.press("t");
    await app.waitFor("text:Tasks");
    // 派任务: the palette at its dispatch commands; in a channel it writes @acha into the box
    await app.press("id:channel-pay");
    await app.waitFor("id:team-composer");
    await app.keyboard.press("c");
    await app.waitFor("text:Dispatch to @acha");
    await app.press("text:Dispatch to @acha");
    await app.waitUntil(() => app.value("id:team-composer") === "@acha ");
  });

  test("待你决定 is a triage desk: the first one picked, J and K move, acting picks the next, H reminds me later", async () => {
    const log = newLog();
    const made: any[] = [];
    const app = await open("./App.tsx", {
      storage: SESSION, width: 1200, height: 800,
      network: server(log, { [`POST ${URL}/api/v1/reminders`]: (r: { body?: string | null }) => { const b = JSON.parse(r.body!); made.push(b); return { body: { id: "rem_9", by: "u_1", target: { kind: "user", id: "u_1" }, channel_id: "c_1", thread_id: null, message_id: b.message_id, text: "", due: Date.now() + 3600_000, repeat: "", created: Date.now(), fired: null, seen: null, done: false } }; } }, two()),
    });
    await app.waitFor("id:open-inbox-unread");
    await app.press("id:open-inbox");
    await app.waitFor("id:triage-T-0001");
    expect(app.shows("id:triage-detail")).toBe(true);
    expect(app.shows("id:task-T-0001-ask")).toBe(true); // the decision: options first, then 回复…
    expect(app.shows("id:task-T-0001-ask-reply")).toBe(true);
    await app.keyboard.press("j");
    await app.waitFor("id:task-T-0002-review");
    await app.keyboard.press("k");
    await app.waitFor("id:task-T-0001-ask");
    await app.press("id:task-T-0001-option-0");
    await app.waitFor("id:task-T-0002-review"); // decided: the next one is up
    expect(log.acts).toEqual(["T-0001 decide 兼容 v1，半年后下线"]);
    await app.keyboard.press("h");
    await app.waitUntil(() => made.length === 1);
    expect(made[0]).toEqual({ message_id: "msg_t2", when: "1h" });
    await app.waitFor("id:inbox-empty"); // put off until the reminder goes off
  });

  test("an agent's state is one of five words; only 等你 and 卡住 are colored", async () => {
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, network: server(newLog(), {}, [two()[0]].map((x) => ({ ...x, agent_id: "a_1" }))) });
    await app.waitFor("id:side-agent-acha-state");
    await app.waitFor("text:Codex · Waiting on you");
  });

  test("a channel's right click (a held finger on phones): the same commands as the palette", async () => {
    const app = await open("./App.tsx", { storage: SESSION, width: 1200, height: 800, platform: "macos", network: server(newLog()) });
    await app.waitFor("id:channel-pay");
    await app.rightClick("id:channel-pay");
    await app.waitFor("text:Dispatch to @acha");
    await app.press("id:ctx-dispatch-acha");
    await app.waitUntil(() => app.value("id:team-composer") === "@acha ");
  });
});
