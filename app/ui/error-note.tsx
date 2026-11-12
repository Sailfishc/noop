import { Text, View } from "nsh";
import { colors, radius, size, space } from "./theme";

/** What went wrong, in danger's tint, where it went wrong (a form, a panel). Nothing for an empty text. */
export function ErrorNote(props: { text: string; testID?: string }) {
  return (
    <If when={props.text}>
      <View style={{ paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.md, backgroundColor: colors.dangerTint }}>
        <Text testID={props.testID} style={{ fontSize: size.text.message, lineHeight: size.leading.message, color: colors.danger }}>{props.text}</Text>
      </View>
    </If>
  );
}
