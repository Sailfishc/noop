// The align card (design 「对齐」): before a larger request starts, its agent says once what "done" will mean. The
// person says go ("按这个做", with the criteria as they leave them) or replies in the thread to change them.
import { signal, View } from "nsh";
import { L } from "../i18n";
import { AskCard, Btn, TextArea, Txt } from "../ui";
import type { Decision, Task } from "./api";

export function AlignCard(props: { task: Task; decision: Decision; party: boolean; busy: boolean; onGo: (acceptance?: string) => void; onReply?: () => void }) {
  const d = () => props.decision;
  const id = () => props.task.id;
  const editing = signal(false);
  const draft = signal("");
  const criteria = () => d().acceptance ?? [];
  return (
    <AskCard
      testID={`task-${id()}-align`}
      quiet={!props.party}
      kind={props.party ? L("Waits for you to align: what done will mean", "等你对齐：做完意味着") : L("What done will mean", "做完意味着")}
      onReply={props.party && !editing() ? props.onReply : undefined}
      actions={
        <If when={props.party}>
          <Btn small kind="primary" testID={`task-${id()}-align-go`} label={L("Go with this", "按这个做")} busy={props.busy}
            disabled={editing() && !draft().trim()} onPress={() => props.onGo(editing() ? draft() : undefined)} />
          <If when={!editing()} else={<Btn small kind="ghost" label={L("Cancel", "取消")} onPress={() => editing.set(false)} />}>
            <Btn small kind="ghost" testID={`task-${id()}-align-edit`} label={L("Edit criteria", "改标准")} onPress={() => { draft.set(criteria().join("\n")); editing.set(true); }} />
          </If>
        </If>
      }
      note={props.party ? L("The agent read first and stops once to check this with you. Say go, edit the criteria first, or reply in the thread to change them: it starts right after and won't ask again.",
          "Agent 先读过代码，开工前停下来和你对一次。点「按这个做」，或先改标准再点，或在线程里回一句话改：它随后就开工，不会再问第二次。") : L("Its creator or the person taking it decides.", "由发起人或处理人决定。")}
    >
      <If when={!editing()} else={
        <TextArea testID={`task-${id()}-align-input`} value={draft()} min={64} max={180} autoFocus onChange={draft.set}
          placeholder={L("One per line", "一行一条")} />
      }>
        <View style={{ gap: 2 }}>
          <Each of={criteria()} key="index">
            {(c, i) => <Txt testID={`task-${id()}-align-${i()}`}>{`${i() + 1}. ${c()}`}</Txt>}
          </Each>
        </View>
      </If>
      <If when={d().not_doing?.length}>
        <Txt variant="caption" tone="muted">{L(`Not doing: ${d().not_doing!.join("; ")}`, `不做：${d().not_doing!.join("；")}`)}</Txt>
      </If>
      <If when={d().approach}>
        <Txt variant="caption" tone="muted">{L(`How: ${d().approach}`, `做法：${d().approach}`)}</Txt>
      </If>
      <If when={d().dirty}>
        <Txt variant="caption" weight="semibold" testID={`task-${id()}-align-dirty`}>{L("It had already changed files before aligning.", "对齐前已经改了文件。")}</Txt>
      </If>
    </AskCard>
  );
}
