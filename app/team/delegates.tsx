// What a task's agent delegated (remi delegate, design step 4): one line on its card, "委派给 @B、@C：1 个做完，1 个在做",
// that opens to a line per delegated task. The delegated tasks come back to the agent, not to a person's acceptance.
import { signal, View } from "nsh";
import { L } from "../i18n";
import { Btn, Txt } from "../ui";
import type { Delegate, Task, Team } from "./api";
import { STATUS, statusOf } from "./status";

const back = (d: Delegate) => ["done", "failed", "closed"].includes(d.state);

/** How a delegated task stands, in a word. */
export function delegateState(d: Delegate): string {
  if (d.state === "done") return L("done", "做完了");
  if (d.state === "failed") return L("failed", "失败了");
  if (d.state === "closed") return L("cancelled", "取消了");
  const st = statusOf(d.state);
  return st.needs ? L("waits for a person", "等人处理") : STATUS[st.status].label();
}

const handle = (t: Team, id: string) => "@" + (t.agents().find((a) => a.id === id)?.handle ?? "?");

/** "@B, @C" of the delegated tasks not back yet: what a task waiting for them waits for. */
export function waitingFor(t: Team, task: Task): string {
  const open = (task.delegates ?? []).filter((d) => !back(d));
  return open.map((d) => handle(t, d.agent)).join(L(", ", "、"));
}

/** The summary line and, opened, a line per delegated task. */
export function Delegates(props: { team: Team; task: Task }) {
  const t = props.team;
  const open = signal(false);
  const ds = () => props.task.delegates ?? [];
  const summary = () => {
    const done = ds().filter((d) => d.state === "done").length, failed = ds().filter((d) => d.state === "failed").length;
    const going = ds().filter((d) => !back(d)).length;
    const parts = [
      done ? L(`${done} done`, `${done} 个做完`) : "",
      failed ? L(`${failed} failed`, `${failed} 个失败`) : "",
      going ? L(`${going} going`, `${going} 个在做`) : "",
    ].filter(Boolean).join(L(", ", "，"));
    const who = [...new Set(ds().map((d) => handle(t, d.agent)))].join(L(", ", "、"));
    return L(`Delegated to ${who}: ${parts}`, `委派给 ${who}：${parts}`);
  };
  return (
    <If when={ds().length}>
      <View testID={`task-${props.task.id}-delegates`} style={{ gap: 4 }}>
        <View style={{ flexDirection: "row" }}>
          <Btn small kind="ghost" testID={`task-${props.task.id}-delegates-toggle`} label={summary()} icon={open() ? "chevron-down" : "chevron"} onPress={() => open.set(!open())} />
        </View>
        <If when={open()}>
          <Each of={ds()} key={(d) => d.task}>
            {(d) => (
              <Txt variant="caption" tone="muted" testID={`task-${props.task.id}-delegate-${d().task}`}>
                {[`${d().task} ${handle(t, d().agent)}`, delegateState(d()), d().redos ? L(`sent back ${d().redos}×`, `打回 ${d().redos} 次`) : ""].filter(Boolean).join(" · ")}
              </Txt>
            )}
          </Each>
        </If>
      </View>
    </If>
  );
}
