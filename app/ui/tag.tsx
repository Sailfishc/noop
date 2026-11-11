import { Text, View } from "nsh";
import { alpha, colors, scale, tints } from "./theme";

/** A small pill: a runtime, a role, a state. Keep tones scarce: ordinary metadata stays `muted`. */
export function Tag(props: { label: string; tone?: "accent" | "muted" | "warn" | "up" | "danger"; testID?: string }) {
  const fg = () => ({ accent: colors.accent, warn: colors.warn, up: colors.up, danger: colors.danger, muted: colors.muted })[props.tone ?? "muted"];
  const bg = () => ({ accent: tints.accent, warn: tints.warn, up: alpha(colors.up, 0.12), danger: tints.danger, muted: alpha(colors.text, 0.06) })[props.tone ?? "muted"];
  return (
    <View style={{ height: 20, paddingHorizontal: 6, borderRadius: scale.radius.sm, justifyContent: "center", backgroundColor: bg() }}>
      <Text testID={props.testID} style={{ fontSize: scale.text.caption, fontWeight: "600", color: fg(), numberOfLines: 1 }}>{props.label}</Text>
    </View>
  );
}
