import { Text } from "nsh";
import { Button } from "nsh/base";
import { type IconName, Icon } from "./icons";
import { Spinner } from "./spinner";
import { Tip } from "./tip";
import { colors, focusRing, hovered, opacity, pressMotion, radius, size, slop, space, stroke, tone, type Tone } from "./theme";

/** A button's look: `primary` the one main action of its area (black on light, white on dark), `plain` the others,
 * `ghost` a quiet one (Cancel), `danger` one that removes or stops something. */
export type ButtonKind = "primary" | "plain" | "ghost" | "danger";

const fg = (k: ButtonKind) => (k === "primary" ? colors.onPrimary : k === "danger" ? colors.danger : k === "ghost" ? colors.fg2 : colors.fg);
const bg = (k: ButtonKind) => (k === "primary" ? colors.primary : k === "danger" ? colors.dangerTint : k === "plain" ? colors.raised : "transparent");

/**
 * A button with a label (nsh/base's `Button`: presses, keyboard focus, the disabled state and its role come from
 * NSH). Control height `md`, `small` the `sm` one: minimum heights, so a larger text size grows it. It gives a little
 * as it is pressed. `busy` shows a spinner in place of the icon and takes no presses; `grow` shares a row with its
 * siblings.
 */
export function Btn(props: { label: string; onPress: () => void; kind?: ButtonKind; testID?: string; busy?: boolean; disabled?: boolean; icon?: IconName; grow?: boolean; small?: boolean }) {
  const kind = () => props.kind ?? "plain";
  const press = pressMotion();
  return (
    <Button
      testID={props.testID}
      accessibilityLabel={props.label}
      disabled={!!props.disabled}
      onPress={() => !props.busy && props.onPress()}
      {...press.handlers}
      hitSlop={slop(props.small ? size.control.sm : size.control.md)}
      hoverStyle={kind() === "primary" ? { opacity: opacity.hoverPrimary } : hovered()}
      focusStyle={focusRing("out")}
      disabledStyle={{ opacity: opacity.disabled }}
      style={{
        minHeight: props.small ? size.control.sm : size.control.md,
        flexGrow: props.grow ? 1 : 0,
        flexShrink: 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: space.sm,
        paddingHorizontal: props.small ? space.lg : space.xl,
        borderRadius: radius.md,
        borderWidth: kind() === "plain" ? stroke.hairline : 0,
        borderColor: colors.edge,
        backgroundColor: bg(kind()),
        ...press.style,
      }}
    >
      <If when={props.busy}>
        <Spinner size={size.icon.sm} tint={fg(kind())} />
      </If>
      <If when={!props.busy && props.icon}>
        <Icon name={props.icon!} size={size.icon.md} tint={fg(kind())} />
      </If>
      <Text style={{ fontSize: props.small ? size.text.body : size.text.message, fontWeight: kind() === "primary" ? "600" : "500", color: fg(kind()), numberOfLines: 1 }}>{props.label}</Text>
    </Button>
  );
}

/**
 * A button that is only an icon (close, copy, add, back). `label` is what it does: screen readers say it and the
 * pointer shows it as a tooltip, so every icon button explains itself. `size` `md` (default) or `sm`; on touch screens
 * a small one still takes presses over the full hit target. `selected` keeps it filled while what it opens is open or
 * it is on; `tone` colors the icon.
 */
export function IconBtn(props: {
  icon: IconName;
  label: string;
  onPress: () => void;
  size?: "sm" | "md";
  selected?: boolean;
  disabled?: boolean;
  tone?: Tone;
  testID?: string;
}) {
  const box = () => size.iconButton[props.size ?? "md"];
  const press = pressMotion();
  return (
    <Button
      testID={props.testID}
      accessibilityLabel={props.label}
      tooltip={<Tip label={props.label} placement="bottom" />}
      disabled={!!props.disabled}
      selected={!!props.selected}
      onPress={props.onPress}
      {...press.handlers}
      hitSlop={slop(box())}
      hoverStyle={hovered()}
      focusStyle={focusRing("edge")}
      selectedStyle={{ backgroundColor: colors.selected }}
      disabledStyle={{ opacity: opacity.disabled }}
      style={{ width: box(), height: box(), borderRadius: radius.md, alignItems: "center", justifyContent: "center", ...press.style }}
    >
      <Icon name={props.icon} size={props.size === "sm" ? size.icon.sm : size.icon.md} tint={tone(props.tone ?? "default").fg} />
    </Button>
  );
}
