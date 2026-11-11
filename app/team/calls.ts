// How often a task needed a person, and for what (server: calls.go): the three moments people are needed at (align,
// decide, accept) and everything outside them, the number to bring down.
import { L } from "../i18n";
import type { Call, CallClass, CallStats } from "./api";

export const CALL_CLASSES: { key: CallClass; label: () => string }[] = [
  { key: "align", label: () => L("align", "对齐") },
  { key: "decide", label: () => L("decide", "拍板") },
  { key: "accept", label: () => L("accept", "验收") },
  { key: "outside", label: () => L("outside the three", "三个时刻之外") },
];

const count = (calls: Call[], k: CallClass) => calls.filter((c) => c.class === k).length;

/** "对齐 1，拍板 1，验收 1" for the three moments that have any. */
export function momentsLine(by: Partial<Record<CallClass, number>>): string {
  return CALL_CLASSES.filter((c) => c.key !== "outside" && by[c.key]).map((c) => `${c.label()} ${by[c.key]}`).join(L(", ", "，"));
}

/** A task's calls for one line of its facts: on me when it needed me, else on anyone. */
export function taskCalls(calls: Call[] | null | undefined, me: string | undefined) {
  const all = calls ?? [];
  const mine = all.filter((c) => c.who === me);
  const shown = mine.length ? mine : all;
  const by: Partial<Record<CallClass, number>> = {};
  for (const c of CALL_CLASSES) by[c.key] = count(shown, c.key);
  return { mine: mine.length > 0, total: shown.length, outside: by.outside ?? 0, moments: momentsLine(by) };
}

/** "12 次，来自 5 个任务，平均每个任务 2.4 次". */
export function statsLine(s: CallStats): string {
  if (!s.calls) return L("none yet", "还没有");
  const cards = s.cards ?? 0;
  const mean = ((s.calls - cards) / Math.max(1, s.tasks)).toFixed(1);
  return cards
    ? L(`${s.calls} from ${s.tasks} tasks and ${cards} cards of proposals, ${mean} per task`, `${s.calls} 次，来自 ${s.tasks} 个任务和 ${cards} 张提案卡片，平均每个任务 ${mean} 次`)
    : L(`${s.calls} from ${s.tasks} tasks, ${mean} per task`, `${s.calls} 次，来自 ${s.tasks} 个任务，平均每个任务 ${mean} 次`);
}

/** "3 次（25%）". */
export function outsideLine(s: CallStats): string {
  if (!s.calls) return L("none yet", "还没有");
  return L(`${s.outside} (${Math.round((100 * s.outside) / s.calls)}%)`, `${s.outside} 次（${Math.round((100 * s.outside) / s.calls)}%）`);
}
