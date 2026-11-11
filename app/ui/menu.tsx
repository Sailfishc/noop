import { Text, View, type JSX } from "nsh";
import { Menu, MenuItem, MenuSeparator } from "nsh/base";
import { Icon, type IconName } from "./icons";
import { alpha, colors, hovered, scale } from "./theme";

/**
 * A menu of actions that opens from `trigger` (nsh/base's `Menu`: a popup on desktops, a sheet on phones; keys,
 * Escape and a press outside included). Fill it with `MenuRow`, `MenuLine` and `MenuHeading`.
 */
export function PopMenu(props: { trigger: JSX.Element; placement?: "top" | "bottom"; align?: "start" | "end"; minWidth?: number; maxHeight?: number; children: JSX.Element }) {
  return (
    <Menu
      align={props.align ?? "start"}
      placement={props.placement}
      offset={4}
      margin={8}
      popupStyle={{ minWidth: props.minWidth ?? 200, maxHeight: props.maxHeight, padding: 4, borderRadius: scale.radius.lg, borderWidth: 1, borderColor: alpha(colors.text, 0.1), backgroundColor: colors.surface, boxShadow: "0 8px 28px rgba(0,0,0,0.14)" }}
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
      style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 32, paddingHorizontal: 8, borderRadius: scale.radius.sm }}
    >
      <If when={props.checked !== undefined}>
        <View style={{ width: 16, alignItems: "center" }}>
          <If when={props.checked}><Icon name="check" size={14} tint={colors.accent} /></If>
        </View>
      </If>
      <If when={props.icon}>
        <Icon name={props.icon!} size={16} tint={props.danger ? colors.danger : colors.muted} />
      </If>
      <Text style={{ flex: 1, fontSize: scale.text.body, color: props.danger ? colors.danger : colors.text, numberOfLines: 1 }}>{props.label}</Text>
      <If when={props.right}>
        <Text style={{ fontSize: scale.text.caption, color: colors.faint }}>{props.right}</Text>
      </If>
    </MenuItem>
  );
}

/** A line between groups of rows in a `PopMenu`. */
export function MenuLine() {
  return <MenuSeparator style={{ height: 1, marginVertical: 4, marginHorizontal: 8, backgroundColor: alpha(colors.text, 0.07) }} />;
}

/** A small heading over a group of rows in a `PopMenu`. */
export function MenuHeading(props: { text: string }) {
  return <Text style={{ paddingHorizontal: 8, paddingTop: 4, paddingBottom: 6, fontSize: scale.text.caption, fontWeight: "600", color: colors.faint }}>{props.text}</Text>;
}
