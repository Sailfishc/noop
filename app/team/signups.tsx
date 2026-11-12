// People asking to join, for admins: approve (the account is made then) or reject. In 待你决定 and 成员与邀请.
import { signal, Text, View } from "nsh";
import { L } from "../i18n";
import { Avatar, Btn, colors, ErrorNote, radius } from "../ui";
import type { Signup, Team } from "./api";
import { failed, time } from "./ui";

export function SignupCard(props: { team: Team; signup: Signup }) {
  const busy = signal<"" | "approve" | "reject">("");
  const error = signal("");
  const s = () => props.signup;
  async function decide(approve: boolean) {
    if (busy()) return;
    busy.set(approve ? "approve" : "reject");
    error.set("");
    const r = await props.team.decideSignup(s().id, approve);
    busy.set("");
    if (!r.ok) error.set(failed(r));
  }
  return (
    <View testID={`signup-${s().handle}`} style={{ gap: 10, padding: 14, borderRadius: radius.md, borderWidth: 1, borderColor: colors.hairline, backgroundColor: colors.raised }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Avatar name={s().name} size={30} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14.5, color: colors.fg }}>{s().name} <Text style={{ color: colors.fg2 }}>@{s().handle}</Text></Text>
          <Text style={{ fontSize: 12.5, color: colors.fg3, numberOfLines: 1 }}>{`${s().email} · ${L("asked", "申请于")} ${time(s().created)}`}</Text>
        </View>
      </View>
      <If when={s().note}>
        <Text style={{ fontSize: 13.5, lineHeight: 20, color: colors.fg }}>{s().note}</Text>
      </If>
      <ErrorNote text={error()} testID={`signup-${s().handle}-error`} />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Btn small kind="primary" testID={`signup-${s().handle}-approve`} label={L("Let in", "通过")} busy={busy() === "approve"} onPress={() => void decide(true)} />
        <Btn small testID={`signup-${s().handle}-reject`} label={L("Reject", "拒绝")} busy={busy() === "reject"} onPress={() => void decide(false)} />
      </View>
    </View>
  );
}

/** The heading and cards, or nothing when no one is asking. */
export function SignupSection(props: { team: Team }) {
  return (
    <If when={props.team.signups().length}>
      <Text testID="signups-title" style={{ fontSize: 12.5, fontWeight: "600", color: colors.fg3 }}>
        {L(`Asking to join · ${props.team.signups().length}`, `申请加入 · ${props.team.signups().length}`)}
      </Text>
      <Each of={props.team.signups()} key={(s) => s.id}>
        {(s) => <SignupCard team={props.team} signup={s()} />}
      </Each>
    </If>
  );
}
