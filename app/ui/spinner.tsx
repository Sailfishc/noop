import { View } from "nsh";
import { alpha } from "./theme";

/** A ring turning with its top arc in `tint`: work going on. */
export function Spinner(props: { size: number; tint: string }) {
  return (
    <View
      style={{
        width: props.size,
        height: props.size,
        borderRadius: props.size / 2,
        borderWidth: Math.max(1.5, props.size / 8),
        borderColor: alpha(props.tint, 0.25),
        borderTopColor: props.tint,
        animationName: "spin",
        animationDuration: 800,
        animationTimingFunction: "linear",
        animationIterationCount: "infinite",
      }}
    />
  );
}
