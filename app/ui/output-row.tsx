import { Text, View } from "nsh";
import { Button } from "nsh/base";
import { Icon, type IconName } from "./icons";
import { colors, focusRing, hovered, radius, size, slop, space, stroke, tone } from "./theme";

/**
 * One compact 1-line output card on a message (or in a channel's files list): an icon, its title, a short status/version
 * note, and a chevron to open it in the right-hand workspace panel.
 */
export function OutputRow(props: {
  icon: IconName;
  title: string;
  meta?: string;
  tone?: "muted" | "attention" | "danger" | "ok";
  selected?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const metaFg = () => (props.tone && props.tone !== "muted" ? tone(props.tone).fg : colors.fg3);
  return (
    <Button
      testID={props.testID}
      accessibilityLabel={props.meta ? `${props.title} · ${props.meta}` : props.title}
      onPress={props.onPress}
      hitSlop={slop(size.control.md)}
      hoverStyle={props.selected ? undefined : hovered()}
      focusStyle={focusRing("inset")}
      style={{
        minHeight: size.control.md,
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        paddingHorizontal: space.md,
        borderRadius: radius.md,
        borderWidth: stroke.hairline,
        borderColor: colors.hairline,
        backgroundColor: props.selected ? colors.selected : colors.raised,
      }}
    >
      <Icon name={props.icon} size={size.icon.md} tint={colors.fg2} />
      <Text style={{ flex: 1, fontSize: size.text.body, fontWeight: "500", color: colors.fg, numberOfLines: 1 }}>{props.title}</Text>
      <If when={props.meta}>
        <Text style={{ fontSize: size.text.caption, color: metaFg(), numberOfLines: 1 }}>{props.meta}</Text>
      </If>
      <Icon name="chevron" size={size.icon.sm} tint={colors.fg3} />
    </Button>
  );
}
