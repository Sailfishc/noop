import { Text, View, type JSX } from "nsh";
import { Button } from "nsh/base";
import { colors, focusRing, hovered, pressMotion, radius, size, space } from "./theme";

/**
 * A row of a list you press (a channel, a member, an agent, a task): `left` (an icon, an avatar), the `title` and
 * an optional `subtitle`, `right` at the end (a count, a tag, actions). `selected` keeps it filled (the open one).
 * Rows are the density's `row.sm` tall, `row.md` with a subtitle (minimum heights: they grow with the text size).
 */
export function ListRow(props: { title: string; subtitle?: string; left?: JSX.Element; right?: JSX.Element; selected?: boolean; onPress: () => void; testID?: string; label?: string }) {
  const press = pressMotion();
  return (
    <Button
      testID={props.testID}
      accessibilityLabel={props.label}
      selected={!!props.selected}
      onPress={props.onPress}
      {...press.handlers}
      hoverStyle={hovered()}
      focusStyle={focusRing()}
      selectedStyle={{ backgroundColor: colors.selected }}
      style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: props.subtitle ? size.row.md : size.row.sm, paddingHorizontal: space.md, borderRadius: radius.md, ...press.style }}
    >
      {props.left}
      <View style={{ flex: 1, gap: space.xxs }}>
        <Text style={{ fontSize: size.text.body, fontWeight: props.selected ? "600" : "400", color: colors.fg, numberOfLines: 1 }}>{props.title}</Text>
        <If when={props.subtitle}>
          <Text style={{ fontSize: size.text.caption, color: colors.fg2, numberOfLines: 1 }}>{props.subtitle}</Text>
        </If>
      </View>
      {props.right}
    </Button>
  );
}
