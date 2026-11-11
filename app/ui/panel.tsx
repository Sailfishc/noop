import { Text, View, type JSX, type ViewStyle } from "nsh";
import { Noted } from "./noted";
import { colors, scale } from "./theme";

/** A titled section on a surface (a settings group), its note behind the title's ⓘ; `right` at the title's end. */
export function Panel(props: { title: string; note?: string; testID?: string; children: JSX.Element; right?: JSX.Element; style?: ViewStyle }) {
  return (
    <View style={[{ gap: 12, padding: 16, borderRadius: scale.radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }, props.style ?? null]}>
      <Noted
        note={props.note}
        testID={props.testID}
        label={<Text style={{ fontSize: scale.text.title, fontWeight: "600", color: colors.text }}>{props.title}</Text>}
        right={props.right}
      />
      {props.children}
    </View>
  );
}

/**
 * A bordered box with no title, for a group of things that belong together (an editor and its buttons, a picked
 * item). `tight` pads 8 instead of 12; `flat` leaves the background out.
 */
export function Card(props: { children: JSX.Element; tight?: boolean; flat?: boolean; testID?: string }) {
  return (
    <View testID={props.testID} style={{ gap: props.tight ? 6 : 8, padding: props.tight ? 8 : 12, borderRadius: scale.radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: props.flat ? "transparent" : colors.surface }}>
      {props.children}
    </View>
  );
}
