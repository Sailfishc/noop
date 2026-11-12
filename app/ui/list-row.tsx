import { Text, View, type JSX } from "nsh";
import { Button } from "nsh/base";
import { colors, focusRing, hovered, pressMotion, radius, size, space } from "./theme";

/**
 * A row of a list you press (a channel, a member, an agent, a task): `left` (an icon, an avatar), the `title` and
 * an optional `subtitle`, `right` at the end (a count, a tag, actions). `selected` keeps it filled (the open one).
 * Rows are the density's `row.sm` tall, `row.md` with a subtitle (minimum heights: they grow with the text size).
 * `below` is a subtitle that is more than text (an agent's state); `strong` sets the title in semibold (unread);
 * `dim` the secondary strength (a channel I'm not in).
 */
export function ListRow(props: { title: string; subtitle?: string; below?: JSX.Element; left?: JSX.Element; right?: JSX.Element; selected?: boolean; strong?: boolean; dim?: boolean; onPress: () => void; testID?: string; label?: string }) {
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
      style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: props.subtitle || props.below ? size.row.md : size.row.sm, paddingHorizontal: space.md, borderRadius: radius.md, ...press.style }}
    >
      {props.left}
      <View style={{ flex: 1, gap: space.xxs }}>
        <Text style={{ fontSize: size.text.body, fontWeight: props.selected || props.strong ? "600" : "400", color: props.dim ? colors.fg2 : colors.fg, numberOfLines: 1 }}>{props.title}</Text>
        <If when={props.subtitle}>
          <Text style={{ fontSize: size.text.caption, color: colors.fg2, numberOfLines: 1 }}>{props.subtitle}</Text>
        </If>
        {props.below}
      </View>
      {props.right}
    </Button>
  );
}

/** A small heading over a group of rows (频道, 私聊 in the sidebar), with `right` at its end (an add button). */
export function ListHeading(props: { text: string; right?: JSX.Element; testID?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: size.iconButton.sm, paddingLeft: space.md, paddingTop: space.lg, paddingBottom: space.xs }}>
      <Text testID={props.testID} style={{ flex: 1, fontSize: size.text.caption, fontWeight: "600", color: colors.fg3 }}>{props.text}</Text>
      {props.right}
    </View>
  );
}
