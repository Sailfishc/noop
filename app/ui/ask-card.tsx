import { View, type JSX } from "nsh";
import { L } from "../i18n";
import { Btn } from "./button";
import { Noted } from "./noted";
import { Txt } from "./text";
import { colors, radius, space, stroke } from "./theme";

/**
 * Where an agent asks a person something: to align on what done means, to decide, to accept. The only amber surface
 * in the app (a band down its edge, the attention tint) while it waits on the person looking at it; `quiet` while it
 * waits on someone else (the hairline card). `kind` is the ask in a word or two (等你决定), its `note` behind an ⓘ.
 * The answer comes first (`actions`: the options as buttons, the recommended one primary), then 回复… (`onReply`) for
 * anything the buttons don't say.
 */
export function AskCard(props: {
  kind: string;
  note?: string;
  quiet?: boolean;
  testID?: string;
  children?: JSX.Element;
  actions?: JSX.Element;
  onReply?: () => void;
}) {
  return (
    <View
      testID={props.testID}
      style={{
        gap: space.md,
        padding: space.lg,
        borderRadius: radius.lg,
        borderLeftWidth: props.quiet ? stroke.hairline : stroke.band,
        borderTopWidth: stroke.hairline,
        borderRightWidth: stroke.hairline,
        borderBottomWidth: stroke.hairline,
        borderColor: colors.hairline,
        borderLeftColor: props.quiet ? colors.hairline : colors.attention,
        backgroundColor: props.quiet ? colors.raised : colors.attentionTint,
      }}
    >
      <Noted
        testID={props.testID ? `${props.testID}-kind` : undefined}
        note={props.note}
        label={<Txt variant="caption" weight="semibold" tone={props.quiet ? "muted" : "attention"}>{props.kind}</Txt>}
      />
      {props.children}
      <If when={props.actions || props.onReply}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {props.actions}
          <If when={props.onReply}>
            <Btn small kind="ghost" testID={props.testID ? `${props.testID}-reply` : undefined} label={L("Reply…", "回复…")} onPress={() => props.onReply!()} />
          </If>
        </View>
      </If>
    </View>
  );
}
