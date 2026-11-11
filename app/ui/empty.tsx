import { Text } from "nsh";
import { L } from "../i18n";
import { colors, scale } from "./theme";

/** An empty list or section: one word ("没有" by default). Why it is empty goes in the section label's ⓘ. */
export function Empty(props: { text?: string; testID?: string }) {
  return <Text testID={props.testID} style={{ fontSize: scale.text.body, color: colors.faint }}>{props.text ?? L("None", "没有")}</Text>;
}
