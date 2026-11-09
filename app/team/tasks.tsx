// Task views (as in Raft): a channel's Tasks tab and the team-wide Tasks page, each as a board (a column per status)
// or a list. Only tasks people track show here; a question the agent only answered stays in the conversation.
import { computed, effect, Scroll, signal, Text, View } from "nsh";
import { L } from "../i18n";
import { alpha, colors, hovered } from "../ui";
import type { Task, Team } from "./api";
import { NEEDS, STATUS, STATUSES, statusOf, type Needs, type Status } from "./status";
import { Header, StateDot, time } from "./ui";

export type TaskLayout = "board" | "list";
/** The team-wide page's filters: everything, what I asked for, what my agents work on. */
export type TaskFilter = "all" | "mine" | "agents";

const tone = (t: string) => (t === "accent" ? colors.accent : t === "warn" ? colors.warn : t === "danger" ? colors.danger : t === "up" ? colors.up : colors.muted);

export const trackedTasks = (t: Team) => Object.values(t.tasks()).filter((x) => x.tracked !== false);

/** One task in a column or a row of the list: number, title, the "needs you" mark, its agent and channel. */
function TaskRow(props: { team: Team; task: Task; showStatus?: boolean; showChannel?: boolean; onOpen: (t: Task) => void }) {
  const t = props.team;
  const st = () => statusOf(props.task.state);
  const needs = () => (st().needs ? NEEDS[st().needs as Exclude<Needs, "">] : null);
  const agent = () => t.agents().find((a) => a.id === props.task.agent_id);
  const channel = () => t.channels().find((c) => c.id === props.task.channel_id);
  return (
    <View role="button" testID={`taskrow-${props.task.id}`} onPress={() => props.onOpen(props.task)} hoverStyle={hovered()}
      style={{ gap: 4, padding: 10, borderRadius: 9, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={{ fontSize: 12, fontWeight: "600", color: colors.faint, fontVariant: ["tabular-nums"] }}>{props.task.id}</Text>
        <Text style={{ flex: 1, fontSize: 13.5, fontWeight: "600", color: colors.text, numberOfLines: 2 }}>{props.task.title}</Text>
        <If when={props.showStatus}>
          <Text style={{ fontSize: 12, fontWeight: "600", color: tone(STATUS[st().status].tone) }}>{STATUS[st().status].label()}</Text>
        </If>
      </View>
      <If when={needs()}>
        {(n) => (
          <View style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 5, backgroundColor: alpha(tone(n().tone), 0.12) }}>
            <StateDot tone={n().tone} />
            <Text style={{ fontSize: 12, fontWeight: "600", color: tone(n().tone) }}>{n().label()}</Text>
          </View>
        )}
      </If>
      <Text style={{ fontSize: 12, color: colors.muted, numberOfLines: 1 }}>
        {[`@${agent()?.handle ?? "?"}`, props.showChannel && channel() ? `#${channel()!.name}` : "", props.task.state === "running" ? props.task.step : "", time(props.task.updated)].filter(Boolean).join(" · ")}
      </Text>
    </View>
  );
}

/** Tasks as a board (a column per status, "needs you" first in each) or a list (newest first). */
export function TaskBoard(props: { team: Team; tasks: Task[]; layout: TaskLayout; showChannel?: boolean; onOpen: (t: Task) => void; empty?: string }) {
  const byStatus = computed(() => {
    const cols: Record<Status, Task[]> = { todo: [], in_progress: [], in_review: [], done: [], closed: [] };
    for (const x of props.tasks) cols[statusOf(x.state).status].push(x);
    for (const k of STATUSES) cols[k].sort((a, b) => Number(!!statusOf(b.state).needs) - Number(!!statusOf(a.state).needs) || b.updated - a.updated);
    return cols;
  });
  const sorted = () => [...props.tasks].sort((a, b) => b.updated - a.updated);
  return (
    <If when={props.tasks.length} else={<Text testID="tasks-empty" style={{ padding: 24, fontSize: 14.5, color: colors.muted, textAlign: "center" }}>{props.empty ?? L("No tasks yet.", "还没有任务。")}</Text>}>
      <If when={props.layout === "board"} else={
        <Scroll testID="tasks-list" style={{ flex: 1 }} contentStyle={{ padding: 16, gap: 8, maxWidth: 720 }}>
          <Each of={sorted()} key={(x) => x.id}>
            {(x) => <TaskRow team={props.team} task={x()} showStatus showChannel={props.showChannel} onOpen={props.onOpen} />}
          </Each>
        </Scroll>
      }>
        <Scroll testID="tasks-board" horizontal style={{ flex: 1 }} contentStyle={{ padding: 12, gap: 10, alignItems: "flex-start" }}>
          <Each of={STATUSES} key={(s) => s}>
            {(s) => (
              <View testID={`tasks-col-${s()}`} style={{ width: 240, gap: 8, padding: 8, borderRadius: 10, backgroundColor: alpha(colors.text, 0.03) }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 }}>
                  <StateDot tone={STATUS[s()].tone} />
                  <Text style={{ flex: 1, fontSize: 13, fontWeight: "600", color: colors.text }}>{STATUS[s()].label()}</Text>
                  <Text testID={`tasks-col-${s()}-count`} style={{ fontSize: 12, color: colors.faint }}>{String(byStatus()[s()].length)}</Text>
                </View>
                <Each of={byStatus()[s()]} key={(x) => x.id}>
                  {(x) => <TaskRow team={props.team} task={x()} showChannel={props.showChannel} onOpen={props.onOpen} />}
                </Each>
              </View>
            )}
          </Each>
        </Scroll>
      </If>
    </If>
  );
}

/** Board | List, remembered per place by its caller. */
export function LayoutSwitch(props: { value: TaskLayout; onChange: (v: TaskLayout) => void }) {
  const item = (v: TaskLayout, label: string) => (
    <View role="button" testID={`tasks-layout-${v}`} accessibilityState={{ selected: props.value === v }} onPress={() => props.onChange(v)} hoverStyle={hovered()}
      style={{ height: 26, justifyContent: "center", paddingHorizontal: 10, borderRadius: 6, backgroundColor: props.value === v ? alpha(colors.text, 0.08) : "transparent" }}>
      <Text style={{ fontSize: 12.5, fontWeight: props.value === v ? "600" : "400", color: props.value === v ? colors.text : colors.muted }}>{label}</Text>
    </View>
  );
  return (
    <View style={{ flexDirection: "row", gap: 2 }}>
      {item("board", L("Board", "看板"))}
      {item("list", L("List", "列表"))}
    </View>
  );
}

/** The team-wide Tasks page: every tracked task in the channels this person can see. */
export function TasksPage(props: { team: Team; back: boolean; onBack: () => void; onOpen: (t: Task) => void }) {
  const t = props.team;
  const layout = signal<TaskLayout>("board");
  const filter = signal<TaskFilter>("all");
  effect(() => void t.loadTasks());
  const shown = () => {
    const me = t.me();
    const mine = new Set(t.agents().filter((a) => a.owner_id === me?.id).map((a) => a.id));
    return trackedTasks(t).filter((x) => filter() === "all" || (filter() === "mine" ? x.created_by === me?.id : mine.has(x.agent_id)));
  };
  const chip = (v: TaskFilter, label: string) => (
    <View role="button" testID={`tasks-filter-${v}`} accessibilityState={{ selected: filter() === v }} onPress={() => filter.set(v)} hoverStyle={hovered()}
      style={{ height: 28, justifyContent: "center", paddingHorizontal: 10, borderRadius: 14, borderWidth: 1, borderColor: filter() === v ? colors.accentFill : colors.border, backgroundColor: filter() === v ? alpha(colors.accent, 0.1) : "transparent" }}>
      <Text style={{ fontSize: 12.5, color: filter() === v ? colors.accent : colors.muted }}>{label}</Text>
    </View>
  );
  return (
    <View style={{ flex: 1 }}>
      <Header title={L("Tasks", "任务")} subtitle={L("Every task people track, in the channels you can see", "你能看到的频道里，所有被跟踪的任务")} back={props.back} onBack={props.onBack}
        right={<LayoutSwitch value={layout()} onChange={layout.set} />} />
      <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: 16, paddingTop: 10 }}>
        {chip("all", L("All", "全部"))}
        {chip("mine", L("I asked", "我发起的"))}
        {chip("agents", L("My agents", "我的 Agent"))}
      </View>
      <TaskBoard team={t} tasks={shown()} layout={layout()} showChannel onOpen={props.onOpen} />
    </View>
  );
}
