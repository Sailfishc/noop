import { Text, View } from "nsh";
import { colors, scale } from "./theme";

/** An unread count: a solid accent pill after a row's label (sidebar channels, private chats). Shows nothing for 0. */
export function Count(props: { n: number; testID?: string }) {
  return (
    <If when={props.n > 0}>
      <View style={{ minWidth: 20, height: 18, paddingHorizontal: 6, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: colors.accentFill }}>
        <Text testID={props.testID} style={{ fontSize: scale.text.caption, fontWeight: "600", color: colors.onAccent, fontVariant: ["tabular-nums"] }}>{String(props.n)}</Text>
      </View>
    </If>
  );
}
