import { Text, View, type JSX } from "nsh";
import { colors, hovered, measure, opacity, radius, size, space, stroke } from "./theme";

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
        flexGrow: 1, flexBasis: measure.menu, gap: space.xs, padding: space.lg, borderRadius: radius.lg, borderWidth: stroke.edge,
        borderColor: props.picked ? colors.primary : colors.edge, backgroundColor: props.picked ? colors.selected : "transparent", opacity: props.disabled ? opacity.disabled : 1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text style={{ flex: 1, fontSize: size.text.message, fontWeight: "600", color: colors.fg, numberOfLines: 1 }}>{props.title}</Text>
        {props.right}
      </View>
      <Text style={{ fontSize: size.text.caption, lineHeight: size.leading.caption, color: colors.fg2 }}>{props.note}</Text>
    </View>
  );
}
