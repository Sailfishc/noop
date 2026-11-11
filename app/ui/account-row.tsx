import { Text, View, type JSX } from "nsh";
import { Avatar } from "./avatar";
import { Dot } from "./dot";
import { Icon } from "./icons";
import { colors, hovered, scale } from "./theme";

/**
 * The sidebar's bottom row: me (an avatar, my name, a dot and the connection's state) and a gear at the end. Its
 * avatar, name and gear sit in the same columns as the private-chat rows and the section gear above it, so the
 * footer lines up with the list. Meant as a `PopMenu` trigger: it has no `onPress` of its own.
 */
export function AccountRow(props: { name: string; status: string; live: boolean; label?: string; testID?: string; nameTestID?: string; statusTestID?: string }): JSX.Element {
  return (
    <View role="button" testID={props.testID} accessibilityLabel={props.label} hoverStyle={hovered()}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingHorizontal: 10, borderRadius: scale.radius.md }}>
      <Avatar name={props.name || "?"} size={22} />
      <View style={{ flex: 1, gap: 1 }}>
        <Text testID={props.nameTestID} style={{ fontSize: scale.text.message, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{props.name}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <Dot on={props.live} />
          <Text testID={props.statusTestID} style={{ flex: 1, fontSize: scale.text.caption, color: colors.muted, numberOfLines: 1 }}>{props.status}</Text>
        </View>
      </View>
      <View style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center" }}>
        <Icon name="settings" size={14} tint={colors.muted} />
      </View>
    </View>
  );
}
