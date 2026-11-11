import type { ViewStyle } from "nsh";
import { type AnimatedValue, createAnimatedValue, effect, platform, reduceMotion } from "nsh";
import { Switch } from "nsh/base";
import { colors, finish, motion } from "./theme";

/** A pointer and a keyboard: the compact sizes of desktops. */
const pointer = platform.idiom === "desktop" || platform.idiom === "mac";

/**
 * An animated value that springs to `target` each time it changes (a
 * control's state: 1 while on, 0 while off), natively: JS only starts each
 * spring. A change mid-way turns it from where it is, with its velocity;
 * with reduced motion it lands at once. For discrete changes only: what
 * the pointer drives (a dragged thumb, a hover's place) is set in the same
 * frame, never sprung toward the pointer.
 */
export function follow(target: () => number, spring: { stiffness: number; damping: number } = motion.control): AnimatedValue {
  const v = createAnimatedValue(target());
  let shown = target();
  effect(() => {
    const next = target();
    if (next === shown) return;
    shown = next;
    if (reduceMotion()) v.set(next);
    else v.spring(next, spring);
  });
  return v;
}

/**
 * An on / off switch (`nsh/base`'s `Switch`, in the gallery's look): the
 * knob springs across, the track changes color natively.
 */
export function Toggle(props: { value: boolean; onChange: (value: boolean) => void; label?: string; testID?: string }) {
  const look = switchLook(() => props.value);
  return (
    <Switch
      testID={props.testID}
      checked={props.value}
      onChange={({ checked }) => props.onChange(checked)}
      accessibilityLabel={props.label}
      // 8 pt more to press on every side (a hit slop around the small
      // track), without taking more room.
      style={{ margin: -8, padding: 8 }}
      trackStyle={look.trackStyle}
      thumbStyle={look.thumbStyle}
    />
  );
}

/**
 * The gallery's switch, as the styles of `Switch`'s parts: a track sunk
 * into the surface that turns citrus, and a knob that springs across, both
 * natively. The knob keeps its size on and off; on, it is white with an
 * olive edge. `on` is the value the app owns: the knob follows it, from a
 * press or from elsewhere. 28 × 16 on a desktop; on a touch screen 42 × 24
 * (`small`: 34 × 20). Read the styles in JSX, so the appearance is followed.
 */
export function switchLook(on: () => boolean, size: "small" | "regular" = "regular"): { readonly trackStyle: ViewStyle; readonly thumbStyle: ViewStyle } {
  // The track's size and inset, and the knob: it travels what is left inside
  // the border and the padding.
  const [width, height, inset, knob] = pointer ? [28, 16, 1, 12] : size === "small" ? [34, 20, 1, 16] : [42, 24, 1, 20];
  // The knob travels as gpui-kit's does (`spring_move`), the track's color
  // with it; with reduced motion both change in place.
  const t = follow(() => (on() ? 1 : 0), motion.move);
  const x = t.interpolate({ inputRange: [0, 1], outputRange: [0, width - 2 - 2 * inset - knob] });
  return {
    get trackStyle(): ViewStyle {
      return {
        width,
        height,
        borderRadius: height / 2,
        padding: inset,
        backgroundColor: t.interpolate({ inputRange: [0, 1], outputRange: [colors.track, colors.switchOn] }),
        borderWidth: 1,
        borderColor: on() ? colors.switchOn : finish.track.borderColor,
        boxShadow: on() ? "none" : finish.track.boxShadow,
        transitionProperty: "border-color, box-shadow",
        transitionDuration: 150,
      };
    },
    get thumbStyle(): ViewStyle {
      return {
        width: knob,
        height: knob,
        borderRadius: knob / 2,
        borderWidth: 1,
        ...finish.knob,
        ...(on()
          ? {
              backgroundColor: "#ffffff",
              backgroundImage: "none",
              borderColor: "transparent",
              boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
            }
          : {}),
        transform: [{ translateX: x }],
      };
    },
  };
}
