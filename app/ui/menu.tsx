import { Text, View, type JSX } from "nsh";
import { Menu, MenuItem, MenuSeparator } from "nsh/base";
import { Icon, type IconName } from "./icons";
import { colors, floatSurface, hovered, measure, radius, size, space, stroke } from "./theme";

/**
 * A menu of actions that opens from `trigger` (nsh/base's `Menu`: a floating surface on desktops, a sheet on phones;
 * keys, Escape and a press outside included); `wide` for a menu of longer rows (the account menu). Fill it with `MenuRow`, `MenuLine` and `MenuHeading`.
 */
export function PopMenu(props: { trigger: JSX.Element; placement?: "top" | "bottom"; align?: "start" | "end"; wide?: boolean; maxHeight?: number; children: JSX.Element }) {
  return (
    <Menu
      align={props.align ?? "start"}
      placement={props.placement}
      offset={space.xs}
      margin={space.md}
      popupStyle={[floatSurface(), { minWidth: props.wide ? measure.menuWide : measure.menu, maxHeight: props.maxHeight, padding: space.xs }]}
      backdropClass="bg-scrim"
      trigger={props.trigger}
    >
      {props.children}
    </Menu>
  );
}

/**
 * One row of a `PopMenu`: an optional icon, the label, `right` (a shortcut, a count) at the end. `checked` makes it a
 * pick of several (a check mark before it); `danger` for an action that removes or leaves.
 */
export function MenuRow(props: { label: string; onSelect: () => void; icon?: IconName; right?: string; checked?: boolean; danger?: boolean; testID?: string }) {
  return (
    <MenuItem
      testID={props.testID}
      onSelect={props.onSelect}
      checked={props.checked === undefined ? undefined : props.checked}
      hoverStyle={hovered()}
      activeStyle={hovered()}
      style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: size.row.menu, paddingHorizontal: space.md, borderRadius: radius.sm }}
    >
      <If when={props.checked !== undefined}>
        <View style={{ width: size.icon.md, alignItems: "center" }}>
          <If when={props.checked}><Icon name="check" size={size.icon.sm} tint={colors.fg} /></If>
        </View>
      </If>
      <If when={props.icon}>
        <Icon name={props.icon!} size={size.icon.md} tint={props.danger ? colors.danger : colors.fg2} />
      </If>
      <Text style={{ flex: 1, fontSize: size.text.body, color: props.danger ? colors.danger : colors.fg, numberOfLines: 1 }}>{props.label}</Text>
      <If when={props.right}>
        <Text style={{ fontSize: size.text.caption, color: colors.fg3 }}>{props.right}</Text>
      </If>
    </MenuItem>
  );
}

/** A line between groups of rows in a `PopMenu`. */
export function MenuLine() {
  return <MenuSeparator style={{ height: stroke.hairline, marginVertical: space.xs, marginHorizontal: space.md, backgroundColor: colors.hairline }} />;
}

/** A small heading over a group of rows in a `PopMenu`. */
export function MenuHeading(props: { text: string }) {
  return <Text style={{ paddingHorizontal: space.md, paddingTop: space.xs, paddingBottom: space.sm, fontSize: size.text.caption, fontWeight: "600", color: colors.fg3 }}>{props.text}</Text>;
}
