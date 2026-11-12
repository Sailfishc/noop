// Moment 2 of the motion budget: the selection pill (or underline) slides to the newly picked tab, choice or row
// instead of jumping there. Shared by Tabs and Choice (and the sidebar's selected row).
import { signal, type ViewStyle } from "nsh";
import { follow, motion } from "./theme";

type Box = { x: number; y: number; w: number; h: number };

/**
 * Tracks where each option of a row of options sits (`layout(value)` as each option's `onLayout`) and gives the style
 * of an indicator that follows the picked one: it slides there on the `select` spring (at once under reduced motion,
 * and the first time, before anything was measured). Its size takes the picked option's at once.
 */
export function slider<T extends string>(picked: () => T) {
  const boxes = signal<Partial<Record<T, Box>>>({});
  const box = () => boxes()[picked()];
  const x = follow(() => box()?.x ?? 0, motion.select.spring);
  const y = follow(() => box()?.y ?? 0, motion.select.spring);
  return {
    layout: (value: T) => (e: { bounds: { origin: { x: number; y: number }; size: { width: number; height: number } } }) =>
      boxes.update((b) => ({ ...b, [value]: { x: e.bounds.origin.x, y: e.bounds.origin.y, w: e.bounds.size.width, h: e.bounds.size.height } })),
    /** Whether the options broke onto more than one line (a row of choices wider than a phone). */
    wrapped: () => { const ys = Object.values(boxes()).map((b) => (b as Box).y); return ys.length > 1 && Math.max(...ys) > Math.min(...ys); },
    /** Whether the picked option was measured: show the indicator only then. */
    ready: () => !!box(),
    style: (): ViewStyle => ({
      position: "absolute",
      left: 0,
      top: 0,
      width: box()?.w ?? 0,
      height: box()?.h ?? 0,
      transform: [{ translateX: x }, { translateY: y }],
      pointerEvents: "none",
    }),
  };
}
