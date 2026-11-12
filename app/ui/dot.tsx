import { reduceMotion, View } from "nsh";
import { colors, motion, radius, size, tone } from "./theme";

/**
 * A status dot: `on` ok or quiet (a machine online), or a `tone` (an agent's state). `breathe` (an agent at work)
 * pulses slowly: the one motion that repeats, and it stands still under reduced motion.
 */
export function Dot(props: { on?: boolean; tone?: string; breathe?: boolean }) {
  const c = () => (props.tone !== undefined ? tone(props.tone === "muted" ? "faint" : props.tone).fg : props.on ? colors.ok : colors.fg3);
  return (
    <View
      style={{
        width: size.mark.dot,
        height: size.mark.dot,
        borderRadius: radius.full,
        backgroundColor: c(),
        ...(props.breathe && !reduceMotion() ? { animationName: "pulse", animationDuration: motion.breathe.duration, animationIterationCount: "infinite" } : {}),
      }}
    />
  );
}
