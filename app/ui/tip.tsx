import { Text, View } from "nsh";
import { Tooltip } from "nsh/base";
import { createPresence, type PopupSide } from "./popup";
import { colors, floatSurface, measure, radius, size, space } from "./theme";

/**
 * A short text as an element's `tooltip`: a `Tooltip` of `nsh/base` on the floating surface, coming in from its side
 * (`placement`, default above), with the keys of a `shortcut` after the text.
 */
export function Tip(props: { label: string; shortcut?: string; placement?: PopupSide; delay?: number }) {
  const presence = createPresence(props.placement ?? "top");
  return (
    <Tooltip placement={props.placement} delay={props.delay} onOpen={presence.show} onClose={presence.hide}>
      <View style={[floatSurface(), { maxWidth: measure.note, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.md }, presence.style]}>
        <Text style={{ flexShrink: 1, fontSize: size.text.caption, lineHeight: size.leading.caption, color: colors.fg }}>{props.label}</Text>
        <If when={props.shortcut}>
          <Text style={{ fontSize: size.text.caption, color: colors.fg2, fontVariant: ["tabular-nums"] }}>{props.shortcut}</Text>
        </If>
      </View>
    </Tooltip>
  );
}
