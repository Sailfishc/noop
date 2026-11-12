import { Text, View } from "nsh";
import { Select } from "nsh/base";
import { Icon } from "./icons";
import { colors, floatSurface, focusRing, hovered, measure, opacity, radius, size, slop, space, stroke } from "./theme";

/**
 * Picks one value from a list (nsh/base's `Select`: a floating list at the trigger on desktops, a sheet on phones, keys
 * and typeahead included). Use it for a choice among more options than fit as a `Choice` row. `small` is the `sm`
 * control height; `searchable` adds a filter field for long lists. Test ids: `<testID>` the trigger.
 */
export function Dropdown(props: {
  options: { value: string; label: string; disabled?: boolean }[];
  value: string | null;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
  searchable?: boolean;
  small?: boolean;
  disabled?: boolean;
  testID?: string;
}) {
  const current = () => props.options.find((o) => o.value === props.value)?.label;
  return (
    <Select
      items={props.options.map((o) => ({ value: o.value, title: o.label, disabled: o.disabled }))}
      value={props.value}
      onChange={({ value }) => value !== null && props.onChange(value)}
      placeholder={props.placeholder}
      accessibilityLabel={props.label}
      searchable={props.searchable}
      disabled={props.disabled}
      offset={space.xs}
      margin={space.md}
      popupStyle={[floatSurface(), { padding: space.xs, maxHeight: measure.list }]}
      itemClass="focus:bg-hover selected:bg-selected disabled:opacity-45"
      itemStyle={{ minHeight: size.row.menu, justifyContent: "center", paddingHorizontal: space.md, borderRadius: radius.sm, fontSize: size.text.body, color: colors.fg }}
      backdropClass="bg-scrim"
      trigger={
        <View
          testID={props.testID}
          hitSlop={slop(props.small ? size.control.sm : size.control.md)}
          hoverStyle={hovered()}
          focusStyle={focusRing("edge")}
          style={{
            minHeight: props.small ? size.control.sm : size.control.md,
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            paddingHorizontal: props.small ? space.md : space.lg,
            borderRadius: radius.md,
            borderWidth: stroke.edge,
            borderColor: colors.edge,
            backgroundColor: colors.field,
            opacity: props.disabled ? opacity.disabled : 1,
          }}
        >
          <Text style={{ flex: 1, fontSize: props.small ? size.text.body : size.text.message, color: current() ? colors.fg : colors.fg3, numberOfLines: 1 }}>{current() ?? props.placeholder ?? ""}</Text>
          <Icon name="chevron-down" size={size.icon.sm} tint={colors.fg3} />
        </View>
      }
    />
  );
}
