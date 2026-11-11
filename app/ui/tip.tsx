import { Text, View } from "nsh";
import { Tooltip } from "nsh/base";
import { createPresence, type PopupSide } from "./popup";

/**
 * A short text as an element's `tooltip`: a `Tooltip` of `nsh/base` in a
 * small bubble of the theme's `popover` tokens that comes in with `popIn`
 * from its side (`placement`, default above), with the keys of a
 * `shortcut` after the text.
 */
export function Tip(props: { label: string; shortcut?: string; placement?: PopupSide; delay?: number }) {
  const presence = createPresence(props.placement ?? "top");
  return (
    <Tooltip placement={props.placement} delay={props.delay} onOpen={presence.show} onClose={presence.hide}>
      <View class="flex-row items-center gap-2 rounded-md border border-border bg-popover px-2 py-1" style={presence.style}>
        <Text class="text-xs text-popover-foreground">{props.label}</Text>
        <If when={props.shortcut}>
          <Text class="text-xs text-muted-foreground" style={{ fontVariant: ["tabular-nums"] }}>
            {props.shortcut}
          </Text>
        </If>
      </View>
    </Tooltip>
  );
}
