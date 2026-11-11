// The people around a task (as in the design "Remi 任务视图 v2"): who asked for it, which agent does it and whose
// agent that is, and whom it waits for right now. The task lives in its channel; these decide whose views it shows in.
import { L } from "../i18n";
import { channelLabel, takerOf, type Task, type Team } from "./api";
import type { Tone } from "./status";

/** Whom the task waits for now, in a few words ("waits for your acceptance", "waits for zc to confirm"), and
 * whether that is me. null: it waits for nobody (it runs, queues, waits for an outside result, or ended). */
export function waitsOn(t: Team, task: Task): { label: string; mine: boolean; tone: Tone } | null {
  const me = t.me();
  const agent = t.agents().find((a) => a.id === task.agent_id);
  const owner = t.users().find((u) => u.id === agent?.owner_id);
  const taker = t.users().find((u) => u.id === takerOf(task));
  const isMe = (id?: string) => !!me && id === me.id;
  const by = (id: string | undefined, name: string | undefined, mine: [string, string], other: (n: string) => [string, string], tone: Tone) =>
    isMe(id) ? { label: L(...mine), mine: true, tone } : { label: L(...other(name ?? "?")), mine: false, tone };
  switch (task.state) {
    case "pending":
      return by(agent?.owner_id, owner?.name, ["Waits for your OK", "等你确认"], (n) => [`Waits for ${n}’s OK`, `等 ${n} 确认`], "warn");
    case "needs_decision":
      if (task.decision?.kind === "align") return by(takerOf(task), taker?.name, ["Waits for you to align", "等你对齐"], (n) => [`Waits for ${n} to align`, `等 ${n} 对齐`], "warn");
      return by(takerOf(task), taker?.name, ["Waits for your decision", "等你决定"], (n) => [`Waits for ${n} to decide`, `等 ${n} 决定`], "warn");
    case "review":
      return by(takerOf(task), taker?.name, ["Waits for your acceptance", "等你验收"], (n) => [`Waits for ${n} to accept`, `等 ${n} 验收`], "accent");
    case "blocked":
    case "failed": {
      const mine = isMe(task.created_by) || isMe(agent?.owner_id);
      return { label: task.state === "blocked" ? L("Blocked", "被阻塞") : L("Run failed", "执行失败"), mine, tone: "danger" };
    }
  }
  return null;
}

/** Tasks I have to act on now (my 待你决定, as far as tasks go). */
export const needsMe = (t: Team, task: Task) => !!waitsOn(t, task)?.mine;

/** Tasks that concern me: I asked for it, one of my agents does it, or it waits for me. */
export function concernsMe(t: Team, task: Task): boolean {
  const me = t.me();
  if (!me) return false;
  if (task.created_by === me.id) return true;
  if (t.agents().some((a) => a.id === task.agent_id && a.owner_id === me.id)) return true;
  return needsMe(t, task);
}

/** The short live line of a card: how long it has run, or what it waits for. */
export function liveLine(task: Task): string {
  const mins = (ms: number) => {
    const m = Math.max(1, Math.round(ms / 60_000));
    return m < 60 ? L(`${m} min`, `${m} 分钟`) : L(`${Math.floor(m / 60)} h`, `${Math.floor(m / 60)} 小时`);
  };
  switch (task.state) {
    case "running": return mins(Date.now() - task.created);
    case "queued": return L("Queued", "排队中");
    case "waiting": return L("Waiting for an outside result", "等外部结果");
  }
  return "";
}

/** The task as the team writes it: "#channel · T-0002" (the channel left out where it goes without saying). */
export function taskRef(t: Team, task: Task, withChannel = true): string {
  const c = withChannel ? t.channels().find((x) => x.id === task.channel_id) : undefined;
  return c ? `${channelLabel(c)} · ${task.id}` : task.id;
}
