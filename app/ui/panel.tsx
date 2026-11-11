import { Text, View, type JSX, type ViewStyle } from "nsh";
import { Noted } from "./noted";
import { colors } from "./theme";

export function Panel(props: { title: string; note?: string; testID?: string; children: JSX.Element; right?: JSX.Element; style?: ViewStyle }) {
  return (
    <View style={[{ gap: 12, padding: 18, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }, props.style ?? null]}>
      <Noted
        note={props.note}
        testID={props.testID}
        label={<Text style={{ fontSize: 16, fontWeight: "600", color: colors.text }}>{props.title}</Text>}
        right={props.right}
      />
      {props.children}
    </View>
  );
}
