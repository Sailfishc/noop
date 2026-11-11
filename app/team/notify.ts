// System notifications (Notification Center on macOS, and wherever NSH shows them): a reminder that went off for me,
// a task that comes to 待你决定, an @mention of me. The count of 待你决定 goes on the app's icon (the Dock). On by
// default; switched off in Settings › General, kept on this device. Pressing one opens its channel and thread.
//
// Only what is fresh notifies (FRESH_MS): opening the app after a weekend shows 待你决定, it doesn't replay it.
import { cleanup, effect, Notifications, platform, signal, Storage, untracked, type NotificationPermission } from "nsh";
import { focusedWindow, isAvailable as hasWindow } from "nsh/desktop";
import { L } from "../i18n";
import { reminderUp, type Message, type Reminder, type Task, type Team } from "./api";

export const NOTIFY_KEY = "team.notify";
/** Older than this, it's news no more: no notification. */
export const FRESH_MS = 5 * 60_000;

/** System notifications are on (reactive). */
export const notifyOn = signal(true);
/** What the system lets the app do (reactive; "default" until asked). */
export const notifyPermission = signal<NotificationPermission>("default");

/** One notification to show: `key` names what it is about (a later one with the same key replaces it). */
export type Alert = { key: string; title: string; body: string; channelId: string; threadId: string | null };

/** The notification's id carries where a press goes, so a press that starts the app anew still knows. */
export const alertId = (a: Alert) => [a.key, a.channelId, a.threadId ?? ""].join("|");
export function parseAlertId(id: string): { channelId: string; threadId: string | null } | null {
  const [, channelId, threadId] = id.split("|");
  return channelId ? { channelId, threadId: threadId || null } : null;
}

/** A reminder that just went off for me. */
export function reminderAlert(r: Reminder, meId: string | undefined, now: number): Alert | null {
  if (!reminderUp(r, meId) || !r.fired || now - r.fired > FRESH_MS) return null;
  return { key: `rem:${r.id}:${r.fired}`, title: L("Reminder", "提醒"), body: r.text, channelId: r.channel_id, threadId: r.thread_id };
}

const NEED: Record<string, () => string> = {
  pending: () => L("Waits for your OK to start", "等你确认开工"),
  needs_decision: () => L("Needs your decision", "等你做决定"),
  review: () => L("Ready for you to accept", "等你验收"),
  blocked: () => L("Blocked, needs you", "卡住了，需要你"),
  failed: () => L("Run failed, needs you", "执行失败，需要你"),
};

/** A task that just came to 待你决定 (or came to it again, needing something else). */
export function taskAlert(t: Task, channelName: string | undefined, now: number): Alert | null {
  if (now - t.updated > FRESH_MS) return null;
  const where = channelName ? `#${channelName} · ${t.id}` : t.id;
  return {
    key: `task:${t.id}:${t.state}`,
    title: NEED[t.state]?.() ?? L("Waiting for you", "待你决定"),
    body: t.redacted ? `${t.id}  ${L("in a private channel", "在一个私有频道里")}` : `${where}  ${t.title}`,
    channelId: t.channel_id, threadId: t.thread_id,
  };
}

/** A new message that @s me, from someone else. */
export function mentionAlert(m: Message, meId: string | undefined, author: string, channelName: string | undefined, now: number): Alert | null {
  if (!meId || m.edited || now - m.created > FRESH_MS) return null;
  if (m.author.kind === "user" && m.author.id === meId) return null;
  if (!(m.mentions ?? []).some((x) => x.kind === "user" && x.id === meId)) return null;
  return {
    key: `msg:${m.id}`,
    title: channelName ? `${author} · #${channelName}` : author,
    body: m.text.length > 200 ? `${m.text.slice(0, 200)}…` : m.text,
    channelId: m.channel_id, threadId: m.thread_id,
  };
}

/** Reads the switch kept on this device, and what the system allows. */
export async function loadNotify() {
  notifyOn.set((await Storage.getItem(NOTIFY_KEY)) !== "off");
  notifyPermission.set(await Notifications.permission().catch(() => "unavailable" as const));
}

/** The switch in Settings: on asks the system (its prompt the first time), off clears the icon's count. */
export async function setNotify(on: boolean) {
  notifyOn.set(on);
  void Storage.setItem(NOTIFY_KEY, on ? "on" : "off");
  if (on && untracked(notifyPermission) === "default") notifyPermission.set(await Notifications.requestPermission().catch(() => "unavailable" as const));
  if (!on) void Notifications.setBadge(0).catch(() => {});
}

/** Shows `team`'s notifications while it is signed in; `onOpen` takes a press to its channel and thread. */
export function watchNotifications(team: Team, onOpen: (channelId: string, threadId: string | null) => void) {
  const t = team;
  /** Ids shown, by what they are about, so one leaving 待你决定 leaves Notification Center too. */
  const shown = new Map<string, string>();
  /** The last key notified about each thing ("task:T-0001" → "task:T-0001:review"): each news once. */
  const done = new Map<string, string>();

  void loadNotify().then(async () => {
    // a desktop app may ask on its own; a browser only lets a press ask (Settings)
    if (untracked(notifyOn) && untracked(notifyPermission) === "default" && platform.os !== "web") {
      notifyPermission.set(await Notifications.requestPermission().catch(() => "unavailable" as const));
    }
  });

  const appInFront = () => (hasWindow ? untracked(focusedWindow) !== null : true);
  function show(a: Alert | null) {
    if (!a || !untracked(notifyOn)) return;
    const about = a.key.split(":").slice(0, 2).join(":");
    if (done.get(about) === a.key) return;
    done.set(about, a.key);
    const id = alertId(a);
    const before = shown.get(about);
    if (before && before !== id) void Notifications.close(before).catch(() => {});
    shown.set(about, id);
    void Notifications.show({ id, title: a.title, body: a.body }).catch(() => {});
  }
  function closeGone(prefix: string, live: Set<string>) {
    for (const about of done.keys()) if (about.startsWith(prefix) && !live.has(about)) done.delete(about);
    for (const [about, id] of shown) {
      if (about.startsWith(prefix) && !live.has(about)) {
        shown.delete(about);
        void Notifications.close(id).catch(() => {});
      }
    }
  }
  const channelName = (id: string) => untracked(t.channels).find((c) => c.id === id)?.name;

  // reminders that went off for me
  effect(() => {
    const me = t.me()?.id, now = Date.now();
    const up = t.reminders().filter((r) => reminderUp(r, me));
    for (const r of up) show(reminderAlert(r, me, now));
    closeGone("rem:", new Set(up.map((r) => `rem:${r.id}`)));
  });

  // tasks in 待你决定
  effect(() => {
    const all = t.tasks(), now = Date.now();
    const items = t.inbox().map((id) => all[id]).filter(Boolean);
    for (const x of items) show(taskAlert(x, channelName(x.channel_id), now));
    closeGone("task:", new Set(items.map((x) => `task:${x.id}`)));
  });

  // @mentions of me, unless I'm looking at that channel
  const stop = t.onLiveMessage((m) => {
    if (appInFront() && t.viewingNow() === m.channel_id) return;
    const a = m.author.kind === "user" ? t.userById(m.author.id) : t.agentById(m.author.id);
    const author = a?.name || (a ? `@${a.handle}` : L("Someone", "有人"));
    show(mentionAlert(m, untracked(t.me)?.id, author, channelName(m.channel_id), Date.now()));
  });

  // the count on the app's icon
  effect(() => {
    const me = t.me()?.id;
    const n = notifyOn() ? t.inbox().length + t.reminders().filter((r) => reminderUp(r, me)).length : 0;
    void Notifications.setBadge(n).catch(() => {});
  });

  let off: (() => void) | undefined;
  try {
    off = Notifications.on("press", ({ id }) => {
      const to = parseAlertId(id);
      if (to) onOpen(to.channelId, to.threadId);
    });
  } catch {
    /* no notifications capability: nothing to press */
  }

  cleanup(() => {
    stop();
    off?.();
    void Notifications.setBadge(0).catch(() => {});
  });
}
