import { View } from "nsh";
import { colors, motion, radius, stroke } from "./theme";

/** A ring turning with its top arc in `tint`: work going on. `size` is an icon size of the density. */
export function Spinner(props: { size: number; tint: string }) {
  return (
    <View
      style={{
        width: props.size,
        height: props.size,
        borderRadius: radius.full,
        borderWidth: Math.max(stroke.edge, props.size / 8),
        borderColor: colors.track,
        borderTopColor: props.tint,
        animationName: "spin",
        animationDuration: motion.progress.duration,
        animationTimingFunction: "linear",
        animationIterationCount: "infinite",
      }}
    />
  );
}
