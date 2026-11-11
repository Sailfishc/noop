import { Text, View, type JSX } from "nsh";
import { colors, hovered, tints } from "./theme";

/** A selectable card (a machine or a runtime in the New agent dialog); a disabled one says why. */
export function PickCard(props: { testID?: string; title: string; note: string; picked: boolean; disabled?: boolean; right?: JSX.Element; onPress: () => void }) {
  return (
    <View
      role="radio"
      testID={props.testID}
      accessibilityState={{ checked: props.picked, disabled: !!props.disabled }}
      onPress={() => !props.disabled && props.onPress()}
      hoverStyle={props.disabled ? undefined : hovered()}
      style={{
        flexGrow: 1, flexBasis: 180, gap: 4, padding: 12, borderRadius: 10, borderWidth: props.picked ? 1.5 : 1,
        borderColor: props.picked ? colors.accentFill : colors.fieldBorder, backgroundColor: props.picked ? tints.accent : "transparent", opacity: props.disabled ? 0.5 : 1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={{ flex: 1, fontSize: 14.5, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{props.title}</Text>
        {props.right}
      </View>
      <Text style={{ fontSize: 12.5, lineHeight: 18, color: colors.muted }}>{props.note}</Text>
    </View>
  );
}
