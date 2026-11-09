import { describe, expect, test } from "nsh/test";
import { alertId, FRESH_MS, mentionAlert, parseAlertId, reminderAlert, taskAlert } from "./team/notify";
import type { Message, Reminder, Task } from "./team/api";
import { msg, task } from "./fixtures";

const NOW = 1_800_000_000_000;
const rem = (over: Partial<Reminder> = {}): Reminder => ({
  id: "rem_1", by: "u_1", target: { kind: "user", id: "u_1" }, channel_id: "c_1", thread_id: "msg_1", message_id: "msg_1",
  text: "看一下慢查询", due: NOW, repeat: "", created: NOW - 60_000, fired: NOW - 1000, seen: null, done: true, ...over,
});

describe("system notifications", () => {
  test("a reminder that just went off for me notifies, once per firing", () => {
    const a = reminderAlert(rem(), "u_1", NOW)!;
    expect(a.body).toBe("看一下慢查询");
    expect(parseAlertId(alertId(a))).toEqual({ channelId: "c_1", threadId: "msg_1" });
    expect(reminderAlert(rem({ fired: NOW + 5000 }), "u_1", NOW + 6000)!.key).not.toBe(a.key);
    expect(reminderAlert(rem(), "u_2", NOW)).toBe(null); // someone else's
    expect(reminderAlert(rem({ seen: NOW }), "u_1", NOW)).toBe(null); // already seen
    expect(reminderAlert(rem({ fired: NOW - FRESH_MS - 1 }), "u_1", NOW)).toBe(null); // old news
  });

  test("a task in 待你决定 says what it needs, and notifies again when it needs something else", () => {
    const t = { ...task({ state: "pending", updated: NOW - 1000 }) } as Task;
    const a = taskAlert(t, "支付后端", NOW)!;
    expect(a.title).toMatch(/OK to start|确认开工/);
    expect(a.body).toContain("#支付后端 · T-0001");
    expect(taskAlert({ ...t, state: "review" }, "支付后端", NOW)!.key).not.toBe(a.key);
    expect(taskAlert({ ...t, updated: NOW - FRESH_MS - 1 }, "支付后端", NOW)).toBe(null);
  });

  test("an @mention of me from someone else notifies; my own and others' don't", () => {
    const m = msg({ id: "msg_9", author: { kind: "agent", id: "a_1" }, text: "@zw 好了", mentions: [{ kind: "user", id: "u_1", handle: "zw" }], created: NOW - 1000 }) as Message;
    expect(mentionAlert(m, "u_1", "acha", "支付后端", NOW)!.title).toBe("acha · #支付后端");
    expect(mentionAlert(m, "u_2", "acha", "支付后端", NOW)).toBe(null);
    expect(mentionAlert({ ...m, author: { kind: "user", id: "u_1" } }, "u_1", "zw", "支付后端", NOW)).toBe(null);
    expect(mentionAlert({ ...m, created: NOW - FRESH_MS - 1 }, "u_1", "acha", "支付后端", NOW)).toBe(null);
  });
});

describe("reminders said in words", () => {
  test("relative times in Chinese and English become /remind commands", async () => {
    const { naturalRemind } = await import("./team/reminders");
    expect(naturalRemind("2分钟后提醒我。")).toBe("2分钟 2分钟后提醒我。");
    expect(naturalRemind("2分钟之后提醒我一下，看下构建")).toBe("2分钟 看下构建");
    expect(naturalRemind("半小时后提醒我 交周报")).toBe("30分钟 交周报");
    expect(naturalRemind("两个小时后提醒 @acha 发版")).toBe("2小时 @acha 发版");
    expect(naturalRemind("提醒我10分钟后 开会")).toBe("10分钟 开会");
    expect(naturalRemind("remind me in 5 minutes to call Bob")).toBe("5m call Bob");
    expect(naturalRemind("Remind me in an hour")).toBe("1h Remind me in an hour");
  });
  test("anything else stays a message", async () => {
    const { naturalRemind } = await import("./team/reminders");
    expect(naturalRemind("@cindy 2分钟之后提醒我一下")).toBe(null); // the agent's work
    expect(naturalRemind("2分钟后提醒我 叫 @cindy 看看")).toBe(null);
    expect(naturalRemind("我2分钟后提醒你")).toBe(null);
    expect(naturalRemind("明天提醒我")).toBe(null);
  });
});
