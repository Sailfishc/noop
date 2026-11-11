import { View } from "nsh";
import { L } from "../i18n";
import { Btn, Card, Noted, Txt } from "../ui";
import type { Move, Task, Team } from "./api";
import { time } from "./ui";

const mins = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/** 换电脑继续, for the agent's owner: its computer has been gone a while and another of the agent's can take it. Two
 * lines (where it stopped, what a move loses) and two buttons; left alone it waits, and goes when the computer is back. */
export function MoveCard(props: { team: Team; task: Task; move: Move; busy: boolean; onMove: (to: string) => void; onWait: () => void }) {
  const t = props.team;
  const name = (id: string) => t.machines().find((m) => m.id === id)?.name ?? "?";
  const id = () => props.task.id;
  const gone = () => (props.move.since ? mins(Date.now() - props.move.since) : 0);
  const ck = () => props.task.checkpoint;
  /** Saved: the wip commit or the packed directory (an error alone saved nothing). */
  const saved = () => {
    const c = ck();
    return !!c && (!!c.files || c.repos.some((r) => !!r.commit));
  };
  const lost = () => {
    if (!saved()) return L("No checkpoint: it starts over there", "没有检查点，要从头重做");
    const at = Math.max(ck()!.at, ck()!.checked ?? 0);
    const since = props.move.since || Date.now();
    return since - at < 60_000
      ? L(`Checkpoint ${time(ck()!.at)}: nothing to redo`, `检查点 ${time(ck()!.at)}，没有要重做的`)
      : L(`Checkpoint ${time(ck()!.at)}: about ${mins(since - at)} min of work to redo`, `检查点 ${time(ck()!.at)}，之后大约 ${mins(since - at)} 分钟的工作要重做`);
  };
  const note = () => {
    const parts = [L("Left alone it waits: when the computer is back, the task goes on there in its session. Moving starts a fresh session from the thread.", "不管它就是继续等：那台电脑回来，任务在原来的会话里接着做。换过去会从线程开一个新会话。")];
    const n = props.task.submits?.length ?? 0;
    if (n) parts.push(L(`It submitted ${n} time(s) to outside services; the new session is told, but check those aren't done twice.`, `它向外部提交过 ${n} 次，新会话会知道，但要留意别重复提交。`));
    return parts.join(" ");
  };
  return (
    <Card tight testID={`task-${id()}-move`}>
      <Noted
        testID={`task-${id()}-move-what`}
        note={note()}
        label={<Txt variant="caption" weight="semibold" tone="accent">{L(`${name(props.move.from)} has been offline ${gone()} min; ${id()} stopped on it`, `${name(props.move.from)} 离线 ${gone()} 分钟了，${id()} 停在上面`)}</Txt>}
      />
      <Txt variant="caption" tone="muted" testID={`task-${id()}-move-lost`}>{lost()}</Txt>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Btn small kind="primary" testID={`task-${id()}-move-go`} label={L(`Go on on ${name(props.move.to)}`, `在 ${name(props.move.to)} 上继续`)} busy={props.busy} onPress={() => props.onMove(props.move.to)} />
        <Btn small kind="ghost" testID={`task-${id()}-move-wait`} label={L("Keep waiting", "继续等")} onPress={props.onWait} />
      </View>
    </Card>
  );
}
