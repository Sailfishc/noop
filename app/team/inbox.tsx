// 待你决定: what waits for this person (people asking to join, for admins; tasks, reminders that went off), and tasks waiting for outside results.
import { effect, Scroll, Text, View } from "nsh";
import { L } from "../i18n";
import { colors } from "../ui";
import { reminderUp, type Team } from "./api";
import { ReminderSections } from "./reminders";
import { Header } from "./ui";
import { TaskCard } from "./taskcard";
import { SignupSection } from "./signups";

export function Inbox(props: { team: Team; back: boolean; onBack: () => void; onOpen: (channelId: string, threadId: string | null) => void }) {
  const t = props.team;
  const items = () => t.inbox().map((id) => t.tasks()[id]).filter(Boolean);
  const waits = () => t.waiting().map((id) => t.tasks()[id]).filter((x) => x?.state === "waiting");
  effect(() => { void t.loadInbox(); void t.loadReminders(); });
  const up = () => t.reminders().some((r) => reminderUp(r, t.me()?.id));
  return (
    <View style={{ flex: 1 }}>
      <Header title={L("Waiting for you", "待你决定")} subtitle={L("Tasks to confirm, decisions to make, results to accept", "要你确认的活、要你做的决定、要你验收的结果")} back={props.back} onBack={props.onBack} />
      <Scroll style={{ flex: 1 }} contentStyle={{ padding: 16, gap: 10, maxWidth: 640 }}>
        <SignupSection team={t} />
        <If when={items().length || up() || t.signups().length} else={<Text testID="inbox-empty" style={{ padding: 24, fontSize: 14.5, color: colors.muted, textAlign: "center" }}>{L("Nothing waits for you.", "没有等你处理的事。")}</Text>}>
          <Each of={items()} key={(x) => x.id}>
            {(x) => <TaskCard team={t} task={x()} channelName={t.channels().find((c) => c.id === x().channel_id)?.name} onOpen={() => props.onOpen(x().channel_id, x().thread_id)} />}
          </Each>
        </If>
        <ReminderSections team={t} onOpen={(r) => props.onOpen(r.channel_id, r.thread_id)} />
        <If when={waits().length}>
          <Text testID="inbox-waiting" style={{ paddingTop: 14, fontSize: 12.5, fontWeight: "600", color: colors.faint }}>
            {L("Waiting for outside results (the agent is woken, not you)", "等外部结果（到时叫醒 Agent，不打扰你）")}
          </Text>
          <Each of={waits()} key={(x) => x.id}>
            {(x) => <TaskCard team={t} task={x()} channelName={t.channels().find((c) => c.id === x().channel_id)?.name} onOpen={() => props.onOpen(x().channel_id, x().thread_id)} />}
          </Each>
        </If>
      </Scroll>
    </View>
  );
}
