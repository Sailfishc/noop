import { signal, Text, View, type JSX } from "nsh";
import { Button, Popover } from "nsh/base";
import { L } from "../i18n";
import { Icon } from "./icons";
import { Tip } from "./tip";
import { colors, floatSurface, focusRing, hovered, measure, radius, size, slop, space } from "./theme";

/**
 * A label with its guidance behind a small ⓘ after it, so a page reads as its labels and fields, not paragraphs
 * (AGENTS.md: explanations go behind an ⓘ). With a pointer, resting on the ⓘ shows the note as a tooltip; a press
 * (or a tap on a phone, which has no hover) opens it in a small popover until the next press or a press elsewhere.
 * `right` goes at the end of the label's row; `wrap` lets a long label (a sentence on a card) wrap rather than overflow. Test ids: `<testID>-info` (the ⓘ), `<testID>-note` (the open note).
 */
export function Noted(props: { label: JSX.Element; note?: string; testID?: string; right?: JSX.Element; wrap?: boolean }) {
  const open = signal(false);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
      {/* wrap: a long label wraps in a narrow column (the thread panel) instead of running past it */}
      <If when={props.wrap} else={props.label}><View style={{ flexShrink: 1 }}>{props.label}</View></If>
      <If when={props.note}>
        <Popover
          open={open()}
          onOpenChange={({ open: o }) => open.set(o)}
          placement="bottom"
          align="start"
          offset={space.xs}
          margin={space.md}
          popupStyle={[floatSurface(), { maxWidth: measure.note, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.lg }]}
          trigger={
            <Button
              testID={props.testID ? `${props.testID}-info` : undefined}
              accessibilityLabel={open() ? L("Hide the explanation", "收起说明") : L("What is this?", "这是什么？")}
              tooltip={open() ? undefined : <Tip label={props.note!} placement="top" />}
              hitSlop={slop(size.mark.info)}
              hoverStyle={hovered()}
              focusStyle={focusRing("edge")}
              style={{ width: size.mark.info, height: size.mark.info, marginVertical: -space.xxs, borderRadius: radius.full, alignItems: "center", justifyContent: "center", backgroundColor: open() ? colors.selected : "transparent" }}
            >
              <Icon name="info" size={size.icon.sm} tint={open() ? colors.fg2 : colors.fg3} />
            </Button>
          }
        >
          <Text testID={props.testID ? `${props.testID}-note` : undefined} style={{ fontSize: size.text.caption, lineHeight: size.leading.caption, color: colors.fg2 }}>{props.note}</Text>
        </Popover>
      </If>
      <View style={{ flex: 1 }} />
      {props.right}
    </View>
  );
}

/** A label above a group of controls, with its note behind an ⓘ. */
export function Label(props: { text: string; note?: string; testID?: string; right?: JSX.Element }) {
  return <Noted note={props.note} testID={props.testID} right={props.right} label={<Text style={{ fontSize: size.text.body, fontWeight: "600", color: colors.fg2 }}>{props.text}</Text>} />;
}
