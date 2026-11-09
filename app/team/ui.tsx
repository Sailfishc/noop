// TeamAgent's small shared pieces: buttons, fields, avatars, badges, headers.
import { Text, View, type JSX, type ViewStyle } from "nsh";
import { Input } from "nsh/base";
import { isAvailable as hasWindow, titleBar } from "nsh/desktop";
import { L, lang } from "../i18n";
import { alpha, colors, hovered, Icon, type IconName, radius, Spinner, tints } from "../ui";
import { blockedReason, insecureRefused, runtimeLabel, type Agent, type Team } from "./api";

export const WIDE = 720;
/** The window's own title bar area (its traffic lights on macOS): content at the window's top left keeps clear of it. */
export const chrome = () => (hasWindow ? titleBar() : { height: 0, left: 0, right: 0 });
/** Why a call to `url` got no response; `error` is the network stack's reason (Reply.error). */
export const unreachable = (url: string, error?: string) =>
  insecureRefused(error) && url.startsWith("http://")
    ? L(`This app may not use plain http to ${url}. Give the server an https address (see the server README), or use a build that allows http.`,
        `这个 App 不允许用不加密的 http 连接 ${url}。请给服务端配上 https 地址（见服务端 README），或换用允许 http 的版本。`)
    : L(`Can’t reach ${url}. Check the address and your network.`, `连不上服务器 ${url}，请检查地址和网络`);

// ---------------------------------------------------------------- small pieces

export function Btn(props: { label: string; onPress: () => void; kind?: "primary" | "plain" | "ghost" | "danger"; testID?: string; busy?: boolean; disabled?: boolean; icon?: IconName; grow?: boolean; small?: boolean }) {
  const kind = () => props.kind ?? "plain";
  const fg = () => (kind() === "primary" ? colors.onAccent : kind() === "danger" ? colors.danger : kind() === "ghost" ? colors.muted : colors.text);
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: !!props.disabled }}
      onPress={() => !props.disabled && !props.busy && props.onPress()}
      hoverStyle={props.disabled ? undefined : kind() === "primary" ? { opacity: 0.92 } : hovered()}
      style={{
        minHeight: props.small ? 30 : 40,
        flexGrow: props.grow ? 1 : 0,
        flexShrink: 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingHorizontal: props.small ? 10 : 14,
        borderRadius: radius.control,
        borderWidth: kind() === "plain" ? 0.5 : 0,
        borderColor: colors.fieldBorder,
        backgroundColor: kind() === "primary" ? colors.accentFill : kind() === "danger" ? tints.danger : kind() === "plain" ? colors.surface : "transparent",
        opacity: props.disabled ? 0.45 : 1,
      }}
    >
      <If when={props.busy}>
        <Spinner size={14} tint={fg()} />
      </If>
      <If when={!props.busy && props.icon}>
        <Icon name={props.icon!} size={16} tint={fg()} />
      </If>
      <Text style={{ fontSize: props.small ? 13.5 : 15, fontWeight: kind() === "primary" ? "600" : "500", color: fg() }}>{props.label}</Text>
    </View>
  );
}

export function Field(props: { label?: string; value: string; onChange: (v: string) => void; onSubmit?: () => void; placeholder?: string; testID?: string; hint?: string; autoFocus?: boolean; big?: boolean; keyboardType?: "email-address" | "number-pad" | "url" }) {
  return (
    <View style={{ gap: 6 }}>
      <If when={props.label}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{props.label}</Text>
      </If>
      <Input
        testID={props.testID}
        value={props.value}
        autoFocus={props.autoFocus}
        keyboardType={props.keyboardType}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={props.placeholder}
        class="placeholder:text-faint"
        submitBehavior="submit"
        onSubmit={() => props.onSubmit?.()}
        onChange={({ value }) => props.onChange(value)}
        style={{
          height: props.big ? 52 : 40,
          paddingHorizontal: 12,
          borderRadius: radius.control,
          borderWidth: 1,
          borderColor: colors.fieldBorder,
          backgroundColor: colors.field,
          fontSize: props.big ? 24 : 15,
          color: colors.text,
          ...(props.big ? { letterSpacing: 8, textAlign: "center", fontVariant: ["tabular-nums"] } : {}),
        }}
      />
      <If when={props.hint}>
        <Text style={{ fontSize: 13, lineHeight: 19, color: colors.muted }}>{props.hint}</Text>
      </If>
    </View>
  );
}

export function ErrorNote(props: { text: string; testID?: string }) {
  return (
    <If when={props.text}>
      <View style={{ paddingHorizontal: 12, paddingVertical: 9, borderRadius: radius.control, backgroundColor: tints.danger }}>
        <Text testID={props.testID} style={{ fontSize: 14, lineHeight: 20, color: colors.danger }}>{props.text}</Text>
      </View>
    </If>
  );
}

/** A row of choices, one picked. */
export function Choice<T extends string>(props: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; testID?: string }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      <Each of={props.options}>
        {(o) => (
          <View
            role="button"
            testID={props.testID ? `${props.testID}-${o().value}` : undefined}
            accessibilityState={{ selected: props.value === o().value }}
            onPress={() => props.onChange(o().value)}
            hoverStyle={hovered()}
            style={{
              height: 30, paddingHorizontal: 10, justifyContent: "center", borderRadius: 8, borderWidth: 1,
              borderColor: props.value === o().value ? colors.accentFill : colors.fieldBorder,
              backgroundColor: props.value === o().value ? tints.accent : "transparent",
            }}
          >
            <Text style={{ fontSize: 13.5, color: colors.text }}>{o().label}</Text>
          </View>
        )}
      </Each>
    </View>
  );
}

export function Avatar(props: { name: string; agent?: boolean; size?: number }) {
  const s = () => props.size ?? 32;
  return (
    <View style={{ width: s(), height: s(), borderRadius: props.agent ? 8 : s() / 2, alignItems: "center", justifyContent: "center", backgroundColor: props.agent ? tints.accent : alpha(colors.text, 0.08) }}>
      <Text style={{ fontSize: s() * 0.42, fontWeight: "600", color: props.agent ? colors.accent : colors.text }}>{(props.name.trim()[0] ?? "?").toUpperCase()}</Text>
    </View>
  );
}

export function Dot(props: { on: boolean }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: props.on ? colors.up : colors.faint }} />;
}

export function Panel(props: { title: string; children: JSX.Element; right?: JSX.Element; style?: ViewStyle }) {
  return (
    <View style={[{ gap: 12, padding: 18, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }, props.style ?? null]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 16, fontWeight: "600", color: colors.text }}>{props.title}</Text>
        {props.right}
      </View>
      {props.children}
    </View>
  );
}

export const time = (ms: number) => {
  const d = new Date(ms), now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};

export function Header(props: { title: string; subtitle?: string; back?: boolean; onBack?: () => void; right?: JSX.Element; backLabel?: string }) {
  return (
    <View desktop={{ windowDrag: true }} style={{ minHeight: 56, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <If when={props.back}>
        <View role="button" testID="back" accessibilityLabel={props.backLabel ?? L("Back", "返回")} onPress={() => props.onBack?.()} hoverStyle={hovered()} style={{ width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center" }}>
          <Icon name="back" size={18} tint={colors.text} />
        </View>
      </If>
      <View style={{ flex: 1, paddingVertical: 8 }}>
        <Text style={{ fontSize: 16.5, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{props.title}</Text>
        <If when={props.subtitle}>
          <Text style={{ fontSize: 13, color: colors.muted, numberOfLines: 1 }}>{props.subtitle}</Text>
        </If>
      </View>
      {props.right}
    </View>
  );
}

/** Who wrote it, as people read it. */
export function authorOf(t: Team, m: { kind: "user" | "agent"; id: string }) {
  if (m.kind === "agent") {
    const a = t.agents().find((x) => x.id === m.id);
    return { name: a?.name || a?.handle || L("Agent", "Agent"), handle: a?.handle ?? "", agent: true };
  }
  const u = t.users().find((x) => x.id === m.id);
  return { name: u?.name || u?.handle || "?", handle: u?.handle ?? "", agent: false };
}

export const failed = (r: { status: number; data: any }) =>
  typeof r.data?.error === "string" && r.data.error ? r.data.error : L(`The server returned ${r.status}`, `服务器返回 ${r.status}`);

/** A small pill: a runtime, a role, a state. */
export function Tag(props: { label: string; tone?: "accent" | "muted" | "warn" | "up" | "danger"; testID?: string }) {
  const fg = () => ({ accent: colors.accent, warn: colors.warn, up: colors.up, danger: colors.danger, muted: colors.muted })[props.tone ?? "muted"];
  const bg = () => ({ accent: tints.accent, warn: tints.warn, up: alpha(colors.up, 0.12), danger: tints.danger, muted: alpha(colors.text, 0.06) })[props.tone ?? "muted"];
  return (
    <View style={{ height: 19, paddingHorizontal: 6, borderRadius: 5, justifyContent: "center", backgroundColor: bg() }}>
      <Text testID={props.testID} style={{ fontSize: 11.5, fontWeight: "600", color: fg(), numberOfLines: 1 }}>{props.label}</Text>
    </View>
  );
}

/** Which runtime an agent runs: shown wherever an agent is (lists, the @ picker, members, task cards). */
export function RuntimeBadge(props: { runtime: string; testID?: string }) {
  return <Tag testID={props.testID} label={runtimeLabel(props.runtime)} tone={props.runtime === "codex" ? "accent" : "muted"} />;
}

/** An agent's status dot (as in Raft): grey offline (no machine, or it is off), orange an error it can't get past by
 * itself (its runtime missing or logged out, or its last run failed), yellow working, green ready. What a task needs
 * from people is on the task, not here. */
export function agentState(t: Team, a: Agent): { label: string; tone: "up" | "warn" | "danger" | "muted" | "accent"; blocked: boolean } {
  const m = t.machines().find((x) => x.id === a.machine_id);
  const why = blockedReason(a, m, lang() !== "zh");
  if (!a.machine_id || !m || !m.online) return { label: L(`Offline: ${why}`, `离线：${why}`), tone: "muted", blocked: true };
  if (why) return { label: L(`Error: ${why}`, `出错：${why}`), tone: "danger", blocked: true };
  const ts = Object.values(t.tasks()).filter((x) => x.agent_id === a.id);
  const working = ts.filter((x) => x.state === "running" || x.state === "queued").length;
  if (working) return { label: L(`Working · ${working} task${working > 1 ? "s" : ""}`, `工作中 · ${working} 个任务`), tone: "warn", blocked: false };
  const last = ts.filter((x) => x.state !== "closed").sort((x, y) => y.updated - x.updated)[0];
  if (last?.state === "failed") return { label: L("Error: its last run failed", "出错：上次运行失败"), tone: "danger", blocked: false };
  return { label: L("Ready", "空闲"), tone: "up", blocked: false };
}

export function StateDot(props: { tone: string }) {
  const c = () => ({ up: colors.up, warn: colors.warn, danger: colors.danger, accent: colors.accent })[props.tone] ?? colors.faint;
  return <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: c() }} />;
}

/** A label above a group of controls. */
export function Label(props: { text: string; note?: string }) {
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: colors.muted }}>{props.text}</Text>
      <If when={props.note}>
        <Text style={{ fontSize: 12.5, lineHeight: 18, color: colors.faint }}>{props.note}</Text>
      </If>
    </View>
  );
}

/** A selectable card (a machine or a runtime in the New agent dialog); a disabled one says why. */
export function PickCard(props: { testID?: string; title: string; note: string; picked: boolean; disabled?: boolean; right?: JSX.Element; onPress: () => void }) {
  return (
    <View
      role="radio"
      testID={props.testID}
      accessibilityState={{ checked: props.picked, disabled: !!props.disabled }}
      onPress={() => !props.disabled && props.onPress()}
      hoverStyle={props.disabled ? undefined : hovered()}
      style={{
        flexGrow: 1, flexBasis: 180, gap: 4, padding: 12, borderRadius: 10, borderWidth: props.picked ? 1.5 : 1,
        borderColor: props.picked ? colors.accentFill : colors.fieldBorder, backgroundColor: props.picked ? tints.accent : "transparent", opacity: props.disabled ? 0.5 : 1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={{ flex: 1, fontSize: 14.5, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{props.title}</Text>
        {props.right}
      </View>
      <Text style={{ fontSize: 12.5, lineHeight: 18, color: colors.muted }}>{props.note}</Text>
    </View>
  );
}

export const mono = { fontFamily: "monospace" } as const;
