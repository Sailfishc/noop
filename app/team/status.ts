// What people see of a task: one of five statuses (as in Raft) and, when a person must act, a "needs you" mark. The
// run's own state (pending, queued, running, waiting, needs_decision, blocked, failed, review, done, closed) stays
// underneath for the machines; the server maps it the same way (statusOf in teamtasks.go).
import { L } from "../i18n";
import type { TaskState } from "./api";

export type Status = "todo" | "in_progress" | "in_review" | "done" | "closed";
export type Needs = "" | "confirm" | "decide" | "unblock" | "retry";

export const STATUSES: Status[] = ["todo", "in_progress", "in_review", "done", "closed"];

export function statusOf(state: TaskState | string): { status: Status; needs: Needs } {
  switch (state) {
    case "pending": return { status: "todo", needs: "confirm" };
    case "needs_decision": return { status: "in_progress", needs: "decide" };
    case "blocked": return { status: "in_progress", needs: "unblock" };
    case "failed": return { status: "in_progress", needs: "retry" };
    case "review": return { status: "in_review", needs: "" };
    case "done": return { status: "done", needs: "" };
    case "closed": return { status: "closed", needs: "" };
  }
  return { status: "in_progress", needs: "" };
}

export type Tone = "accent" | "warn" | "danger" | "up" | "muted";

export const STATUS: Record<Status, { label: () => string; tone: Tone }> = {
  todo: { label: () => L("To do", "待办"), tone: "muted" },
  in_progress: { label: () => L("In progress", "进行中"), tone: "accent" },
  in_review: { label: () => L("In review", "待验收"), tone: "accent" },
  done: { label: () => L("Done", "完成"), tone: "up" },
  closed: { label: () => L("Closed", "关闭"), tone: "muted" },
};

/** The "needs you" mark: what a person has to do. */
export const NEEDS: Record<Exclude<Needs, "">, { label: () => string; tone: Tone }> = {
  confirm: { label: () => L("Needs its owner’s OK", "等主人确认"), tone: "warn" },
  decide: { label: () => L("Needs a decision", "等你决定"), tone: "warn" },
  unblock: { label: () => L("Blocked", "被阻塞"), tone: "danger" },
  retry: { label: () => L("Run failed", "执行失败"), tone: "danger" },
};
