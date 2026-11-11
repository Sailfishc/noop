// Evidence on a delivered task (design 「证据」): for each acceptance criterion, how the agent checked it. The server
// marks what the agent left out as unstated; nothing is hidden and nothing is refused.
import { Image, signal, View } from "nsh";
import { L } from "../i18n";
import { ListRow, Tag, Txt } from "../ui";
import type { Evidence, Task, Team } from "./api";

/** A task's acceptance criteria, one per non-empty line, bullets and numbers off (server: criteriaOf). */
export const criteriaOf = (acceptance?: string) =>
  (acceptance ?? "").split("\n").map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)、]|[（(]?\d+[）)])\s*/, "").trim()).filter(Boolean);

const HOW: Record<Evidence["how"], { label: () => string; tone: "up" | "accent" | "warn" | "danger" }> = {
  ran: { label: () => L("verified", "已验证"), tone: "up" },
  saw: { label: () => L("looked", "看过"), tone: "accent" },
  not_verified: { label: () => L("not verified", "未验证"), tone: "warn" },
  unstated: { label: () => L("not stated", "未说明"), tone: "danger" },
};
const checked = (e: Evidence) => e.how === "ran" || e.how === "saw";

/** "4 条标准：3 条已验证，1 条未验证", and whether any is not verified or not stated. */
export function evidenceLine(t: Task): { text: string; gap: boolean } | null {
  const ev = t.evidence ?? [];
  if (!ev.length) return null;
  const ok = ev.filter(checked).length, not = ev.filter((e) => e.how === "not_verified").length, unstated = ev.filter((e) => e.how === "unstated").length;
  const parts = [L(`${ok} verified`, `${ok} 条已验证`), not ? L(`${not} not verified`, `${not} 条未验证`) : "", unstated ? L(`${unstated} not stated`, `${unstated} 条未说明`) : ""].filter(Boolean);
  return { text: L(`${ev.length} criteria: ${parts.join(", ")}`, `${ev.length} 条标准：${parts.join("，")}`), gap: ok < ev.length };
}

/** The overview line under a delivered task's title. */
export function EvidenceLine(props: { task: Task }) {
  return (
    <If when={evidenceLine(props.task)}>
      {(l) => <Txt testID={`task-${props.task.id}-evidence`} variant="caption" weight="semibold" tone={l().gap ? "warn" : "muted"}>{l().text}</Txt>}
    </If>
  );
}

/** Each criterion with how it was checked; press one for its proof (and its screenshot, when it has one). */
export function EvidenceList(props: { team: Team; task: Task }) {
  const open = signal(-1);
  const criteria = () => criteriaOf(props.task.acceptance);
  return (
    <View testID={`task-${props.task.id}-evidence-list`} style={{ gap: 2 }}>
      <Each of={props.task.evidence ?? []} key={(e) => String(e.criterion)}>
        {(e) => (
          <View style={{ gap: 4 }}>
            <ListRow
              testID={`task-${props.task.id}-evidence-${e().criterion}`}
              title={`${e().criterion}. ${criteria()[e().criterion - 1] ?? ""}`}
              left={<Tag label={HOW[e().how]?.label() ?? e().how} tone={HOW[e().how]?.tone} />}
              selected={open() === e().criterion}
              onPress={() => open.set(open() === e().criterion ? -1 : e().criterion)}
            />
            <If when={open() === e().criterion}>
              <View style={{ gap: 6, paddingHorizontal: 8, paddingBottom: 6 }}>
                <Txt variant="caption" mono tone={e().proof ? "default" : "faint"}>{e().proof || L("The agent said nothing about this one.", "Agent 没有说明这一条。")}</Txt>
              </View>
            </If>
            <If when={e().file ? props.task.outputs?.find((o) => o.kind === "file" && o.name === e().file && (o.mime ?? "").startsWith("image/")) : null}>
              {(o) => <View style={{ paddingHorizontal: 8, paddingBottom: 6 }}><Shot team={props.team} id={o().id} label={o().title} /></View>}
            </If>
          </View>
        )}
      </Each>
    </View>
  );
}

function Shot(props: { team: Team; id: string; label: string }) {
  const url = signal<string | null>(null);
  void props.team.outputLink(props.id).then((u) => url.set(u));
  return (
    <If when={url()}>
      {(u) => <Image testID={`evidence-shot-${props.id}`} src={u()} accessibilityLabel={props.label} style={{ width: 240, height: 140, objectFit: "contain" }} />}
    </If>
  );
}
