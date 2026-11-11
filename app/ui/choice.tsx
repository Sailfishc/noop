import { Text } from "nsh";
import { Toggle, ToggleGroup } from "nsh/base";
import { colors, focusRing, hovered, scale, tints } from "./theme";

/**
 * A row of choices, one picked (a segmented choice: nsh/base's `ToggleGroup` of `Toggle`s, so the arrow keys move
 * along it and screen readers hear which is pressed). For more options than fit in a row, use `Dropdown`.
 * Test ids: `<testID>-<value>`.
 */
export function Choice<T extends string>(props: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; testID?: string }) {
  return (
    <ToggleGroup style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      <Each of={props.options}>
        {(o) => (
          <Toggle
            testID={props.testID ? `${props.testID}-${o().value}` : undefined}
            pressed={props.value === o().value}
            onChange={() => props.onChange(o().value)}
            hoverStyle={hovered()}
            focusStyle={focusRing(1)}
            style={{
              height: scale.control.sm, paddingHorizontal: 12, justifyContent: "center", borderRadius: scale.radius.md, borderWidth: 1,
              borderColor: props.value === o().value ? colors.accentFill : colors.fieldBorder,
              backgroundColor: props.value === o().value ? tints.accent : "transparent",
            }}
          >
            <Text style={{ fontSize: scale.text.body, color: colors.text }}>{o().label}</Text>
          </Toggle>
        )}
      </Each>
    </ToggleGroup>
  );
}
