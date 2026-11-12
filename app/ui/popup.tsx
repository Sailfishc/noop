// Moment 3 of the motion budget: how a floating surface comes in (up `motion.float.y` and fading in over
// `motion.float.duration`). nsh/base's Menu, Select and Dialog bring their own surfaces in; this is for the ones app/ui
// draws itself (a tooltip's bubble). On phones nsh/base turns menus into sheets that rise from the bottom.
import type { MotionSpec, ViewStyle } from "nsh";
import { createMotion, Easing } from "nsh";
import { motion } from "./theme";

/** The side of its trigger a popup is on. */
export type PopupSide = "top" | "bottom" | "left" | "right";

/** Where a popup grows from: the edge that faces its trigger. */
const origins: Record<PopupSide, string> = { bottom: "top", top: "bottom", left: "right", right: "left" };

/** How a floating surface comes in: it fades in and slides the last `motion.float.y` points out of its trigger's edge, decelerating. */
export function popIn(side: PopupSide = "bottom"): MotionSpec {
  const d = motion.float.y;
  const away = side === "top" || side === "left" ? d : -d;
  const axis = side === "top" || side === "bottom" ? "translateY" : "translateX";
  const [a, b, c, e] = motion.float.easing;
  return { duration: motion.float.duration, easing: Easing.bezier(a, b, c, e), keyframes: { opacity: [0, 1], [axis]: [away, 0] } };
}

/**
 * A surface that stays made between showings (a `Tooltip`'s bubble): hidden while it is away, `show` plays `popIn` as
 * it comes back. Call `show` from the popup's `onOpen` and `hide` from its `onClose`. Reduced motion shows it at once.
 */
export function createPresence(side: PopupSide = "top") {
  const m = createMotion({ initial: { opacity: 0 } });
  return {
    style: { transformOrigin: origins[side], ...m.style } satisfies ViewStyle,
    show: () => void m.play(popIn(side)),
    hide: () => {
      m.stop();
      m.opacity.set(0);
    },
  };
}
