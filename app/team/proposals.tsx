// Proposals in 待你决定 (design step 6 「长期职责」, 设计四): what agents propose to do comes on one card at the person's
// time (or alone, when urgent), numbered. Each has 做 / 不做; the box under the card takes "1 3" (do those, leave the
// rest) or "1 3 其余不做". 做 makes a task in the person's name with the plan as what done means.
import { signal, View } from "nsh";
import { L } from "../i18n";
import { Btn, Card, ErrorNote, Field, Noted, Tag, Txt } from "../ui";
import type { Proposal, ProposalBatch, Team } from "./api";
import { failed, time } from "./ui";

export function ProposalSection(props: { team: Team }) {
  return (
    <Each of={props.team.proposals()} key={(b) => b.id}>
      {(b) => <View style={{ maxWidth: 560 }}><ProposalCard team={props.team} batch={b()} /></View>}
    </Each>
  );
}

/** "今天的提案（3）" / "紧急提案": one card, its proposals by number, the box for numbers. */
export function ProposalCard(props: { team: Team; batch: ProposalBatch }) {
  const t = props.team;
  const b = () => props.batch;
  const text = signal("");
  const busy = signal(false);
  const error = signal("");
  const done = signal("");
  async function send() {
    if (!text().trim()) return;
    busy.set(true);
    error.set("");
    const r = await t.answerBatch(b().id, text().trim());
    busy.set(false);
    if (!r.ok) return error.set(failed(r as any));
    const made = ((r.data.done ?? []) as { num: number; task?: string; error?: string }[]);
    const bad = made.filter((x) => x.error).map((x) => `${x.num}：${x.error}`);
    if (bad.length) error.set(bad.join("；"));
    done.set(made.filter((x) => x.task).map((x) => x.task).join(L(", ", "、")));
    text.set("");
  }
  const title = () => b().urgent ? L("Urgent proposal", "紧急提案")
    : L(`Proposals (${b().proposals.length})`, `${new Date(b().at).toDateString() === new Date().toDateString() ? "今天的" : ""}提案（${b().proposals.length}）`);
  return (
    <Card testID={`proposals-${b().id}`}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Txt weight="semibold" grow>{title()}</Txt>
        <If when={b().urgent}><Tag tone="warn" label={L("urgent", "紧急")} /></If>
        <Txt variant="caption" tone="faint">{time(b().at)}</Txt>
      </View>
      <Each of={b().proposals} key={(p) => p.id}>
        {(p) => <ProposalRow team={t} proposal={p()} onError={(e) => error.set(e)} />}
      </Each>
      <If when={!b().urgent && b().proposals.length > 1}>
        <Noted
          testID={`proposals-${b().id}-numbers`}
          label={<Txt variant="caption" tone="muted">{L("Answer by number", "按编号回答")}</Txt>}
          note={L("\"1 3\" does 1 and 3 and leaves the rest on the card; \"1 3 其余不做\" also turns the rest down. Numbers only mean do. What stays on the card 7 days goes away.",
            "「1 3」做第 1、3 条，其余留在卡片上；「1 3 其余不做」把剩下的都拒掉。编号只表示做。在卡片上 7 天没动的会消失。")}
        />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Field grow small value={text()} onChange={(v) => text.set(v)} onSubmit={() => void send()} placeholder={L("1 3 rest no", "1 3 其余不做")} testID={`proposals-${b().id}-text`} />
          <Btn small kind="primary" testID={`proposals-${b().id}-send`} label={L("Go", "提交")} busy={busy()} disabled={!text().trim()} onPress={() => void send()} />
        </View>
      </If>
      <If when={done()}>
        <Txt variant="caption" tone="muted" testID={`proposals-${b().id}-done`}>{L(`Started: ${done()}`, `已开工：${done()}`)}</Txt>
      </If>
      <ErrorNote text={error()} testID={`proposals-${b().id}-error`} />
    </Card>
  );
}

/** One proposal: its number and title, where it is from, 做 / 不做, and why and how behind 详情. */
function ProposalRow(props: { team: Team; proposal: Proposal; onError: (e: string) => void }) {
  const t = props.team;
  const p = () => props.proposal;
  const open = signal(false);
  const busy = signal<"" | "do" | "no">("");
  const where = () => {
    const c = t.channels().find((x) => x.id === p().channel_id);
    const a = t.agents().find((x) => x.id === p().agent_id);
    return `${c ? `#${c.name}` : ""} · @${a?.handle ?? "?"}`;
  };
  async function answer(yes: boolean) {
    busy.set(yes ? "do" : "no");
    const r = await t.answerProposal(p().id, yes);
    busy.set("");
    if (!r.ok) props.onError(failed(r as any));
  }
  return (
    <View testID={`proposal-${p().id}`} style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Txt grow lines={2}>{`${p().num}. ${p().title}`}</Txt>
        <Btn small kind="ghost" testID={`proposal-${p().id}-more`} label={open() ? L("Less", "收起") : L("Details", "详情")} onPress={() => open.set(!open())} />
        <Btn small kind="primary" testID={`proposal-${p().id}-do`} label={L("Do", "做")} busy={busy() === "do"} onPress={() => void answer(true)} />
        <Btn small testID={`proposal-${p().id}-no`} label={L("Don't", "不做")} busy={busy() === "no"} onPress={() => void answer(false)} />
      </View>
      <Txt variant="caption" tone="faint" lines={1}>{where()}</Txt>
      <If when={open()}>
        <View testID={`proposal-${p().id}-details`} style={{ gap: 4 }}>
          <If when={p().why}><Txt tone="muted">{L(`Why: ${p().why}`, `为什么：${p().why}`)}</Txt></If>
          <Txt tone="muted">{L(`Plan: ${p().plan}`, `打算：${p().plan}`)}</Txt>
        </View>
      </If>
    </View>
  );
}
