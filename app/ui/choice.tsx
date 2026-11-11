import { Text, View } from "nsh";
import { colors, hovered, tints } from "./theme";

/** A row of choices, one picked. */
export function Choice<T extends string>(props: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; testID?: string }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      <Each of={props.options}>
        {(o) => (
          <View
            role="button"
            testID={props.testID ? `${props.testID}-${o().value}` : undefined}
            accessibilityState={{ selected: props.value === o().value }}
            onPress={() => props.onChange(o().value)}
            hoverStyle={hovered()}
            style={{
              height: 30, paddingHorizontal: 10, justifyContent: "center", borderRadius: 8, borderWidth: 1,
              borderColor: props.value === o().value ? colors.accentFill : colors.fieldBorder,
              backgroundColor: props.value === o().value ? tints.accent : "transparent",
            }}
          >
            <Text style={{ fontSize: 13.5, color: colors.text }}>{o().label}</Text>
          </View>
        )}
      </Each>
    </View>
  );
}
