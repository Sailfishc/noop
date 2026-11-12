// 待你决定: what waits for this person (people asking to join, for admins; tasks, reminders that went off), and tasks
// waiting for outside results. On a wide window it is a triage desk: the list on the left, the one picked on the
// right to act on, the next one picked once it is done; J and K move, Return opens its thread, H reminds me later.
// On a phone the picked one (the first at the start) is open in the list with its buttons, the others a row each.
import { effect, keymap, Scroll, signal, untracked, View } from "nsh";
import { L } from "../i18n";
import { Avatar, Empty, Keys, ListRow, MenuHeading, MenuLine, MenuRow, RowMenu, Split, toast, Txt } from "../ui";
import { reminderUp, type Task, type Team } from "./api";
import { LATER, ReminderSections } from "./reminders";
import { Header, time } from "./ui";
import { TaskCard } from "./taskcard";
import { SignupSection } from "./signups";
import { ProposalSection } from "./proposals";
import { taskRef, waitsOn } from "./taskpeople";

export function Inbox(props: { team: Team; wide: boolean; back: boolean; onBack: () => void; onOpen: (channelId: string, threadId: string | null) => void }) {
  const t = props.team;
  /** Put off: a reminder I set on its thread that hasn't gone off yet (H). It comes back when the reminder does. */
  const later = (x: Task) => t.reminders().some((r) => !r.done && !r.fired && r.message_id === x.thread_id && r.target.kind === "user" && r.target.id === t.me()?.id);
  const items = () => t.inbox().map((id) => t.tasks()[id]).filter((x): x is Task => !!x && !later(x));
  const mine = () => new Set(t.inbox());
  const waits = () => t.waiting().map((id) => t.tasks()[id]).filter((x) => x?.state === "waiting" && !mine().has(x.id));
  effect(() => { void t.loadInbox(); void t.loadReminders(); });
  const up = () => t.reminders().some((r) => reminderUp(r, t.me()?.id));
  const channelName = (x: Task) => t.channels().find((c) => c.id === x.channel_id)?.name;
  const open = (x: Task) => !x.redacted && props.onOpen(x.channel_id, x.thread_id);

  // the one picked: when it leaves the list (acted on), the one now at its place is next
  const picked = signal<string | null>(null);
  let at = 0;
  const current = () => {
    const xs = items();
    const i = xs.findIndex((x) => x.id === picked());
    if (i >= 0) at = i;
    return xs[i >= 0 ? i : Math.min(at, xs.length - 1)] ?? null;
  };
  const move = (d: number) => {
    const xs = untracked(items);
    const i = xs.findIndex((x) => x.id === untracked(current)?.id);
    const next = xs[Math.max(0, Math.min(xs.length - 1, i + d))];
    if (next) picked.set(next.id);
  };
  async function remindLater(x: Task, when = "1h") {
    const e = await t.remind({ message_id: x.thread_id, when });
    if (e) toast(e, "error");
    else toast(L("It comes back when the reminder goes off", "提醒响时它会回来"), "info");
  }
  keymap.bind({
    j: () => props.wide && move(1),
    k: () => props.wide && move(-1),
    enter: () => { const x = untracked(current); if (props.wide && x) open(x); },
    h: () => { const x = untracked(current); if (props.wide && x) void remindLater(x); },
  }, { when: "notEditing" });

  const row = (x: () => Task) => {
    const agent = () => t.agents().find((a) => a.id === x().agent_id);
    return (
      <RowMenu trigger={
        <ListRow
          testID={`triage-${x().id}`}
          title={x().redacted ? L("A task in a private channel", "私有频道里的任务") : x().title}
          left={<Avatar name={agent()?.name ?? "?"} agent size="sm" />}
          below={
            <View style={{ flexDirection: "row", gap: 6 }}>
              <If when={waitsOn(t, x())?.label}>{(w) => <Txt variant="caption" weight="semibold" tone="attention" lines={1}>{w()}</Txt>}</If>
              <Txt variant="caption" tone="faint" lines={1} grow>{`${taskRef(t, x())} · ${time(x().updated)}`}</Txt>
            </View>
          }
          selected={current()?.id === x().id}
          onPress={() => picked.set(x().id)}
        />
      }>
        <MenuRow testID={`triage-${x().id}-open`} icon="chat" label={L("Open thread", "打开线程")} right="↵" onSelect={() => open(x())} />
        <MenuLine />
        <MenuHeading text={L("Remind me later", "稍后提醒")} />
        {LATER.map((w, i) => <MenuRow testID={`triage-${x().id}-later-${i}`} label={w.label()} right={i === 1 ? "H" : undefined} onSelect={() => void remindLater(x(), w.when)} />)}
      </RowMenu>
    );
  };
  const rest = () => (
    <>
      <ReminderSections team={t} onOpen={(r) => props.onOpen(r.channel_id, r.thread_id)} />
      <If when={waits().length}>
        <View style={{ paddingTop: 12 }}><Txt variant="caption" weight="semibold" tone="faint" testID="inbox-waiting">{L("Waiting for outside results", "等外部结果")}</Txt></View>
        <Each of={waits()} key={(x) => x.id}>
          {(x) => <TaskCard team={t} task={x()} channelName={channelName(x())} onOpen={() => open(x())} />}
        </Each>
      </If>
    </>
  );
  const nothing = () => !items().length && !up() && !t.signups().length && !t.proposals().length;

  return (
    <View style={{ flex: 1 }}>
      <Header title={L("Waiting for you", "待你决定")} back={props.back} onBack={props.onBack} />
      <If when={props.wide} else={
        // one column (phones): the cards one under another
        <Scroll style={{ flex: 1 }} contentStyle={{ padding: 16, gap: 12 }}>
          <SignupSection team={t} />
          <ProposalSection team={t} />
          <If when={!nothing()} else={<Empty testID="inbox-empty" />}>
            {/* the one picked (the first at the start) open with its buttons, the others a row each: press to open */}
            <View style={{ gap: 2 }}>
              <Each of={items()} key={(x) => x.id}>
                {(x) => (
                  <If when={current()?.id === x().id} else={row(x)}>
                    <View style={{ paddingVertical: 8 }}>
                      <TaskCard team={t} task={x()} channelName={channelName(x())} onOpen={x().redacted ? undefined : () => open(x())} />
                    </View>
                  </If>
                )}
              </Each>
            </View>
          </If>
          {rest()}
        </Scroll>
      }>
        <Split listTestID="triage-list" list={
          <>
            <Scroll style={{ flex: 1 }} contentStyle={{ padding: 8, gap: 2 }}>
              <If when={!nothing()} else={<View style={{ padding: 8 }}><Empty testID="inbox-empty" /></View>}>
                <Each of={items()} key={(x) => x.id}>{(x) => row(x)}</Each>
              </If>
              {rest()}
            </Scroll>
            <If when={items().length}>
              <View testID="triage-keys" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, padding: 12 }}>
                <Keys keys="J K" /><Txt variant="caption" tone="faint">{L("move", "上下")}</Txt>
                <Keys keys="↵" /><Txt variant="caption" tone="faint">{L("open", "打开")}</Txt>
                <Keys keys="H" /><Txt variant="caption" tone="faint">{L("later", "稍后提醒")}</Txt>
              </View>
            </If>
          </>
        } detail={
          <Scroll testID="triage-detail" style={{ flex: 1 }} contentStyle={{ padding: 16, gap: 12 }}>
            {/* what isn't a task: people asking to join (admins), an agent's proposals */}
            <SignupSection team={t} />
            <ProposalSection team={t} />
            <If when={current()} else={<If when={items().length === 0 && !nothing()}><Empty /></If>}>
              {(x) => <TaskCard team={t} task={x()} channelName={channelName(x())} onOpen={x().redacted ? undefined : () => open(x())} />}
            </If>
          </Scroll>
        } />
      </If>
    </View>
  );
}
