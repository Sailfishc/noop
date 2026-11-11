import { Text } from "nsh";
import { Button } from "nsh/base";
import { type IconName, Icon } from "./icons";
import { Spinner } from "./spinner";
import { Tip } from "./tip";
import { alpha, colors, focusRing, hovered, scale, tints } from "./theme";

/** A button's look: `primary` the one main action of its area, `plain` the others, `ghost` a quiet one (Cancel),
 * `danger` one that removes or stops something. */
export type ButtonKind = "primary" | "plain" | "ghost" | "danger";

const fg = (k: ButtonKind) => (k === "primary" ? colors.onAccent : k === "danger" ? colors.danger : k === "ghost" ? colors.muted : colors.text);
const bg = (k: ButtonKind) => (k === "primary" ? colors.accentFill : k === "danger" ? tints.danger : k === "plain" ? colors.surface : "transparent");

/**
 * A button with a label (nsh/base's `Button`: presses, keyboard focus, the disabled state and its role come from
 * NSH). Standard height 40, `small` 30. `busy` shows a spinner in place of the icon and takes no presses; `grow`
 * shares a row with its siblings.
 */
export function Btn(props: { label: string; onPress: () => void; kind?: ButtonKind; testID?: string; busy?: boolean; disabled?: boolean; icon?: IconName; grow?: boolean; small?: boolean }) {
  const kind = () => props.kind ?? "plain";
  return (
    <Button
      testID={props.testID}
      accessibilityLabel={props.label}
      disabled={!!props.disabled}
      onPress={() => !props.busy && props.onPress()}
      hoverStyle={kind() === "primary" ? { opacity: 0.92 } : hovered()}
      focusStyle={focusRing(2)}
      disabledStyle={{ opacity: 0.45 }}
      style={{
        minHeight: props.small ? scale.control.sm : scale.control.md,
        flexGrow: props.grow ? 1 : 0,
        flexShrink: 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingHorizontal: props.small ? 12 : 16,
        borderRadius: scale.radius.md,
        borderWidth: kind() === "plain" ? 0.5 : 0,
        borderColor: colors.fieldBorder,
        backgroundColor: bg(kind()),
      }}
    >
      <If when={props.busy}>
        <Spinner size={14} tint={fg(kind())} />
      </If>
      <If when={!props.busy && props.icon}>
        <Icon name={props.icon!} size={16} tint={fg(kind())} />
      </If>
      <Text style={{ fontSize: props.small ? scale.text.body : scale.text.message, fontWeight: kind() === "primary" ? "600" : "500", color: fg(kind()), numberOfLines: 1 }}>{props.label}</Text>
    </Button>
  );
}

/**
 * A button that is only an icon (close, copy, add, back). `label` is what it does: screen readers say it and the
 * pointer shows it as a tooltip, so every icon button explains itself. `size` 24 or 32 (default); `selected` keeps it
 * filled while what it opens is open or it is on; `tone` colors the icon.
 */
export function IconBtn(props: {
  icon: IconName;
  label: string;
  onPress: () => void;
  size?: "sm" | "md";
  selected?: boolean;
  disabled?: boolean;
  tone?: "default" | "muted" | "accent" | "danger";
  testID?: string;
}) {
  const box = () => (props.size === "sm" ? 24 : 32);
  const tint = () => ({ default: colors.text, muted: colors.muted, accent: colors.accent, danger: colors.danger })[props.tone ?? "default"];
  return (
    <Button
      testID={props.testID}
      accessibilityLabel={props.label}
      tooltip={<Tip label={props.label} placement="bottom" />}
      disabled={!!props.disabled}
      selected={!!props.selected}
      onPress={props.onPress}
      hitSlop={props.size === "sm" ? 4 : 0}
      hoverStyle={hovered()}
      focusStyle={focusRing(1)}
      selectedStyle={{ backgroundColor: alpha(colors.text, 0.08) }}
      disabledStyle={{ opacity: 0.45 }}
      style={{ width: box(), height: box(), borderRadius: scale.radius.md, alignItems: "center", justifyContent: "center" }}
    >
      <Icon name={props.icon} size={props.size === "sm" ? 14 : 18} tint={tint()} />
    </Button>
  );
}
