import { Text } from "nsh";
import { Button } from "nsh/base";
import { type IconName, Icon } from "./icons";
import { focusRing, hovered, radius, size, slop, space, tone } from "./theme";

/**
 * A line that opens something elsewhere (a PR, a repository): an icon and its words, in the foreground or `danger`
 * (a failing check). It takes a finger's press over a whole hit target, though it draws one line tall.
 */
export function Link(props: { label: string; onPress: () => void; icon?: IconName; tone?: "default" | "danger"; testID?: string }) {
  const fg = () => tone(props.tone ?? "default").fg;
  return (
    <Button
      role="link"
      testID={props.testID}
      accessibilityLabel={props.label}
      onPress={props.onPress}
      hitSlop={slop(size.leading.body)}
      hoverStyle={hovered()}
      focusStyle={focusRing("out")}
      style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.xxs, borderRadius: radius.sm }}
    >
      <If when={props.icon}>
        <Icon name={props.icon!} size={size.icon.sm} tint={fg()} />
      </If>
      <Text style={{ fontSize: size.text.body, lineHeight: size.leading.body, color: fg(), numberOfLines: 1 }}>{props.label}</Text>
    </Button>
  );
}
