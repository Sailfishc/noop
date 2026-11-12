import { Text, View, type JSX } from "nsh";
import { Avatar } from "./avatar";
import { Dot } from "./dot";
import { Icon } from "./icons";
import { colors, hovered, radius, size, space } from "./theme";

/**
 * The sidebar's bottom row: me (an avatar, my name, a dot and the connection's state) and a gear at the end. Its
 * avatar, name and gear sit in the same columns as the private-chat rows and the section gear above it, so the
 * footer lines up with the list. Meant as a `PopMenu` trigger: it has no `onPress` of its own.
 */
export function AccountRow(props: { name: string; status: string; live: boolean; label?: string; testID?: string; nameTestID?: string; statusTestID?: string }): JSX.Element {
  return (
    <View role="button" testID={props.testID} accessibilityLabel={props.label} hoverStyle={hovered()}
      style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: size.row.md, paddingHorizontal: space.md, borderRadius: radius.md }}>
      <Avatar name={props.name || "?"} size="sm" />
      <View style={{ flex: 1, gap: space.xxs }}>
        <Text testID={props.nameTestID} style={{ fontSize: size.text.message, fontWeight: "600", color: colors.fg, numberOfLines: 1 }}>{props.name}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Dot on={props.live} />
          <Text testID={props.statusTestID} style={{ flex: 1, fontSize: size.text.caption, color: colors.fg2, numberOfLines: 1 }}>{props.status}</Text>
        </View>
      </View>
      <View style={{ width: size.iconButton.sm, height: size.iconButton.sm, alignItems: "center", justifyContent: "center" }}>
        <Icon name="settings" size={size.icon.sm} tint={colors.fg2} />
      </View>
    </View>
  );
}
