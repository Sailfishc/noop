import { describe, expect, open, test } from "nsh/test";
import { acha, m1, mac, msg, ops, pay, r1, rem, SESSION, server, newLog, T0, task, URL, zw } from "./fixtures";

// The main desktop screens, with the pretend team from fixtures.ts.
//
// - `nsh test` (headless, CI's "UI tests") opens each one: it must render without errors.
// - `scripts/screens.sh` runs them in headless Chromium (`--target web`) and saves PNGs in
//   app/.nsh/screens/: look at them after changing app/ (CI uploads them as `screens`).
// - `scripts/check-layout.ts` reads the `--trace` of a headless run and checks the layouts
//   that tests can't see (the task board's columns side by side).
//
// Desktop at 1280×800 as macOS (the pointer density), and the phone layout (bottom tabs, one page at a time, the
// touch density) at 390×844 in Chinese.
const SIZE = { width: 1280, height: 800, platform: "macos" as const };

async function shot(app: Awaited<ReturnType<typeof open>>, name: string) {
  try {
    await app.wait(400); // a page pushed on a phone has slid in
    await app.screenshot(`.nsh/screens/${name}.png`);
  } catch (e) {
    // Headless runs draw nothing, so there is no picture to take; real targets must take it.
    if (!/screenshot|platform|headless|draw/i.test(String((e as Error)?.message ?? e))) throw e;
  }
}

const tasks = [
  task({ id: "T-0001", state: "running", tracked: true, title: "看下慢查询", step: "在读 slow log", created_by: "u_1",
    holder: { kind: "user", id: "u_2", why: "handoff_card" }, mandate: { by: "u_1", rule: "channel", confirm: false, autonomy: "assist", branch: "agent/T-0001", runtime: "codex", trigger: "trg_1" },
    handoffs: [{ id: "ho_1", to: "a_2", what: "加完索引后跑一遍压测，把 P99 贴回线程", message: "msg_5", at: Date.now(), state: "proposed" }],
    checkpoint: { at: T0, checked: T0 + 600_000, machine: "m_1", repos: [{ repo: "github.com/acme/pay", branch: "agent/T-0001-wip", commit: "a".repeat(40), head: "b".repeat(40) }] },
    calls: [{ at: T0, who: "u_1", kind: "decide", class: "decide" }, { at: T0, who: "u_1", kind: "unblock", class: "outside" }, { at: T0, who: "u_1", kind: "handoff_card", class: "decide" }],
    reminders: [rem()] }),
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
const net = (extra: Record<string, unknown> = {}) => server(newLog(), {
  ...extra,
  [`GET ${URL}/api/v1/machines`]: { body: { machines: [box] } },
  [`GET ${URL}/api/v1/agents`]: { body: { agents: [acha, { ...acha, id: "a_2", handle: "bei", name: "贝", owner_id: "u_2", machine_id: null, machines: [] }] } },
  [`GET ${URL}/api/v1/channels/c_1/messages?*`]: { body: { messages, more: false } },
  [`GET ${URL}/api/v1/messages/msg_1/thread`]: { body: { root: m1, replies: [r1] } },
}, tasks);
const start = () => open("./App.tsx", { storage: SESSION, ...SIZE, network: net() });
// the first task stopped to align: what "done" will mean, waiting for 张伟
const aligning = task({ id: "T-0001", state: "needs_decision", tracked: true, title: "看下慢查询", created_by: "u_1", aligned: true,
  holder: { kind: "user", id: "u_1", why: "align" },
  decision: { kind: "align", question: "做完意味着", options: null, acceptance: ["/orders 的 P99 降到 200ms 以内", "加索引不锁表", "有一份压测前后的对比"],
    not_doing: ["不改查询接口的参数"], approach: "先加 created_at 索引，再压测对比。", dirty: true },
  calls: [{ at: T0, who: "u_1", kind: "align", class: "align" }] });
// the first task delivered: three criteria, two checked, one the agent could not verify, one it never mentioned
const delivered = task({ id: "T-0001", state: "review", tracked: true, title: "看下慢查询", created_by: "u_1", aligned: true,
  acceptance: "/orders 的 P99 降到 200ms 以内\n加索引不锁表\n有一份压测前后的对比\n线上一周没有新的慢查询告警",
  holder: { kind: "user", id: "u_1", why: "accept" }, summary: "加了 created_at 索引，压测 P99 从 3.1s 到 160ms。",
  evidence: [
    { criterion: 1, how: "ran", proof: "bun run bench --route /orders\np50 42ms  p90 120ms  p99 160ms" },
    { criterion: 2, how: "saw", proof: "看了迁移脚本：CREATE INDEX CONCURRENTLY" },
    { criterion: 3, how: "not_verified", proof: "预发没有压测数据，请在预发跑 scripts/bench.sh 对比" },
    { criterion: 4, how: "unstated" },
  ],
  calls: [{ at: T0, who: "u_1", kind: "align", class: "align" }, { at: T0, who: "u_1", kind: "accept", class: "accept" }] });
const evidenceNet = () => server(newLog(), {
  [`GET ${URL}/api/v1/machines`]: { body: { machines: [box] } },
  [`GET ${URL}/api/v1/agents`]: { body: { agents: [acha] } },
  [`GET ${URL}/api/v1/channels/c_1/messages?*`]: { body: { messages, more: false } },
  [`GET ${URL}/api/v1/messages/msg_1/thread`]: { body: { root: m1, replies: [r1] } },
}, [delivered, ...tasks.slice(1)]);
// the first task's agent delegated two parts to two agents and waits for them: one is back, one still at it
const leadT = task({ id: "T-0001", state: "waiting", tracked: true, title: "整理退款流程并补测试", created_by: "u_1", step: "委派的都交回了，检查汇总",
  wait: { how: "delegates", deadline: 0, since: T0 }, holder: { kind: "agent", id: "a_1", why: "wait" },
  handoffs: [{ id: "ho_1", to: "a_2", what: "写退款流程文档", message: "msg_7", at: T0, state: "accepted", auto: true, kind: "delegate", task: "T-0006" },
    { id: "ho_2", to: "a_3", what: "补退款单测", message: "msg_8", at: T0, state: "accepted", auto: true, kind: "delegate", task: "T-0007" }],
  delegates: [{ task: "T-0006", agent: "a_2", state: "done", status: "done", redos: 1 }, { task: "T-0007", agent: "a_3", state: "running", status: "in_progress" }] });
const child = (id: string, agent: string, state: string, title: string) => task({ id, agent_id: agent, state, tracked: true, title, created_by: "u_1", created: T0 + 1,
  mandate: { by: "u_1", rule: "channel", confirm: false, autonomy: "assist", branch: `agent/${id}`, runtime: "codex", via: ["a_1"], parent: "T-0001", delegated: true } });
const leadAgents = [acha, { ...acha, id: "a_2", handle: "bei", name: "贝", machine_id: null, machines: [] }, { ...acha, id: "a_3", handle: "san", name: "三", machine_id: null, machines: [] }];
const delegateNet = () => server(newLog(), {
  [`GET ${URL}/api/v1/machines`]: { body: { machines: [box] } },
  [`GET ${URL}/api/v1/agents`]: { body: { agents: leadAgents } },
  [`GET ${URL}/api/v1/channels/c_1/messages?*`]: { body: { messages, more: false } },
  [`GET ${URL}/api/v1/messages/msg_1/thread`]: { body: { root: m1, replies: [r1] } },
}, [leadT, child("T-0006", "a_2", "done", "写退款流程文档"), child("T-0007", "a_3", "running", "补退款单测"), ...tasks.slice(1)]);
const alignNet = () => server(newLog(), {
  [`GET ${URL}/api/v1/machines`]: { body: { machines: [box] } },
  [`GET ${URL}/api/v1/agents`]: { body: { agents: [acha] } },
  [`GET ${URL}/api/v1/channels/c_1/messages?*`]: { body: { messages, more: false } },
  [`GET ${URL}/api/v1/messages/msg_1/thread`]: { body: { root: m1, replies: [r1] } },
}, [aligning, ...tasks.slice(1)]);
// the first task's computer went away mid-run: its agent's owner (张伟, who is signed in) is asked whether it goes on
// on the desktop, from the checkpoint 12 minutes before
const moving = task({ id: "T-0001", state: "running", tracked: true, title: "看下慢查询", step: "在读 slow log", created_by: "u_1", claimed_by: "m_1",
  holder: { kind: "user", id: "u_1", why: "move" }, moves: 0,
  move: { from: "m_1", to: "m_2", at: Date.now(), since: Date.now() - 14 * 60_000, state: "proposed" },
  checkpoint: { at: Date.now() - 26 * 60_000, checked: Date.now() - 26 * 60_000, machine: "m_1", repos: [{ repo: "github.com/acme/pay", branch: "agent/T-0001-wip", commit: "a".repeat(40) }] },
  calls: [{ at: T0, who: "u_1", kind: "move", class: "outside" }] });
const moveNet = () => server(newLog(), {
  [`GET ${URL}/api/v1/machines`]: { body: { machines: [{ ...box, online: false, last_seen: Date.now() - 14 * 60_000 }, { ...mac, id: "m_2", name: "张伟的台式机", online: true }] } },
  [`GET ${URL}/api/v1/agents`]: { body: { agents: [{ ...acha, machines: ["m_1", "m_2"] }] } },
  [`GET ${URL}/api/v1/channels/c_1/messages?*`]: { body: { messages, more: false } },
  [`GET ${URL}/api/v1/messages/msg_1/thread`]: { body: { root: m1, replies: [r1] } },
}, [moving, ...tasks.slice(1)]);
// the first task waits for Codex's limit (two hours away) and Claude Code on the same computer can take it: its agent's
// owner (张伟) is asked whether it goes on with Claude Code
const reset = Date.now() + 2 * 3600_000;
const engineTask = (x: Record<string, unknown>) => task({ id: "T-0001", tracked: true, title: "看下慢查询", created_by: "u_1", claimed_by: "m_1", ...x });
const stopped = engineTask({ state: "waiting", holder: { kind: "user", id: "u_1", why: "engine" },
  wait: { how: "quota", since: Date.now() - 600_000, expect: reset, machine: "m_1", runtime: "codex" },
  engine: { from: "codex", to: "claude", machine: "m_1", at: Date.now(), since: Date.now() - 600_000, reason: "quota", state: "proposed" },
  calls: [{ at: T0, who: "u_1", kind: "engine", class: "outside" }] });
const switched = engineTask({ state: "running", step: "在读 slow log", runtime: "claude",
  engine: { from: "codex", to: "claude", machine: "m_1", at: Date.now(), since: Date.now() - 600_000, reason: "quota", state: "switched", decided_by: "u_1" } });
const engineNet = (t: ReturnType<typeof task>) => server(newLog(), {
  [`GET ${URL}/api/v1/machines`]: { body: { machines: [{ ...box, runtimes: ["codex", "claude"],
    runtime_info: [{ name: "codex", version: "0.80.0", installed: true, logged_in: true }, { name: "claude", version: "2.1.0", installed: true, logged_in: true }],
    runtime_status: { codex: { state: "quota", reason: "quota", text: "等额度恢复", until: reset, since: Date.now() - 600_000, at: Date.now() - 600_000 } } }] } },
  [`GET ${URL}/api/v1/agents`]: { body: { agents: [acha] } },
  [`GET ${URL}/api/v1/channels/c_1/messages?*`]: { body: { messages, more: false } },
  [`GET ${URL}/api/v1/messages/msg_1/thread`]: { body: { root: m1, replies: [r1] } },
}, [t, ...tasks.slice(1)]);

// The component showcase (app/ui/showcase.tsx): every component and its states, light and dark, desktop (pointer
// density) and phone (touch density), and its Tokens tab, every token listed from the generated file.
const DESK_SHOW = { width: 1280, height: 1700, platform: "macos" as const };
const PHONE_SHOW = { width: 390, height: 2600 };
describe("showcase", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`showcase-${scheme}`, async () => {
      const app = await open("./Showcase.tsx", { ...DESK_SHOW, colorScheme: scheme });
      await app.waitFor("id:showcase");
      await shot(app, `showcase-${scheme}`);
    });
    test(`showcase-phone-${scheme}`, async () => {
      const app = await open("./Showcase.tsx", { ...PHONE_SHOW, colorScheme: scheme });
      await app.waitFor("id:showcase");
      await shot(app, `showcase-phone-${scheme}`);
    });
    test(`showcase-tokens-${scheme}`, async () => {
      const app = await open("./Showcase.tsx", { ...DESK_SHOW, height: 2000, colorScheme: scheme });
      await app.press("id:showcase-page-tokens");
      await app.waitFor("id:showcase-tokens");
      await shot(app, `showcase-tokens-${scheme}`);
    });
  }
  test("showcase-phone-sheets: a Modal and an ⓘ note rise from the bottom on a phone", async () => {
    const app = await open("./Showcase.tsx", PHONE_SHOW);
    await app.waitFor("id:showcase");
    await app.press("id:showcase-label-info");
    await app.waitFor("id:showcase-label-note");
    await shot(app, "showcase-phone-note");
    await app.back();
    await app.waitFor("id:showcase-label-note", { state: "gone" });
    await app.press("id:showcase-dialog-open");
    await app.waitFor("id:showcase-dialog");
    await shot(app, "showcase-phone-sheet");
  });
  test("showcase-overlays", async () => {
    const app = await open("./Showcase.tsx", DESK_SHOW);
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
    expect(app.shows("id:task-T-0001-checkpoint-at")).toBe(true); // where it got to, a line with its ⓘ
    await shot(app, "thread");
    await app.press("id:reminder-tag-rem_1 >> nth=1"); // the ⏰ on its card (in the thread): pause or cancel it there
    await app.waitFor("id:reminder-tag-rem_1-pause");
    await shot(app, "thread-reminder-menu");
  });

  test("thread-align: the align card, its criteria editable", async () => {
    const app = await open("./App.tsx", { storage: SESSION, ...SIZE, network: alignNet() });
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("id:close-thread");
    await app.waitFor("text:收到，在看");
    await app.waitFor("id:task-T-0001-align-go");
    await shot(app, "thread-align");
    await app.press("id:thread >> id:task-T-0001-align-edit");
    await app.waitFor("id:thread >> id:task-T-0001-align-input");
    await shot(app, "thread-align-edit");
  });

  test("thread-move: the 换电脑继续 card, for the agent's owner", async () => {
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, ...SIZE, network: moveNet() });
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("id:close-thread");
    await app.waitFor("text:收到，在看");
    await app.waitFor("id:thread >> id:task-T-0001-move-go");
    expect(app.shows("id:thread >> id:task-T-0001-move-wait")).toBe(true);
    expect(app.shows("id:thread >> id:task-T-0001-move-lost")).toBe(true);
    await shot(app, "thread-move");
  });

  test("thread-engine: the 换引擎继续 card for the agent's owner; once switched, the task says which runtime runs it", async () => {
    let app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, ...SIZE, network: engineNet(stopped) });
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("id:close-thread");
    await app.waitFor("text:收到，在看");
    await app.waitFor("id:thread >> id:task-T-0001-engine-go");
    expect(app.shows("id:thread >> id:task-T-0001-engine-keep")).toBe(true);
    await shot(app, "thread-engine");
    app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, ...SIZE, network: engineNet(switched) });
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("id:close-thread");
    await app.waitFor("text:从 Codex 换来"); // the facts: Claude Code, switched from Codex (its ⓘ says why)
    expect(app.shows("id:task-T-0001-engine-go")).toBe(false);
    await shot(app, "thread-engine-switched");
  });

  test("thread-evidence: a delivered task, each criterion with how it was checked", async () => {
    const app = await open("./App.tsx", { storage: SESSION, ...SIZE, network: evidenceNet() });
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("id:close-thread");
    await app.waitFor("text:收到，在看");
    await app.waitFor("id:thread >> id:task-T-0001-evidence-list");
    await app.press("id:thread >> id:task-T-0001-evidence-1");
    await shot(app, "thread-evidence");
  });

  test("thread-delegates: a task whose agent delegated two parts, opened; the tasks page with them under it", async () => {
    const app = await open("./App.tsx", { storage: SESSION, ...SIZE, network: delegateNet() });
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("id:close-thread");
    await app.waitFor("text:收到，在看");
    await app.waitFor("id:thread >> id:task-T-0001-delegates-toggle");
    await app.press("id:thread >> id:task-T-0001-delegates-toggle");
    await app.waitFor("id:thread >> id:task-T-0001-delegate-T-0007");
    await shot(app, "thread-delegates");
    await app.press("id:open-tasks");
    await app.waitFor("id:tasks-filter-all");
    await app.press("id:tasks-filter-all");
    await app.waitFor("id:taskrow-T-0001-children");
    await shot(app, "tasks-delegates");
  });

  test("members", async () => {
    const app = await open("./App.tsx", { storage: SESSION, ...SIZE, network: { ...net({ __reminders: [rem(), rem({ id: "rem_2", by_agent: null, repeat: "2h", text: "看一下告警有没有新的", paused: true })] }), [`GET ${URL}/api/v1/triggers?*`]: { body: { triggers: [
      { id: "trg_1", channel_id: "c_1", agent_id: "a_1", created_by: "u_2", kind: "schedule", text: "汇总一下昨晚的告警", repeat: "weekdays", due: T0, confirmed_by: "u_1", enabled: true, fired: T0, fires: 4, created: T0, max_per_day: 10, skipped: 2, skipped_run: 2, skip_reason: "busy", last_task: "T-0003" },
      { id: "trg_2", channel_id: "c_1", agent_id: "a_1", created_by: "u_2", kind: "pr", text: "review 这个 PR", repo: "github.com/acme/pay", confirmed_by: null, enabled: true, fired: null, fires: 0, created: T0, max_per_day: 10, skipped: 0 },
      { id: "trg_3", channel_id: "c_1", agent_id: "a_1", created_by: "u_1", kind: "schedule", text: "看主干最新一次 CI，红了就查原因", repeat: "daily", due: T0, confirmed_by: "u_1", enabled: true, fired: T0, fires: 40, created: T0, max_per_day: 24, skipped: 0,
        duty: "看住主干", readonly: true, check_cmd: "gh run list -b main -L 1 --json conclusion", recent: { nochange: 31, nothing: 9, spoke: 1 } },
      { id: "trg_4", channel_id: "c_1", agent_id: "a_1", created_by: "u_1", kind: "schedule", text: "看过期的依赖和没人管的分支", repeat: "weekly", due: T0, confirmed_by: "u_1", enabled: true, fired: T0, fires: 2, created: T0, max_per_day: 10, skipped: 0,
        duty: "看住主干", readonly: true, recent: { spoke: 1 } },
    ] } }, [`GET ${URL}/api/v1/triggers/runs?*`]: { body: { runs: [
      { trigger_id: "trg_3", at: T0, outcome: "nothing", note: "主干是绿的", task_id: "T-0012" },
      { trigger_id: "trg_4", at: T0 - 3_600_000, outcome: "spoke", note: "有 3 个依赖过期了，见报告", task_id: "T-0011" },
      { trigger_id: "trg_3", at: T0 - 7_200_000, outcome: "failed", note: "运行失败：仓库打不开", task_id: "T-0010" },
    ] } } } });
    await app.waitFor("id:channel-members");
    await app.press("id:channel-members");
    await app.waitFor("id:trigger-trg_2");
    await shot(app, "members");
    await app.scroll("id:channel-temporary", 900); // the channel's 临时 duties: reminders that bring an agent back
    await app.waitFor("id:temporary-rem_2");
    await shot(app, "members-temporary");
    await app.scroll("id:channel-temporary", -900);
    await app.press("id:duty-trg_3-history");
    await app.waitFor("id:duty-trg_3-runs");
    await shot(app, "members-duty");
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

  test("workpanel: plan checklist, Markdown output viewer, and channel files tab", async () => {
    const docOut = {
      id: "out_1",
      kind: "file" as const,
      name: "report.md",
      title: "report.md",
      mime: "text/markdown",
      size: 256,
      version: 2,
      versions: [{ version: 1, size: 180, created: T0 }, { version: 2, size: 256, created: T0 + 60_000 }],
      task_id: "T-0001",
      thread_id: "msg_1",
      message_id: "msg_2",
      updated: T0 + 60_000,
    };
    const plannedTask = {
      ...tasks[0]!,
      plan: [
        { text: "读取慢查询日志与索引现状", status: "done" },
        { text: "在预发验证复合索引执行计划", status: "in_progress" },
        { text: "整理压测前后 P99 对比文档", status: "pending" },
      ],
      outputs: [docOut],
    };
    const app = await open("./App.tsx", {
      storage: { ...SESSION, "hub.lang": "zh" },
      ...SIZE,
      network: {
        ...server(newLog(), {
          [`GET ${URL}/api/v1/machines`]: { body: { machines: [box] } },
          [`GET ${URL}/api/v1/agents`]: { body: { agents: [acha] } },
          [`GET ${URL}/api/v1/channels/c_1/messages?*`]: { body: { messages: [m1, { ...messages[1]!, outputs: [docOut] }, messages[2]!], more: false } },
          [`GET ${URL}/api/v1/messages/msg_1/thread`]: { body: { root: m1, replies: [{ ...r1, outputs: [docOut] }] } },
          [`GET ${URL}/api/v1/outputs/out_1/link`]: { body: { url: "/api/v1/outputs/out_1/content?v=2&exp=1&sig=x" } },
          [`GET ${URL}/api/v1/outputs/out_1/content?*`]: { body: "# 慢查询排查报告\n\n- 原因：`orders` 表缺少 `(user_id, created_at)` 索引\n- 预期：P99 降至 160ms" },
        }, [plannedTask, ...tasks.slice(1)]),
      },
    });
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("id:work-tab-plan");
    await app.waitFor("text:收到，在看");
    await app.press("id:work-tab-plan");
    await app.waitFor("id:work-plan-ratio");
    await shot(app, "workpanel-plan");
    await app.press("id:work-tab-outputs");
    await app.waitFor("id:work-viewer-out_1");
    await app.waitFor("text:慢查询排查报告");
    await shot(app, "workpanel-outputs");
    await app.press("id:close-thread");
    await app.press("id:channel-tab-files");
    await app.waitFor("id:channel-file-out_1");
    await shot(app, "channel-files");
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

  test("triage", async () => {
    const app = await open("./App.tsx", { storage: SESSION, ...SIZE, network: net() });
    await app.waitFor("id:open-inbox");
    await app.press("id:open-inbox");
    await app.waitFor("id:triage-detail");
    await shot(app, "triage");
  });

  test("palette", async () => {
    const app = await start();
    await app.waitFor("id:team-composer");
    await app.keyboard.press("mod+k");
    await app.waitFor("id:palette");
    await shot(app, "palette");
  });

  test("context-menu", async () => {
    const app = await start();
    await app.waitFor("id:channel-pay");
    await app.rightClick("id:channel-pay");
    await app.waitFor("id:ctx-open");
    await shot(app, "context-menu");
  });

  test("inbox-proposals", async () => {
    const prop = (id: string, num: number, title: string, extra: object = {}) => ({ id, channel_id: "c_1", agent_id: "a_1", task_id: "T-0009", title,
      why: "巡查时看到：lodash 4.17.20 有一个已知的原型污染问题，3 个服务在用", plan: "升级到 4.17.21，跑全部测试，锁文件一起提交", key: id, urgent: false, state: "open", num, created: T0, ...extra });
    const app = await open("./App.tsx", { storage: SESSION, ...SIZE, network: net({ __proposals: [
      { id: "pb_1", at: T0, urgent: false, proposals: [prop("p1", 1, "升级 lodash 到 4.17.21"), prop("p2", 2, "删掉 3 个两个月没动的分支"), prop("p3", 3, "给 /orders 补上分页的测试")] },
      { id: "pb_2", at: T0, urgent: true, proposals: [prop("p4", 1, "主干 CI 红了，今天的发版会被挡住", { urgent: true })] },
    ] }) });
    await app.waitFor("id:open-inbox");
    await app.press("id:open-inbox");
    await app.waitFor("id:proposals-pb_1");
    await app.press("id:proposal-p1-more");
    await shot(app, "inbox-proposals");
  });

  test("settings", async () => {
    const app = await start();
    await app.waitFor("id:open-tasks");
    await app.keyboard.press("mod+,");
    await app.waitFor("id:settings");
    await app.waitFor("id:preferences-input");
    await shot(app, "settings-account");
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
    expect(app.shows("id:machine-m_1-checkpoint-files")).toBe(true); // the team machine's switch, for an admin
    await shot(app, "settings-machines");
  });

  test("settings-login-code", async () => {
    const app = await open("./App.tsx", {
      storage: { ...SESSION, "hub.lang": "zh" }, ...SIZE,
      network: { ...net(),
        [`POST ${URL}/api/v1/login-codes`]: { body: { code: "METE-8YG3", path: "/login/METE-8YG3", expires: Date.now() + 900_000 } },
        [`GET ${URL}/api/v1/sessions`]: { body: { sessions: [{ id: "aaaaaaaaaaaaaaaa", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Remi", created: T0, last_seen: T0, current: true }] } } },
    });
    await app.waitFor("id:open-tasks");
    await app.press("id:user-menu");
    await app.press("id:menu-login-code");
    await app.press("id:login-code-create");
    await app.waitFor("id:login-code-qr");
    await app.scroll("id:login-code-qr", 300);
    await shot(app, "settings-login-code");
  });

  test("signin-ask", async () => {
    const app = await open("./App.tsx", { ...SIZE, storage: { "hub.lang": "zh" }, network: net() });
    await app.press("id:signin-mode-ask");
    await app.waitFor("id:ask-note");
    await shot(app, "signin-ask");
  });

  test("phone sign-in: scan first, the other ways a page each", async () => {
    // headless runs as iOS (扫码登录 first); the web screenshot has no camera, so the code comes first there
    const app = await open("./App.tsx", { width: 390, height: 844, storage: { "hub.lang": "zh" }, network: net() });
    await app.waitFor("id:signin-home");
    await shot(app, "phone-signin");
    await app.press("id:signin-code");
    await app.waitFor("id:team-code");
    await shot(app, "phone-signin-code");
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

// Step 3 「额度等重置」: codex on the Mac waits for its 5-hour limit, claude there needs its owner (out of credit), and
// the first task waits in its session for the reset, with 「现在就试」.
const RESET = Date.now() + 3 * 3_600_000;
const quotaBox = { ...box, runtimes: ["codex", "claude"],
  runtime_info: [{ name: "codex", version: "0.80.0", installed: true, logged_in: true }, { name: "claude", version: "2.1.322", installed: true, logged_in: true }],
  runtime_status: {
    codex: { state: "quota", reason: "quota", text: "等额度恢复", note: "You’ve hit your usage limit. Try again at 2:30 PM.", until: RESET, next_at: RESET + 90_000, since: T0, at: T0 },
    claude: { state: "blocked", reason: "billing", text: "需要你处理：余额不足", note: "Credit balance is too low", since: T0, at: T0 },
  } };
const quotaTask = task({ id: "T-0001", state: "waiting", tracked: true, title: "看下慢查询", created_by: "u_1", session: "thr_1",
  wait: { how: "quota", expect: RESET, next_at: RESET + 90_000, deadline: 0, since: T0, machine: "m_1", runtime: "codex", note: "You’ve hit your usage limit. Try again at 2:30 PM." } });
const quotaNet = () => server(newLog(), {
  [`GET ${URL}/api/v1/machines`]: { body: { machines: [quotaBox] } },
  [`GET ${URL}/api/v1/agents`]: { body: { agents: [acha] } },
  [`GET ${URL}/api/v1/channels/c_1/messages?*`]: { body: { messages, more: false } },
  [`GET ${URL}/api/v1/messages/msg_1/thread`]: { body: { root: m1, replies: [r1] } },
}, [quotaTask, ...tasks.slice(1)]);

describe("quota", () => {
  test("a task waits for its runtime's quota; the machine card says how each runtime is", async () => {
    const app = await open("./App.tsx", { storage: SESSION, ...SIZE, network: quotaNet() });
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("id:close-thread");
    await app.waitFor("text:收到，在看");
    await app.waitFor("id:thread >> id:task-T-0001-retry");
    await shot(app, "thread-quota");
    await app.keyboard.press("mod+,");
    await app.waitFor("id:settings");
    await app.press("id:settings-nav-machines");
    await app.waitFor("id:machine-m_1-runtime-codex-status-info");
    await shot(app, "settings-machines-quota");
  });

  test("on a phone", async () => {
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 390, height: 844, network: quotaNet() });
    await app.waitFor("id:tab-chat");
    await app.press("id:tab-chat");
    await app.waitFor("id:channel-pay");
    await app.press("id:channel-pay");
    await app.waitFor("id:thread-msg_1");
    await app.press("id:thread-msg_1");
    await app.waitFor("id:task-T-0001-retry");
    await shot(app, "phone-quota-thread");
  });
});

// An agent on two of its owner's computers: the first waits for its quota, so new work goes to the second.
const mine = { ...quotaBox, team: false, name: "张伟的 Mac", git: [] };
const desk = { ...mac, id: "m_3", name: "张伟的台式机", runtime_info: [{ name: "codex", version: "0.80.0", installed: true, logged_in: true }] };
const laptop = { ...mac, id: "m_4", name: "张伟的笔记本", online: false, runtime_info: [{ name: "codex", version: "0.80.0", installed: true, logged_in: true }] };
const poolNet = () => server(newLog(), {
  [`GET ${URL}/api/v1/machines`]: { body: { machines: [mine, desk, laptop] } },
  [`GET ${URL}/api/v1/agents`]: { body: { agents: [{ ...acha, machine_id: mine.id, machines: [mine.id, desk.id] }] } },
});

describe("pool", () => {
  test("an agent's computers, in order, with whether each can take work", async () => {
    const app = await open("./App.tsx", { storage: SESSION, ...SIZE, network: poolNet() });
    await app.waitFor("id:open-tasks");
    await app.keyboard.press("mod+,");
    await app.waitFor("id:settings");
    await app.press("id:settings-nav-agents");
    await app.waitFor(`id:agent-acha-machine-${desk.id}`);
    expect(app.shows(`id:agent-acha-machine-${laptop.id}-up`)).toBe(false); // not ticked: not in the order
    await shot(app, "settings-agent-machines");
  });

  test("on a phone", async () => {
    const app = await open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, width: 390, height: 844, network: poolNet() });
    await app.waitFor("id:tab-me");
    await app.press("id:tab-me");
    await app.waitFor("id:settings-nav-agents");
    await app.press("id:settings-nav-agents");
    await app.waitFor("id:agent-acha");
    await app.press("id:agent-acha");
    await app.waitFor(`id:agent-acha-machine-${desk.id}`);
    await shot(app, "phone-agent-machines");
  });
});

// Phones: the tab bar's four tabs, a channel and its thread, one agent's page.
const PHONE = { width: 390, height: 844 };
const phone = () => open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, ...PHONE, network: net() });

describe("phone", () => {
  test("messages tab, a channel, a thread", async () => {
    const app = await phone();
    // something waits for me, so the phone opens on 待你决定; 消息 is the next tab
    await app.waitFor("text:写周报");
    await shot(app, "phone-0-launch");
    await app.press("id:tab-chat");
    await app.waitFor("id:channel-pay");
    expect(app.shows("id:open-inbox")).toBe(false); // a tab on phones
    await shot(app, "phone-1-messages");
    await app.press("id:channel-pay");
    await app.waitFor("text:今天下午三点发版，大家注意一下");
    expect(app.shows("id:tab-me")).toBe(false);
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
    expect(app.shows("id:tab-me")).toBe(false);
    await app.press("id:agent-acha");
    await app.waitFor("text:阿查");
    expect(app.shows("id:agent-acha")).toBe(false); // the page, not the list beside it
    await shot(app, "phone-7-agent");
    await app.press("id:back");
    await app.waitFor("id:agent-acha");
    await app.press("id:back");
    await app.waitFor("id:tab-me");
  });
});

// A private channel (step 1, personal space): 张伟's own project with @acha; 王磊's @helper takes the whole team's work,
// his @bei only his channels'. And an agent's owner who is not in someone's private channel: a row without its content.
const home = { id: "c_3", slug: "p-1a2b3c4d", name: "私房菜", topic: "周末的菜谱整理", archived: false, created: T0, private: true, created_by: "u_1",
  members: [{ kind: "user", id: "u_1" }, { kind: "agent", id: "a_1" }], last_seq: 1 };
/** 张伟's private chat with his @acha: a request without an @, and its answer. */
const chat = { id: "c_4", slug: "p-4d4d4d4d", name: "acha", topic: "", archived: false, created: T0, private: true, created_by: "u_1", dm_agent: "a_1",
  members: [{ kind: "user", id: "u_1" }, { kind: "agent", id: "a_1" }], last_seq: 2 };
const privNet = () => ({
  ...net(),
  [`GET ${URL}/api/v1/channels`]: { body: { channels: [pay, ops, home, chat] } },
  [`GET ${URL}/api/v1/channels/c_4/messages?*`]: { body: { messages: [
    msg({ id: "msg_d1", seq: 1, channel_id: "c_4", author: { kind: "user", id: "u_1" }, text: "帮我把下周的会议整理成一张表", mentions: [{ kind: "agent", id: "a_1", handle: "acha" }] }),
    msg({ id: "msg_d2", seq: 2, channel_id: "c_4", author: { kind: "agent", id: "a_1" }, text: "好的，整理好放在 out/meetings.md 了。", mentions: [] })], more: false } },
  [`GET ${URL}/api/v1/agents`]: { body: { agents: [acha, { ...acha, id: "a_2", handle: "bei", name: "贝", owner_id: "u_2", machine_id: null, machines: [] },
    { ...acha, id: "a_3", handle: "helper", name: "帮手", owner_id: "u_2", machine_id: "m_2", machines: ["m_2"], dispatch: "team" }] } },
  [`GET ${URL}/api/v1/machines`]: { body: { machines: [box, { ...mac, id: "m_2", owner_id: "u_2", name: "王磊的 Mac" }] } },
  [`GET ${URL}/api/v1/channels/c_3/messages?*`]: { body: { messages: [msg({ id: "msg_p1", seq: 1, channel_id: "c_3", author: { kind: "user", id: "u_1" }, text: "@acha 把这周末的菜谱整理成一张表", mentions: [{ kind: "agent", id: "a_1", handle: "acha" }] })], more: false } },
  [`GET ${URL}/api/v1/inbox`]: { body: { tasks: [task({ id: "T-0009", channel_id: "", thread_id: "", title: "", body: "", created_by: "u_2", state: "pending", tracked: true, redacted: true, updated: Date.now() })] } },
});

describe("private", () => {
  const privStart = (size: { width: number; height: number; platform?: "macos" } = SIZE) => open("./App.tsx", { storage: { ...SESSION, "hub.lang": "zh" }, ...size, network: privNet() });

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

  test("private-dm: a chat with one's own agent, and a first one with someone else's", async () => {
    const app = await privStart();
    await app.waitFor("id:side-agent-acha");
    await app.press("id:side-agent-acha");
    await app.waitFor("text:好的，整理好放在 out/meetings.md 了。");
    await shot(app, "private-dm");
    await app.press("id:side-chat-new");
    await app.waitFor("id:side-chat-new-helper");
    await shot(app, "private-dm-more");
    await app.press("id:side-chat-new-helper");
    await app.waitFor("id:dm-draft-helper");
    await shot(app, "private-dm-new");
  });

  test("mention-picker: the channel's agents, team-wide ones that join when called, then the channel's people", async () => {
    const app = await privStart();
    await app.waitFor("id:team-composer");
    await app.type("id:team-composer", "@");
    await app.waitFor("id:mention-picker");
    await shot(app, "mention-picker");
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
    await app.waitFor("id:tab-chat");
    await app.press("id:tab-chat");
    await app.waitFor("id:channel-p-1a2b3c4d");
    await shot(app, "phone-private-1-list");
    await app.press("id:channel-p-1a2b3c4d");
    await app.waitFor("text:@acha 把这周末的菜谱整理成一张表");
    await shot(app, "phone-private-2-channel");
  });
});
