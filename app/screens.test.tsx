import { describe, open, test } from "nsh/test";
import { m1, msg, r1, SESSION, server, newLog, task, URL } from "./fixtures";

// The main desktop screens, with the pretend team from fixtures.ts.
//
// - `nsh test` (headless, CI's "UI tests") opens each one: it must render without errors.
// - `scripts/screens.sh` runs them in headless Chromium (`--target web`) and saves PNGs in
//   app/.nsh/screens/: look at them after changing app/ (CI uploads them as `screens`).
// - `scripts/check-layout.ts` reads the `--trace` of a headless run and checks the layouts
//   that tests can't see (the task board's columns side by side).
//
// Desktop only for now (the team uses the Mac app); add phone widths here later.
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
    await app.waitFor("id:channel-tab-tasks");
    await app.press("id:channel-tab-tasks");
    await app.waitFor("id:tasks-board");
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
  });
});
