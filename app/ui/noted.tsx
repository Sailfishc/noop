import { signal, Text, View, type JSX } from "nsh";
import { Button, Popover } from "nsh/base";
import { L } from "../i18n";
import { Icon } from "./icons";
import { Tip } from "./tip";
import { alpha, colors, focusRing, hovered, scale } from "./theme";

/**
 * A label with its guidance behind a small ⓘ after it, so a page reads as its labels and fields, not paragraphs
 * (AGENTS.md: explanations go behind an ⓘ). With a pointer, resting on the ⓘ shows the note as a tooltip; a press
 * (or a tap on a phone, which has no hover) opens it in a small popover until the next press or a press elsewhere.
 * `right` goes at the end of the label's row. Test ids: `<testID>-info` (the ⓘ), `<testID>-note` (the open note).
 */
export function Noted(props: { label: JSX.Element; note?: string; testID?: string; right?: JSX.Element }) {
  const open = signal(false);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      {props.label}
      <If when={props.note}>
        <Popover
          open={open()}
          onOpenChange={({ open: o }) => open.set(o)}
          placement="bottom"
          align="start"
          offset={4}
          margin={8}
          popupStyle={{ maxWidth: 320, paddingHorizontal: 12, paddingVertical: 8, borderRadius: scale.radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, boxShadow: "0 6px 20px rgba(0,0,0,0.12)" }}
          trigger={
            <Button
              testID={props.testID ? `${props.testID}-info` : undefined}
              accessibilityLabel={open() ? L("Hide the explanation", "收起说明") : L("What is this?", "这是什么？")}
              tooltip={open() ? undefined : <Tip label={props.note!} placement="top" />}
              hitSlop={4}
              hoverStyle={hovered()}
              focusStyle={focusRing(1)}
              style={{ width: 20, height: 20, marginVertical: -2, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: open() ? alpha(colors.text, 0.08) : "transparent" }}
            >
              <Icon name="info" size={14} tint={open() ? colors.muted : colors.faint} />
            </Button>
          }
        >
          <Text testID={props.testID ? `${props.testID}-note` : undefined} style={{ fontSize: scale.text.caption, lineHeight: 18, color: colors.muted }}>{props.note}</Text>
        </Popover>
      </If>
      <View style={{ flex: 1 }} />
      {props.right}
    </View>
  );
}

/** A label above a group of controls, with its note behind an ⓘ. */
export function Label(props: { text: string; note?: string; testID?: string; right?: JSX.Element }) {
  return <Noted note={props.note} testID={props.testID} right={props.right} label={<Text style={{ fontSize: scale.text.body, fontWeight: "600", color: colors.muted }}>{props.text}</Text>} />;
}
