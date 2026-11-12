import { Text, View, type JSX } from "nsh";
import { Icon, type IconName } from "./icons";
import { PopMenu } from "./menu";
import { hovered, radius, size, slop, space, tone, type Tone } from "./theme";

/**
 * A `Tag` that opens a menu: a small state on a card (a reminder's "⏰ 每 10 分钟 · 下次 10:32") with what can be done
 * to it. `tone` "default" while it is on, "muted" when it is on hold. Fill it with `MenuRow`s.
 */
export function TagMenu(props: { label: string; tone?: Tone; icon?: IconName; testID?: string; children: JSX.Element }) {
  const t = () => tone(props.tone ?? "muted");
  return (
    <PopMenu
      align="start"
      trigger={
        <View role="button" testID={props.testID} accessibilityLabel={props.label}
          hoverStyle={hovered()}
          hitSlop={slop(size.mark.tag)}
          style={{ alignSelf: "flex-start", minHeight: size.mark.tag, flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.sm, borderRadius: radius.sm,
            backgroundColor: t().tint }}>
          {props.icon ? <Icon name={props.icon} size={size.icon.sm} tint={t().fg} /> : null}
          <Text style={{ fontSize: size.text.caption, fontWeight: "600", color: t().fg, numberOfLines: 1 }}>{props.label}</Text>
        </View>
      }
    >
      {props.children}
    </PopMenu>
  );
}
