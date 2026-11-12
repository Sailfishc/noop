import { Text, View, type JSX } from "nsh";
import { Icon, type IconName } from "./icons";
import { PopMenu } from "./menu";
import { alpha, colors, scale, tints } from "./theme";

/**
 * A `Tag` that opens a menu: a small state on a card (a reminder's "⏰ 每 10 分钟 · 下次 10:32") with what can be done
 * to it. `tone` "accent" while it is on, "muted" when it is on hold. Fill it with `MenuRow`s.
 */
export function TagMenu(props: { label: string; tone?: "accent" | "muted"; icon?: IconName; testID?: string; children: JSX.Element }) {
  const fg = () => (props.tone === "accent" ? colors.accent : colors.muted);
  return (
    <PopMenu
      align="start"
      minWidth={180}
      trigger={
        <View role="button" testID={props.testID} accessibilityLabel={props.label}
          hoverStyle={{ opacity: 0.8 }}
          style={{ alignSelf: "flex-start", height: 20, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, borderRadius: scale.radius.sm,
            backgroundColor: props.tone === "accent" ? tints.accent : alpha(colors.text, 0.06) }}>
          {props.icon ? <Icon name={props.icon} size={11} tint={fg()} /> : null}
          <Text style={{ fontSize: scale.text.caption, fontWeight: "600", color: fg(), numberOfLines: 1 }}>{props.label}</Text>
        </View>
      }
    >
      {props.children}
    </PopMenu>
  );
}
