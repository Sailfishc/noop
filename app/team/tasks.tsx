// Task views (as in Raft, design "Remi 任务视图 v2"): the team-wide Tasks page and a channel's Tasks tab are one view,
// a board (a column per status side by side, done and closed folded to their heads) or a list. A task lives in its channel; the page looks at
// it from the person: by default the tasks that concern me (I asked, my agent does it, it waits for me), narrowed
// further by channel, by who asked and by which agent does it. Only tasks people track show; a question the agent
// only answered stays in the conversation.
import { computed, effect, Scroll, signal, Storage, Text, View, type JSX } from "nsh";
import { Menu, MenuItem } from "nsh/base";
import { L } from "../i18n";
import { alpha, colors, hovered, Icon } from "../ui";
import type { Task, Team } from "./api";
import { STATUS, STATUSES, statusOf, type Status, type Tone } from "./status";
import { concernsMe, liveLine, needsMe, taskRef, waitsOn } from "./taskpeople";
import { Avatar, Header, StateDot, time } from "./ui";

export type TaskLayout = "board" | "list";
/** The page's quick views: what concerns me (the default), what waits for me, what I asked for, my agents' work, all. */
export type TaskView = "related" | "needs" | "mine" | "agents" | "all";

const LAYOUT_KEY = "remi.tasks.layout";
const VIEW_KEY = "remi.tasks.view";
const VIEWS: TaskView[] = ["related", "needs", "mine", "agents", "all"];

export const toneColor = (t: Tone | string) => (t === "accent" ? colors.accent : t === "warn" ? colors.warn : t === "danger" ? colors.danger : t === "up" ? colors.up : colors.muted);

export const trackedTasks = (t: Team) => Object.values(t.tasks()).filter((x) => x.tracked !== false);

/** A layout remembered on this device (per place: the page, or channels). */
export function rememberedLayout(place: string) {
  const v = signal<TaskLayout>("board");
  void Storage.getItem(`${LAYOUT_KEY}.${place}`).then((s) => { if (s === "board" || s === "list") v.set(s); });
  return { get: v, set: (x: TaskLayout) => { v.set(x); void Storage.setItem(`${LAYOUT_KEY}.${place}`, x); } };
}

/** A "needs you" style chip: whom the task waits for. */
export function WaitsChip(props: { label: string; tone: Tone; testID?: string }) {
  return (
    <View testID={props.testID} style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 5, backgroundColor: alpha(toneColor(props.tone), 0.13) }}>
      <StateDot tone={props.tone} />
      <Text style={{ fontSize: 12, fontWeight: "600", color: toneColor(props.tone) }}>{props.label}</Text>
    </View>
  );
}

/** One task on the board or in the list, four lines at most: "#channel · T-0002", its title, whom it waits for,
 * and the agent doing it with how long it has run (or what it waits for) and what came out. */
function TaskRow(props: { team: Team; task: Task; showStatus?: boolean; showChannel?: boolean; onOpen: (t: Task) => void }) {
  const t = props.team;
  const task = () => props.task;
  const st = () => statusOf(task().state);
  const agent = () => t.agents().find((a) => a.id === task().agent_id);
  const waits = () => waitsOn(t, task());
  const outs = () => {
    const pr = task().pr;
    if (pr) return pr.state === "merged" ? L("PR merged", "PR 已合并") : pr.checks === "failure" ? L("PR · checks failed", "PR · CI 失败") : pr.checks === "pending" ? L("PR · checks running", "PR · CI 运行中") : "PR";
    const n = task().outputs?.length ?? 0;
    return n ? L(`${n} output${n > 1 ? "s" : ""}`, `${n} 个产出`) : "";
  };
  return (
    <View role="button" testID={`taskrow-${task().id}`} onPress={() => props.onOpen(task())} hoverStyle={hovered()}
      style={{ gap: 5, padding: 10, borderRadius: 9, borderWidth: 1, borderColor: waits()?.mine ? alpha(colors.warn, 0.45) : colors.border, backgroundColor: colors.surface }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text testID={`taskrow-${task().id}-ref`} style={{ flex: 1, fontSize: 11.5, color: colors.faint, fontVariant: ["tabular-nums"], numberOfLines: 1 }}>{taskRef(t, task(), props.showChannel)}</Text>
        <If when={props.showStatus}>
          <Text style={{ fontSize: 12, fontWeight: "600", color: toneColor(STATUS[st().status].tone) }}>{STATUS[st().status].label()}</Text>
        </If>
      </View>
      <Text style={{ fontSize: 13.5, fontWeight: "600", lineHeight: 19, color: colors.text, numberOfLines: 2 }}>{task().title}</Text>
      <If when={waits()}>
        {(w) => <WaitsChip testID={`taskrow-${task().id}-waits`} label={w().label} tone={w().tone} />}
      </If>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Avatar name={agent()?.name ?? "?"} agent size={16} />
        <Text style={{ flexShrink: 1, fontSize: 12, color: colors.muted, numberOfLines: 1 }}>
          {[`@${agent()?.handle ?? "?"}`, liveLine(task()) || time(task().updated)].join(" · ")}
        </Text>
        <View style={{ flex: 1 }} />
        <If when={outs()}>
          <Text testID={`taskrow-${task().id}-outputs`} style={{ fontSize: 12, color: colors.faint, numberOfLines: 1 }}>{outs()}</Text>
        </If>
      </View>
    </View>
  );
}

/** Tasks as a board (a column per status, what waits for me first; done and closed folded until opened) or a list
 * (newest first). */
export function TaskBoard(props: { team: Team; tasks: Task[]; layout: TaskLayout; showChannel?: boolean; onOpen: (t: Task) => void; empty?: string }) {
  const t = props.team;
  const unfolded = signal<Record<string, boolean>>({});
  const folded = (s: Status) => (s === "done" || s === "closed") && !unfolded()[s];
  const byStatus = computed(() => {
    const cols: Record<Status, Task[]> = { todo: [], in_progress: [], in_review: [], done: [], closed: [] };
    for (const x of props.tasks) cols[statusOf(x.state).status].push(x);
    const rank = (x: Task) => (needsMe(t, x) ? 2 : statusOf(x.state).needs ? 1 : 0);
    for (const k of STATUSES) cols[k].sort((a, b) => rank(b) - rank(a) || b.updated - a.updated);
    return cols;
  });
  const sorted = () => [...props.tasks].sort((a, b) => Number(needsMe(t, b)) - Number(needsMe(t, a)) || b.updated - a.updated);
  return (
    <If when={props.tasks.length} else={<Text testID="tasks-empty" style={{ padding: 24, fontSize: 14.5, color: colors.muted, textAlign: "center" }}>{props.empty ?? L("No tasks yet.", "还没有任务。")}</Text>}>
      <If when={props.layout === "board"} else={
        <Scroll testID="tasks-list" style={{ flex: 1 }} contentStyle={{ padding: 16, gap: 8, maxWidth: 720 }}>
          <Each of={sorted()} key={(x) => x.id}>
            {(x) => <TaskRow team={t} task={x()} showStatus showChannel={props.showChannel} onOpen={props.onOpen} />}
          </Each>
        </Scroll>
      }>
        <Scroll testID="tasks-board" style={{ flex: 1 }} contentStyle={{ padding: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
          <Each of={STATUSES} key={(s) => s}>
            {(s) => (
              <View testID={`tasks-col-${s()}`} style={{ flex: 1, flexBasis: 0, minWidth: 0, gap: 8, padding: 8, borderRadius: 10, backgroundColor: alpha(colors.text, 0.03) }}>
                <View role={s() === "done" || s() === "closed" ? "button" : undefined} testID={`tasks-col-${s()}-head`}
                  onPress={s() === "done" || s() === "closed" ? () => unfolded.update((u) => ({ ...u, [s()]: !u[s()] })) : undefined}
                  style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 }}>
                  <StateDot tone={STATUS[s()].tone} />
                  <Text style={{ fontSize: 13, fontWeight: "600", color: colors.text }}>{STATUS[s()].label()}</Text>
                  <Text testID={`tasks-col-${s()}-count`} style={{ flex: 1, fontSize: 12, color: colors.faint }}>{String(byStatus()[s()].length)}</Text>
                  <If when={s() === "done" || s() === "closed"}>
                    <Icon name={folded(s()) ? "chevron" : "chevron-down"} size={12} tint={colors.faint} />
                  </If>
                </View>
                <If when={!folded(s())}>
                  <Each of={byStatus()[s()]} key={(x) => x.id}>
                    {(x) => <TaskRow team={t} task={x()} showChannel={props.showChannel} onOpen={props.onOpen} />}
                  </Each>
                </If>
              </View>
            )}
          </Each>
          </View>
        </Scroll>
      </If>
    </If>
  );
}

/** Board | List. */
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

const VIEW_LABEL: Record<TaskView, () => string> = {
  related: () => L("Concerns me", "与我相关"),
  needs: () => L("Waits for me", "等我处理"),
  mine: () => L("I asked", "我发起的"),
  agents: () => L("My agents", "我的 Agent"),
  all: () => L("All", "全部"),
};

/** A filter of several picks (OR inside it; the filters together are AND), as in Raft's Channel / Creator / Assignee. */
function PickFilter(props: { testID: string; label: string; options: { id: string; label: string; note?: string }[]; picked: string[]; onChange: (ids: string[]) => void }) {
  const on = (id: string) => props.picked.includes(id);
  const toggle = (id: string) => props.onChange(on(id) ? props.picked.filter((x) => x !== id) : [...props.picked, id]);
  return (
    <Menu
      align="start"
      offset={4}
      margin={8}
      popupStyle={{ minWidth: 200, maxHeight: 360, padding: 5, borderRadius: 12, borderWidth: 1, borderColor: alpha(colors.text, 0.1), backgroundColor: colors.surface, boxShadow: "0 8px 28px rgba(0,0,0,0.14)" }}
      trigger={
        <View role="button" testID={props.testID} hoverStyle={hovered()}
          style={{ height: 28, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 9, borderRadius: 7, borderWidth: 1, borderColor: props.picked.length ? colors.accentFill : colors.border, backgroundColor: props.picked.length ? alpha(colors.accent, 0.08) : "transparent" }}>
          <Text style={{ fontSize: 12.5, color: props.picked.length ? colors.accent : colors.muted }}>{props.picked.length ? `${props.label} ${props.picked.length}` : props.label}</Text>
          <Icon name="chevron-down" size={11} tint={colors.faint} />
        </View>
      }
    >
      <If when={props.picked.length}>
        <MenuItem testID={`${props.testID}-clear`} onSelect={() => props.onChange([])} hoverStyle={hovered()} activeStyle={hovered()} style={{ height: 30, justifyContent: "center", paddingHorizontal: 10, borderRadius: 7 }}>
          <Text style={{ fontSize: 13, color: colors.muted }}>{L("Clear", "清除")}</Text>
        </MenuItem>
      </If>
      {props.options.map((o) => (
        <MenuItem testID={`${props.testID}-${o.id}`} onSelect={() => toggle(o.id)} hoverStyle={hovered()} activeStyle={hovered()}
          style={{ height: 32, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, borderRadius: 7 }}>
          <View style={{ width: 14, alignItems: "center" }}>
            <If when={on(o.id)}><Icon name="check" size={13} tint={colors.accent} /></If>
          </View>
          <Text style={{ flex: 1, fontSize: 13.5, color: colors.text, numberOfLines: 1 }}>{o.label}</Text>
          <If when={o.note}><Text style={{ fontSize: 12, color: colors.faint }}>{o.note}</Text></If>
        </MenuItem>
      ))}
    </Menu>
  );
}

/** The team-wide Tasks page: every tracked task in the channels this person can see, looked at from this person. */
export function TasksPage(props: { team: Team; back: boolean; onBack: () => void; onOpen: (t: Task) => void }) {
  const t = props.team;
  const layout = rememberedLayout("page");
  const view = signal<TaskView>("related");
  void Storage.getItem(VIEW_KEY).then((s) => { if (VIEWS.includes(s as TaskView)) view.set(s as TaskView); });
  const setView = (v: TaskView) => { view.set(v); void Storage.setItem(VIEW_KEY, v); };
  const channels = signal<string[]>([]);
  const creators = signal<string[]>([]);
  const doers = signal<string[]>([]);
  effect(() => { void t.loadTasks(); void t.loadInbox(); });
  const inView = (x: Task) => {
    const me = t.me();
    switch (view()) {
      case "related": return concernsMe(t, x);
      case "needs": return needsMe(t, x);
      case "mine": return x.created_by === me?.id;
      case "agents": return t.agents().some((a) => a.id === x.agent_id && a.owner_id === me?.id);
    }
    return true;
  };
  const shown = () => trackedTasks(t).filter((x) => inView(x)
    && (!channels().length || channels().includes(x.channel_id))
    && (!creators().length || creators().includes(x.created_by))
    && (!doers().length || doers().includes(x.agent_id)));
  const count = (v: TaskView) => (v === "needs" ? trackedTasks(t).filter((x) => needsMe(t, x)).length : 0);
  const chip = (v: TaskView) => (
    <View role="button" testID={`tasks-filter-${v}`} accessibilityState={{ selected: view() === v }} onPress={() => setView(v)} hoverStyle={hovered()}
      style={{ height: 28, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, borderRadius: 14, borderWidth: 1, borderColor: view() === v ? colors.accentFill : colors.border, backgroundColor: view() === v ? alpha(colors.accent, 0.1) : "transparent" }}>
      <Text style={{ fontSize: 12.5, color: view() === v ? colors.accent : colors.muted }}>{VIEW_LABEL[v]()}</Text>
      <If when={count(v)}><Text style={{ fontSize: 12, fontWeight: "600", color: colors.warn }}>{String(count(v))}</Text></If>
    </View>
  );
  const me = () => t.me();
  const channelOptions = () => t.channels().map((c) => ({ id: c.id, label: `#${c.name}` }));
  const creatorOptions = () => {
    const ids = new Set(trackedTasks(t).map((x) => x.created_by));
    return t.users().filter((u) => ids.has(u.id)).sort((a, b) => Number(b.id === me()?.id) - Number(a.id === me()?.id))
      .map((u) => ({ id: u.id, label: u.id === me()?.id ? L("Me", "我") : u.name, note: `@${u.handle}` }));
  };
  const doerOptions = () => [...t.agents()].sort((a, b) => Number(b.owner_id === me()?.id) - Number(a.owner_id === me()?.id))
    .map((a) => ({ id: a.id, label: `@${a.handle}`, note: a.owner_id === me()?.id ? L("mine", "我的") : t.users().find((u) => u.id === a.owner_id)?.name }));
  const subtitle = (): string => L(`${VIEW_LABEL[view()]()} · ${shown().length}`, `${VIEW_LABEL[view()]()} · ${shown().length} 个`);
  const filters = (): JSX.Element => (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingTop: 10 }}>
      {VIEWS.map(chip)}
      <View style={{ width: 6 }} />
      <PickFilter testID="tasks-pick-channel" label={L("# Channel", "# 频道")} options={channelOptions()} picked={channels()} onChange={channels.set} />
      <PickFilter testID="tasks-pick-creator" label={L("Asked by", "发起人")} options={creatorOptions()} picked={creators()} onChange={creators.set} />
      <PickFilter testID="tasks-pick-agent" label={L("Done by", "执行者")} options={doerOptions()} picked={doers()} onChange={doers.set} />
    </View>
  );
  return (
    <View style={{ flex: 1 }}>
      <Header title={L("Tasks", "任务")} subtitle={subtitle()} back={props.back} onBack={props.onBack}
        right={<LayoutSwitch value={layout.get()} onChange={layout.set} />} />
      {filters()}
      <TaskBoard team={t} tasks={shown()} layout={layout.get()} showChannel onOpen={props.onOpen}
        empty={view() === "all" ? L("No tasks yet.", "还没有任务。") : L("Nothing here. Try “All”.", "这里没有任务，看看「全部」。")} />
    </View>
  );
}
