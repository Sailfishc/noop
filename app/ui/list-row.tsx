import { Text, View, type JSX } from "nsh";
import { Button } from "nsh/base";
import { alpha, colors, focusRing, hovered, scale } from "./theme";

/**
 * A row of a list you press (a channel, a member, an agent, a task): `left` (an icon, an avatar), the `title` and
 * an optional `subtitle`, `right` at the end (a count, a tag, actions). `selected` keeps it filled (the open one).
 * Rows are 32 tall, 44 with a subtitle.
 */
export function ListRow(props: { title: string; subtitle?: string; left?: JSX.Element; right?: JSX.Element; selected?: boolean; onPress: () => void; testID?: string; label?: string }) {
  return (
    <Button
      testID={props.testID}
      accessibilityLabel={props.label}
      selected={!!props.selected}
      onPress={props.onPress}
      hoverStyle={hovered()}
      focusStyle={focusRing(0)}
      selectedStyle={{ backgroundColor: alpha(colors.text, 0.07) }}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: props.subtitle ? 44 : 32, paddingHorizontal: 8, borderRadius: scale.radius.md }}
    >
      {props.left}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: scale.text.body, fontWeight: props.selected ? "600" : "400", color: colors.text, numberOfLines: 1 }}>{props.title}</Text>
        <If when={props.subtitle}>
          <Text style={{ fontSize: scale.text.caption, color: colors.muted, numberOfLines: 1 }}>{props.subtitle}</Text>
        </If>
      </View>
      {props.right}
    </Button>
  );
}
