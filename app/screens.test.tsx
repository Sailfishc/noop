import { describe, expect, open, test } from "nsh/test";
import { acha, m1, mac, msg, ops, pay, r1, SESSION, server, newLog, T0, task, URL, zw } from "./fixtures";

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
  task({ id: "T-0001", state: "running", tracked: true, title: "看下慢查询", step: "在读 slow log", created_by: "u_1",
    holder: { kind: "user", id: "u_1", why: "handoff_card" }, mandate: { by: "u_1", rule: "channel", confirm: false, autonomy: "assist", branch: "agent/T-0001", runtime: "codex", trigger: "trg_1" },
    handoffs: [{ id: "ho_1", to: "a_2", what: "加完索引后跑一遍压测，把 P99 贴回线程", message: "msg_5", at: Date.now(), state: "proposed" }] }),
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
const box = { ...mac, team: true, git: [{ provider: "gitlab", host: "code.corp.com", configured: true, user: "remi-bot", via: "token" }],
  repos: [{ remote: "github.com/acme/pay", name: "pay" }], skills: ["release-notes", "sql-review"], mcp: ["jira"],
  runtime_info: [{ name: "codex", version: "0.80.0", installed: true, logged_in: true }],
  team_config: { repo: "git@code.corp.com:team/remi-config.git", commit: "abc1234", synced: T0, instructions: true } };
const net = () => server(newLog(), {
  [`GET ${URL}/api/v1/machines`]: { body: { machines: [box] } },
  [`GET ${URL}/api/v1/agents`]: { body: { agents: [acha, { ...acha, id: "a_2", handle: "bei", name: "贝", owner_id: "u_2", machine_id: null }] } },
  [`GET ${URL}/api/v1/channels/c_1/messages?*`]: { body: { messages, more: false } },
  [`GET ${URL}/api/v1/messages/msg_1/thread`]: { body: { root: m1, replies: [r1] } },
}, tasks);
const start = () => open("./App.tsx", { storage: SESSION, ...SIZE, network: net() });

// The component showcase (app/ui/showcase.tsx), light and dark: every component and its states on one page.
describe("showcase", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`showcase-${scheme}`, async () => {
      const app = await open("./Showcase.tsx", { width: 1280, height: 1400, colorScheme: scheme });
      await app.waitFor("id:showcase");
      await shot(app, `showcase-${scheme}`);
    });
  }
  test("showcase-overlays", async () => {
    const app = await open("./Showcase.tsx", { width: 1280, height: 1400 });
    await app.waitFor("id:showcase");
    await app.press("id:showcase-label-info");
    await app.waitFor("id:showcase-label-note");
    await shot(app, "showcase-note");
    await app.press("id:showcase-toast");
    await app.waitFor("id:toast-error");
    await shot(app, "showcase-toast");
    await app.press("id:showcase-dialog-open");
    await app.waitFor("id:showcase-dialog-close");
    await shot(app, "showcase-dialog");
    await app.press("id:showcase-dialog-close");
    await app.press("id:showcase-menu");
    await app.waitFor("text:With an icon");
    await shot(app, "showcase-menu");
  });
});

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

  test("members", async () => {
    const app = await open("./App.tsx", { storage: SESSION, ...SIZE, network: { ...net(), [`GET ${URL}/api/v1/triggers?*`]: { body: { triggers: [
      { id: "trg_1", channel_id: "c_1", agent_id: "a_1", created_by: "u_2", kind: "schedule", text: "汇总一下昨晚的告警", repeat: "weekdays", due: T0, confirmed_by: "u_1", enabled: true, fired: T0, fires: 4, created: T0, max_per_day: 10, skipped: 2, skipped_run: 2, skip_reason: "busy", last_task: "T-0003" },
      { id: "trg_2", channel_id: "c_1", agent_id: "a_1", created_by: "u_2", kind: "pr", text: "review 这个 PR", repo: "github.com/acme/pay", confirmed_by: null, enabled: true, fired: null, fires: 0, created: T0, max_per_day: 10, skipped: 0 },
    ] } } } });
    await app.waitFor("id:channel-members");
    await app.press("id:channel-members");
    await app.waitFor("id:trigger-trg_2");
    await shot(app, "members");
    await app.press("id:channel-conventions-box");
    await app.type("id:channel-conventions-input", "- PR 标题用中文");
    await shot(app, "members-conventions");
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
    await app.press("id:settings-nav-teamconfig");
    await app.waitFor("id:teamconfig-repo");
    await shot(app, "settings-teamconfig");
    await app.press("id:settings-nav-machines");
    await app.waitFor("id:machine-m_1-git");
    await shot(app, "settings-machines");
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

// A private channel (step 1, personal space): 张伟's own project with @acha; 王磊's @helper takes the whole team's work,
// his @bei only his channels'. And an agent's owner who is not in someone's private channel: a row without its content.
const home = { id: "c_3", slug: "p-1a2b3c4d", name: "私房菜", topic: "周末的菜谱整理", archived: false, created: T0, private: true, created_by: "u_1",
  members: [{ kind: "user", id: "u_1" }, { kind: "agent", id: "a_1" }], last_seq: 1 };
const privNet = () => ({
  ...net(),
  [`GET ${URL}/api/v1/channels`]: { body: { channels: [pay, ops, home] } },
  [`GET ${URL}/api/v1/agents`]: { body: { agents: [acha, { ...acha, id: "a_2", handle: "bei", name: "贝", owner_id: "u_2", machine_id: null },
    { ...acha, id: "a_3", handle: "helper", name: "帮手", owner_id: "u_2", machine_id: "m_2", dispatch: "team" }] } },
  [`GET ${URL}/api/v1/machines`]: { body: { machines: [box, { ...mac, id: "m_2", owner_id: "u_2", name: "王磊的 Mac" }] } },
  [`GET ${URL}/api/v1/channels/c_3/messages?*`]: { body: { messages: [msg({ id: "msg_p1", seq: 1, channel_id: "c_3", author: { kind: "user", id: "u_1" }, text: "@acha 把这周末的菜谱整理成一张表", mentions: [{ kind: "agent", id: "a_1", handle: "acha" }] })], more: false } },
  [`GET ${URL}/api/v1/inbox`]: { body: { tasks: [task({ id: "T-0009", channel_id: "", thread_id: "", title: "", body: "", created_by: "u_2", state: "pending", tracked: true, redacted: true, updated: Date.now() })] } },
});

describe("private", () => {
  const privStart = (size = SIZE) => open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, ...size, network: privNet() });

  test("private-channel, its members panel, the inbox", async () => {
    const app = await privStart();
    await app.waitFor("id:channel-p-1a2b3c4d");
    await app.press("id:channel-p-1a2b3c4d");
    await app.waitFor("text:@acha 把这周末的菜谱整理成一张表");
    await shot(app, "private-channel");
    await app.press("id:channel-members");
    await app.waitFor("id:channel-publish");
    await app.press("id:members-add");
    await app.press("id:members-add-helper");
    await app.waitFor("id:members-host-warning");
    await shot(app, "private-members");
    await app.press("id:channel-publish-start");
    await app.waitFor("id:channel-publish-warning");
    await shot(app, "private-publish");
    await app.press("id:open-inbox");
    await app.waitFor("id:task-T-0009");
    await shot(app, "private-inbox-redacted");
  });

  test("private-new-channel", async () => {
    const app = await privStart();
    await app.waitFor("id:new-channel");
    await app.press("id:new-channel");
    await app.waitFor("id:channel-private-toggle");
    await app.press("id:channel-private-toggle");
    await app.waitFor("id:pick-a_3-host");
    await shot(app, "private-new-channel");
  });

  test("phone: the channel list with a private one, and the channel", async () => {
    const app = await privStart(PHONE);
    await app.waitFor("id:channel-p-1a2b3c4d");
    await shot(app, "phone-private-1-list");
    await app.press("id:channel-p-1a2b3c4d");
    await app.waitFor("text:@acha 把这周末的菜谱整理成一张表");
    await shot(app, "phone-private-2-channel");
  });
});
