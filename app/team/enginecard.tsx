import { View } from "nsh";
import { L } from "../i18n";
import { Btn, Card, Noted, Txt } from "../ui";
import { runtimeLabel, type Engine, type Task, type Team } from "./api";
import { time } from "./ui";

/** What holds the runtime back, in a few words. */
function held(e: Engine, until: number | undefined): string {
  switch (e.reason) {
    case "quota": return until ? L(`is out of quota until about ${time(until)}`, `额度用完了，预计 ${time(until)} 恢复`) : L("is out of quota, reset unknown", "额度用完了，不知道什么时候恢复");
    case "billing": return L("is out of credit", "余额不足");
    case "auth": return L("is logged out", "没有登录");
    case "not_installed": return L("is not installed", "没有安装");
  }
  return L("takes no work", "接不了活");
}

/** 换引擎继续, for the agent's owner: its runtime is held back on its computer and another runtime there can take it.
 * Two lines (what stopped it, what a switch means) and two buttons; left alone it waits for its runtime. */
export function EngineCard(props: { team: Team; task: Task; engine: Engine; busy: boolean; onSwitch: (to: string) => void; onKeep: () => void }) {
  const t = props.team;
  const id = () => props.task.id;
  const m = () => t.machines().find((x) => x.id === props.engine.machine);
  const from = () => runtimeLabel(props.engine.from), to = () => runtimeLabel(props.engine.to);
  const note = () => {
    const parts = [L(`For this task only: the agent keeps ${from()}. The new session doesn’t have ${from()}’s; it goes on from the thread and the work directory as ${from()} left it. Left alone it waits, and goes on in its session when ${from()} is back.`,
      `只对这个任务生效，Agent 平时仍用 ${from()}。新会话里没有 ${from()} 的上下文，会从线程和 ${from()} 留下的工作目录接着做。不管它就是继续等，${from()} 恢复后在原来的会话里接着做。`)];
    const n = props.task.submits?.length ?? 0;
    if (n) parts.push(L(`It submitted ${n} time(s) to outside services; the new session is told, but check those aren't done twice.`, `它向外部提交过 ${n} 次，新会话会知道，但要留意别重复提交。`));
    return parts.join(" ");
  };
  return (
    <Card tight testID={`task-${id()}-engine`}>
      <Noted
        wrap
        testID={`task-${id()}-engine-what`}
        note={note()}
        label={<Txt variant="caption" weight="semibold" tone="default">{L(`${from()} on ${m()?.name ?? "?"} ${held(props.engine, m()?.runtime_status?.[props.engine.from]?.until)}; ${id()} is stopped`, `${m()?.name ?? "?"} 上的 ${from()} ${held(props.engine, m()?.runtime_status?.[props.engine.from]?.until)}，${id()} 停着`)}</Txt>}
      />
      <Txt variant="caption" tone="muted" testID={`task-${id()}-engine-how`}>{L(`${to()} there can take it: same work directory, a fresh session, its default model`, `同一台电脑上的 ${to()} 能接：同一个工作目录，新开会话，用它的默认模型`)}</Txt>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Btn small kind="primary" testID={`task-${id()}-engine-go`} label={L(`Go on with ${to()}`, `换成 ${to()} 继续`)} busy={props.busy} onPress={() => props.onSwitch(props.engine.to)} />
        <Btn small kind="ghost" testID={`task-${id()}-engine-keep`} label={L("Keep waiting", "继续等")} onPress={props.onKeep} />
      </View>
    </Card>
  );
}
