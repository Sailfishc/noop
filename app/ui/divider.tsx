import { View } from "nsh";
import { colors, space, stroke } from "./theme";

/** A 0.5-point hairline rule (`inset` indents it horizontally, `spaced` adds vertical breathing room). */
export function Divider(props: { inset?: boolean; spaced?: boolean; testID?: string }) {
  return (
    <View
      testID={props.testID}
      style={{
        height: stroke.hairline,
        marginHorizontal: props.inset ? space.xl : undefined,
        marginVertical: props.spaced ? space.sm : undefined,
        backgroundColor: colors.hairline,
      }}
    />
  );
}
