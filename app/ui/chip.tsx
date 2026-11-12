import { Text, View } from "nsh";
import { Button } from "nsh/base";
import { Icon, type IconName } from "./icons";
import { colors, focusRing, hovered, radius, size, slop, space } from "./theme";

/**
 * A dismissible context pill above a composer (e.g. "继续和 @acha 聊 ×"): shows a short label and a close button that
 * clears it. Touch hit target reaches 44pt via `slop`.
 */
export function Chip(props: { label: string; dismissLabel: string; onDismiss: () => void; icon?: IconName; testID?: string }) {
  return (
    <View
      testID={props.testID}
      style={{
        alignSelf: "flex-start",
        minHeight: size.mark.tag,
        flexDirection: "row",
        alignItems: "center",
        gap: space.xs,
        paddingLeft: space.sm,
        paddingRight: space.xs,
        borderRadius: radius.full,
        backgroundColor: colors.selected,
      }}
    >
      <If when={props.icon}>
        <Icon name={props.icon!} size={size.icon.sm} tint={colors.fg2} />
      </If>
      <Text style={{ fontSize: size.text.caption, lineHeight: size.leading.caption, fontWeight: "500", color: colors.fg2, numberOfLines: 1 }}>{props.label}</Text>
      <Button
        testID={props.testID ? `${props.testID}-dismiss` : undefined}
        accessibilityLabel={props.dismissLabel}
        onPress={props.onDismiss}
        hitSlop={slop(size.mark.info)}
        hoverStyle={hovered()}
        focusStyle={focusRing("out")}
        style={{ width: size.mark.info, height: size.mark.info, borderRadius: radius.full, alignItems: "center", justifyContent: "center" }}
      >
        <Icon name="close" size={size.icon.sm} tint={colors.fg3} />
      </Button>
    </View>
  );
}
