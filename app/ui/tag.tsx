import { Text, View } from "nsh";
import { radius, size, space, tone, type OldTone, type Tone } from "./theme";

/** A small pill: a runtime, a role, a state. Keep tones scarce: ordinary metadata stays `muted`; amber (`attention`) only for what waits on you. */
export function Tag(props: { label: string; tone?: Tone | OldTone; testID?: string }) {
  const t = () => tone(props.tone ?? "muted");
  return (
    <View style={{ minHeight: size.mark.tag, paddingHorizontal: space.sm, borderRadius: radius.sm, justifyContent: "center", backgroundColor: t().tint }}>
      <Text testID={props.testID} style={{ fontSize: size.text.caption, fontWeight: "600", color: t().fg, numberOfLines: 1 }}>{props.label}</Text>
    </View>
  );
}
