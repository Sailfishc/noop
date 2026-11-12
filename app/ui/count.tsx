import { Text, View } from "nsh";
import { colors, radius, size, space } from "./theme";

/**
 * A count after a row's label. `quiet` (default: unread messages) is a plain number in the tertiary text;
 * `attention` (what waits on you) is the amber pill, the only colored count. Shows nothing for 0.
 */
export function Count(props: { n: number; tone?: "quiet" | "attention"; testID?: string }) {
  return (
    <If when={props.n > 0}>
      <If
        when={props.tone === "attention"}
        else={<Text testID={props.testID} style={{ fontSize: size.text.caption, color: colors.fg3, fontVariant: ["tabular-nums"] }}>{String(props.n)}</Text>}
      >
        <View style={{ minWidth: size.mark.count, minHeight: size.mark.count, paddingHorizontal: space.sm, borderRadius: radius.full, alignItems: "center", justifyContent: "center", backgroundColor: colors.attention }}>
          <Text testID={props.testID} style={{ fontSize: size.text.caption, fontWeight: "600", color: colors.onAttention, fontVariant: ["tabular-nums"] }}>{String(props.n)}</Text>
        </View>
      </If>
    </If>
  );
}
