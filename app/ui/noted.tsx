import { signal, Text, View, type JSX } from "nsh";
import { L } from "../i18n";
import { Icon } from "./icons";
import { alpha, colors, hovered } from "./theme";

/**
 * A label with its guidance behind a small ⓘ after it: the note shows under the label while the ⓘ is pressed on,
 * so a settings page reads as its labels and fields, not paragraphs (the same on a phone, which has no hover).
 * `right` goes at the end of the label's row.
 */
export function Noted(props: { label: JSX.Element; note?: string; testID?: string; right?: JSX.Element }) {
  const open = signal(false);
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        {props.label}
        <If when={props.note}>
          <View
            role="button"
            testID={props.testID ? `${props.testID}-info` : undefined}
            accessibilityLabel={open() ? L("Hide the explanation", "收起说明") : L("What is this?", "这是什么？")}
            onPress={() => open.update((v) => !v)}
            hoverStyle={hovered()}
            style={{ width: 20, height: 20, marginVertical: -2, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: open() ? alpha(colors.text, 0.08) : "transparent" }}
          >
            <Icon name="info" size={14} tint={open() ? colors.muted : colors.faint} />
          </View>
        </If>
        <View style={{ flex: 1 }} />
        {props.right}
      </View>
      <If when={open() && props.note}>
        <Text testID={props.testID ? `${props.testID}-note` : undefined} style={{ fontSize: 12.5, lineHeight: 18, color: colors.muted }}>{props.note}</Text>
      </If>
    </View>
  );
}

export function Label(props: { text: string; note?: string; testID?: string; right?: JSX.Element }) {
  return <Noted note={props.note} testID={props.testID} right={props.right} label={<Text style={{ fontSize: 13, fontWeight: "600", color: colors.muted }}>{props.text}</Text>} />;
}
