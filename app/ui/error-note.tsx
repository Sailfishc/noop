import { Text, View } from "nsh";
import { colors, radius, tints } from "./theme";

export function ErrorNote(props: { text: string; testID?: string }) {
  return (
    <If when={props.text}>
      <View style={{ paddingHorizontal: 12, paddingVertical: 9, borderRadius: radius.control, backgroundColor: tints.danger }}>
        <Text testID={props.testID} style={{ fontSize: 14, lineHeight: 20, color: colors.danger }}>{props.text}</Text>
      </View>
    </If>
  );
}
