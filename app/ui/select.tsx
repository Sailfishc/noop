import { Text, View } from "nsh";
import { Select } from "nsh/base";
import { Icon } from "./icons";
import { colors, focusRing, hovered, scale } from "./theme";

/**
 * Picks one value from a list (nsh/base's `Select`: a popup at the trigger on desktops, a sheet on phones, keys and
 * typeahead included). Use it for a choice among more options than fit as a `Choice` row. `small` is 30 tall;
 * `searchable` adds a filter field for long lists. Test ids: `<testID>` the trigger.
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
      offset={4}
      margin={8}
      popupStyle={{ padding: 4, maxHeight: 320, borderRadius: scale.radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, boxShadow: "0 8px 28px rgba(0,0,0,0.14)" }}
      itemClass="rounded-md px-2 focus:bg-foreground/5 selected:bg-brand-tint disabled:opacity-45"
      itemStyle={{ height: 30, justifyContent: "center", fontSize: scale.text.body, color: colors.text }}
      backdropClass="bg-scrim"
      trigger={
        <View
          testID={props.testID}
          hoverStyle={hovered()}
          focusStyle={focusRing(1)}
          style={{
            height: props.small ? scale.control.sm : scale.control.md,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: props.small ? 8 : 12,
            borderRadius: scale.radius.md,
            borderWidth: 1,
            borderColor: colors.fieldBorder,
            backgroundColor: colors.field,
            opacity: props.disabled ? 0.45 : 1,
          }}
        >
          <Text style={{ flex: 1, fontSize: props.small ? scale.text.body : scale.text.message, color: current() ? colors.text : colors.faint, numberOfLines: 1 }}>{current() ?? props.placeholder ?? ""}</Text>
          <Icon name="chevron-down" size={12} tint={colors.faint} />
        </View>
      }
    />
  );
}
