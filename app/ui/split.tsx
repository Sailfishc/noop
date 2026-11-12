import { View, type JSX } from "nsh";
import { colors, measure, stroke } from "./theme";

/**
 * A list beside the one picked from it (the triage desk of 待你决定): `list` a column `measure.list` wide, a hairline,
 * then `detail` taking the rest. Wide windows only; a phone shows one at a time.
 */
export function Split(props: { list: JSX.Element; detail: JSX.Element; listTestID?: string }) {
  return (
    <View style={{ flex: 1, flexDirection: "row" }}>
      <View testID={props.listTestID} style={{ width: measure.list, borderRightWidth: stroke.hairline, borderRightColor: colors.hairline }}>{props.list}</View>
      <View style={{ flex: 1 }}>{props.detail}</View>
    </View>
  );
}
