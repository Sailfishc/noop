import { type JSX, Text, View } from "nsh";
import { Button } from "nsh/base";
import { Icon, type IconName } from "./icons";
import { colors, focusRing, hovered, radius, size, slop, space } from "./theme";

/**
 * One quiet expandable line (a silent check summary in a thread, or a folded long reply toggle):
 * an optional icon, its summary and a chevron on one line, opening `children` below when `open` is true.
 */
export function FoldLine(props: { label: string; open: boolean; onToggle: () => void; icon?: IconName; testID?: string; children?: JSX.Element }) {
  return (
    <View style={{ gap: space.xs }}>
      <Button
        testID={props.testID}
        accessibilityLabel={props.label}
        onPress={props.onToggle}
        hitSlop={slop(size.leading.caption)}
        hoverStyle={hovered()}
        focusStyle={focusRing("out")}
        style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.xs, paddingVertical: space.xxs, borderRadius: radius.sm }}
      >
        <If when={props.icon}>
          <Icon name={props.icon!} size={size.icon.sm} tint={colors.fg3} />
        </If>
        <Text style={{ fontSize: size.text.caption, lineHeight: size.leading.caption, color: colors.fg3, numberOfLines: 1 }}>{props.label}</Text>
        <Icon name={props.open ? "chevron-down" : "chevron"} size={size.icon.sm} tint={colors.fg3} />
      </Button>
      <If when={props.open && props.children}>
        <View style={{ paddingLeft: space.md, gap: space.xxs }}>
          {props.children}
        </View>
      </If>
    </View>
  );
}
