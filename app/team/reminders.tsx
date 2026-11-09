// Reminders: "remind me later" on a message, the ones that went off (in 待你决定), and the ones still to come. /remind
// in the composer and an agent's `remi remind` make them too; the server parses the time words (reminders.go).
import { signal, Text, View, type ViewStyle } from "nsh";
import { Menu, MenuItem } from "nsh/base";
import { L } from "../i18n";
import { alpha, colors, hovered, Icon } from "../ui";
import { reminderUp, type Reminder, type Team } from "./api";
import { Btn, time } from "./ui";

export const REPEAT: Record<string, () => string> = {
  daily: () => L("every day", "每天"),
  weekdays: () => L("every weekday", "每个工作日"),
  weekly: () => L("every week", "每周"),
};

/** When it fires next, and how often. */
export function dueText(r: Reminder): string {
  const when = time(r.due);
  return r.repeat ? `${REPEAT[r.repeat]?.() ?? r.repeat} · ${L("next", "下次")} ${when}` : when;
}

/** The later times a message's menu (and a reminder that went off) offers. */
const LATER: { when: string; label: () => string }[] = [
  { when: "20m", label: () => L("In 20 minutes", "20 分钟后") },
  { when: "1h", label: () => L("In 1 hour", "1 小时后") },
  { when: "3h", label: () => L("In 3 hours", "3 小时后") },
  { when: "tomorrow 9:00", label: () => L("Tomorrow at 9:00", "明天 9:00") },
  { when: "mon 9:00", label: () => L("Monday at 9:00", "周一 9:00") },
];

/** A bell on a message: remind me of it later. */
export function RemindMenu(props: { team: Team; messageId: string; onError: (e: string) => void }) {
  const row = (): ViewStyle => ({ height: 32, flexDirection: "row", alignItems: "center", paddingHorizontal: 10, borderRadius: 7 });
  return (
    <Menu
      align="end"
      offset={4}
      margin={8}
      popupStyle={{ minWidth: 180, padding: 5, borderRadius: 12, borderWidth: 1, borderColor: alpha(colors.text, 0.1), backgroundColor: colors.surface, boxShadow: "0 8px 28px rgba(0,0,0,0.14)" }}
      trigger={
        <View role="button" testID={`remind-${props.messageId}`} accessibilityLabel={L("Remind me later", "稍后提醒")} tooltip={<Text>{L("Remind me later", "稍后提醒")}</Text>}
          hoverStyle={hovered()} style={{ width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center" }}>
          <Icon name="bell" size={13} tint={colors.faint} />
        </View>
      }
    >
      <Text style={{ paddingHorizontal: 10, paddingTop: 4, paddingBottom: 6, fontSize: 12, fontWeight: "600", color: colors.faint }}>{L("Remind me", "提醒我")}</Text>
      {LATER.map((x) => (
        <MenuItem testID={`remind-${props.messageId}-${x.when.replace(/\W+/g, "-")}`} hoverStyle={hovered()} activeStyle={hovered()} style={row()}
          onSelect={async () => props.onError((await props.team.remind({ message_id: props.messageId, when: x.when })) ?? "")}>
          <Text style={{ fontSize: 13.5, color: colors.text }}>{x.label()}</Text>
        </MenuItem>
      ))}
    </Menu>
  );
}

/** In 待你决定: the reminders that went off for me, then the ones still to come (mine or for me). */
export function ReminderSections(props: { team: Team; onOpen: (r: Reminder) => void }) {
  const t = props.team;
  const up = () => t.reminders().filter((r) => reminderUp(r, t.me()?.id));
  const later = () => t.reminders().filter((r) => !r.done);
  const head = (testID: string, s: string) => <Text testID={testID} style={{ paddingTop: 14, fontSize: 12.5, fontWeight: "600", color: colors.faint }}>{s}</Text>;
  return (
    <>
      <If when={up().length}>
        {head("reminders-up", L("Reminders", "提醒"))}
        <Each of={up()} key={(r) => r.id}>
          {(r) => <ReminderCard team={t} r={r()} up onOpen={() => props.onOpen(r())} />}
        </Each>
      </If>
      <If when={later().length}>
        {head("reminders-later", L("Coming up", "已安排的提醒"))}
        <Each of={later()} key={(r) => r.id}>
          {(r) => <ReminderCard team={t} r={r()} onOpen={() => props.onOpen(r())} />}
        </Each>
      </If>
    </>
  );
}

function ReminderCard(props: { team: Team; r: Reminder; up?: boolean; onOpen: () => void }) {
  const t = props.team;
  const busy = signal(false);
  const run = async (f: () => Promise<void>) => { busy.set(true); await f(); busy.set(false); };
  const channel = () => t.channels().find((c) => c.id === props.r.channel_id)?.name ?? "";
  const who = () => {
    const r = props.r;
    const target = r.target.kind === "agent" ? t.agentById(r.target.id) : t.userById(r.target.id);
    const mine = r.target.kind === "user" && r.target.id === t.me()?.id;
    const setter = r.by_agent ? t.agentById(r.by_agent)?.name : r.by !== t.me()?.id ? t.userById(r.by)?.name : "";
    const parts = [mine ? L("you", "你") : `@${target?.handle ?? "?"}`];
    if (setter) parts.push(L(`set by ${setter}`, `${setter} 设的`));
    return parts.join(" · ");
  };
  return (
    <View testID={`reminder-${props.r.id}`} style={{ gap: 8, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: props.up ? colors.accent : colors.border, backgroundColor: colors.surface, opacity: busy() ? 0.6 : 1 }}>
      <View role="button" onPress={props.onOpen} hoverStyle={{ opacity: 0.8 }} style={{ gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name="bell" size={13} tint={props.up ? colors.accent : colors.muted} />
          <Text style={{ fontSize: 12.5, color: colors.muted }}>{props.up ? time(props.r.fired!) : dueText(props.r)}</Text>
          <Text style={{ fontSize: 12.5, color: colors.faint, numberOfLines: 1, flexShrink: 1 }}>#{channel()} · {who()}</Text>
        </View>
        <Text style={{ fontSize: 14.5, lineHeight: 21, color: colors.text }}>{props.r.text}</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <If when={props.up} else={<Btn small kind="ghost" testID={`reminder-${props.r.id}-cancel`} label={L("Cancel", "取消")} onPress={() => run(() => t.cancelReminder(props.r.id))} />}>
          <Btn small kind="primary" testID={`reminder-${props.r.id}-done`} label={L("Done", "完成")} onPress={() => run(() => t.reminderSeen(props.r.id))} />
          <Btn small kind="plain" testID={`reminder-${props.r.id}-1h`} label={L("In 1 hour", "1 小时后")} onPress={() => run(() => t.reminderSeen(props.r.id, "1h"))} />
          <Btn small kind="plain" testID={`reminder-${props.r.id}-tomorrow`} label={L("Tomorrow", "明天")} onPress={() => run(() => t.reminderSeen(props.r.id, "tomorrow 9:00"))} />
        </If>
      </View>
    </View>
  );
}
