import { describe, expect, open, test } from "nsh/test";
import { m1, msg, r1, SESSION, server, newLog, task, URL, zw } from "./fixtures";

// The main desktop screens, with the pretend team from fixtures.ts.
//
// - `nsh test` (headless, CI's "UI tests") opens each one: it must render without errors.
// - `scripts/screens.sh` runs them in headless Chromium (`--target web`) and saves PNGs in
//   app/.nsh/screens/: look at them after changing app/ (CI uploads them as `screens`).
// - `scripts/check-layout.ts` reads the `--trace` of a headless run and checks the layouts
//   that tests can't see (the task board's columns side by side).
//
// Desktop at 1280×800, and the phone layout (bottom tabs, one page at a time) at 390×844 in Chinese.
const SIZE = { width: 1280, height: 800 };

async function shot(app: Awaited<ReturnType<typeof open>>, name: string) {
  try {
    await app.screenshot(`.nsh/screens/${name}.png`);
  } catch (e) {
    // Headless runs draw nothing, so there is no picture to take; real targets must take it.
    if (!/screenshot|platform|headless|draw/i.test(String((e as Error)?.message ?? e))) throw e;
  }
}

const tasks = [
  task({ id: "T-0001", state: "running", tracked: true, title: "看下慢查询", step: "在读 slow log" }),
  task({ id: "T-0002", thread_id: "msg_t2", state: "blocked", tracked: true, title: "加索引", summary: "没有数据库权限" }),
  task({ id: "T-0003", thread_id: "msg_t3", state: "review", tracked: true, title: "写周报", created_by: "u_1",
    pr: { provider: "github", url: "https://github.com/acme/pay/pull/3", number: 3, state: "open", checks: "success" } }),
  task({ id: "T-0004", thread_id: "msg_t4", state: "pending", tracked: true, title: "升级 Go 版本" }),
  task({ id: "T-0005", thread_id: "msg_t5", state: "done", tracked: true, title: "清理旧分支" }),
];
const messages = [
  m1,
  msg({ id: "msg_3", seq: 3, text: "今天下午三点发版，大家注意一下" }),
  msg({ id: "msg_4", seq: 4, author: { kind: "user", id: "u_1" }, text: "收到 👍" }),
];
const net = () => server(newLog(), {
  [`GET ${URL}/api/v1/channels/c_1/messages?*`]: { body: { messages, more: false } },
  [`GET ${URL}/api/v1/messages/msg_1/thread`]: { body: { root: m1, replies: [r1] } },
}, tasks);
const start = () => open("./App.tsx", { storage: SESSION, ...SIZE, network: net() });

describe("screens", () => {
  test("channel", async () => {
    const app = await start();
    await app.waitFor("text:今天下午三点发版，大家注意一下");
    await shot(app, "channel");
  });

  test("thread", async () => {
    const app = await start();
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("id:close-thread");
    await app.waitFor("text:收到，在看"); // the reply, not the spinner
    await shot(app, "thread");
  });

  test("tasks-board", async () => {
    const app = await start();
    // Press the tab only once the channel has loaded: an earlier press can land on a channel view that the
    // first load then replaces, and the board never opens (seen once in headless Chromium).
    // Even then CI's Chromium once kept the conversation (main, 2026-11-09): press again until the board opens.
    await app.waitFor("text:今天下午三点发版，大家注意一下");
    for (let i = 0; ; i++) {
      await app.press("id:channel-tab-tasks");
      try {
        await app.waitFor("id:tasks-board", { timeout: 3000 });
        break;
      } catch (e) {
        if (i >= 3) throw e;
      }
    }
    await shot(app, "tasks-board");
  });

  test("tasks-page", async () => {
    const app = await start();
    await app.waitFor("id:open-tasks");
    await app.press("id:open-tasks");
    await app.waitFor("id:tasks-filter-all");
    await app.press("id:tasks-filter-all");
    await app.waitFor("id:taskrow-T-0001");
    await shot(app, "tasks-page");
  });

  test("settings", async () => {
    const app = await start();
    await app.waitFor("id:open-tasks");
    await app.keyboard.press("mod+,");
    await app.waitFor("id:settings");
    await app.press("id:settings-nav-agents");
    await shot(app, "settings-agents");
    await app.press("id:settings-nav-general");
    await app.waitFor("id:notify");
    await shot(app, "settings-general");
    await app.press("id:settings-nav-metrics");
    await app.waitFor("id:metrics-redone");
    await shot(app, "settings-metrics");
  });

  test("signin-ask", async () => {
    const app = await open("./App.tsx", { ...SIZE, storage: { "hub.lang": "zh" }, network: net() });
    await app.press("id:signin-mode-ask");
    await app.waitFor("id:ask-note");
    await shot(app, "signin-ask");
  });

  test("settings-people", async () => {
    const asking = { id: "s_1", email: "li@corp.com", handle: "lina", name: "李娜", note: "支付组新人，想加入一起做对账", state: "pending", created: Date.now() - 600_000 };
    const app = await open("./App.tsx", {
      storage: { ...SESSION, "hub.lang": "zh" }, ...SIZE,
      network: { ...net(),
        [`GET ${URL}/api/v1/inbox`]: { body: { tasks: [], signups: [asking] } },
        [`GET ${URL}/api/v1/me`]: { body: { user: zw, machines: [], agents: [], workspace: { id: "w_7f3a91c2", name: "支付团队", signup: true } } } },
    });
    await app.waitFor("id:open-tasks");
    await app.keyboard.press("mod+,");
    await app.waitFor("id:settings");
    await app.press("id:settings-nav-people");
    await app.waitFor("id:signup-lina");
    await shot(app, "settings-people");
  });
});

// Phones: the tab bar's four tabs, a channel and its thread, one agent's page.
const PHONE = { width: 390, height: 844 };
const phone = () => open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, ...PHONE, network: net() });

describe("phone", () => {
  test("messages tab, a channel, a thread", async () => {
    const app = await phone();
    await app.waitFor("id:tab-chat");
    await app.waitFor("id:channel-pay");
    expect(app.shows("id:open-inbox")).toBe(false); // a tab on phones
    await shot(app, "phone-1-messages");
    await app.press("id:channel-pay");
    await app.waitFor("text:今天下午三点发版，大家注意一下");
    expect(app.shows("id:tabbar")).toBe(false);
    await shot(app, "phone-2-channel");
    await app.press("id:thread-msg_1");
    await app.waitFor("text:收到，在看");
    await shot(app, "phone-3-thread");
  });

  test("waiting and tasks tabs: tasks as a list", async () => {
    const app = await phone();
    await app.waitFor("id:tab-inbox");
    await app.press("id:tab-inbox");
    await app.waitFor("text:写周报");
    await shot(app, "phone-4-waiting");
    await app.press("id:tab-tasks");
    await app.waitFor("id:tasks-filter-all");
    await app.press("id:tasks-filter-all");
    await app.waitFor("id:tasks-list");
    expect(app.shows("id:tasks-board")).toBe(false);
    expect(app.shows("id:tasks-layout-board")).toBe(false);
    await shot(app, "phone-5-tasks");
  });

  test("me tab: settings, then the agents list, then one agent", async () => {
    const app = await phone();
    await app.waitFor("id:tab-me");
    await app.press("id:tab-me");
    await app.waitFor("id:settings-nav-agents");
    await shot(app, "phone-6-me");
    await app.press("id:settings-nav-agents");
    await app.waitFor("id:agent-acha");
    expect(app.shows("id:tabbar")).toBe(false);
    await app.press("id:agent-acha");
    await app.waitFor("text:阿查");
    expect(app.shows("id:agent-acha")).toBe(false); // the page, not the list beside it
    await shot(app, "phone-7-agent");
    await app.press("id:back");
    await app.waitFor("id:agent-acha");
    await app.press("id:back");
    await app.waitFor("id:tabbar");
  });
});
