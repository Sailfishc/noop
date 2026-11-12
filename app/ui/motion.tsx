// Moments 4 and 5 of the motion budget, for the pages that need them: a handled item collapsing as the next moves up
// (`collapseNext`), and the accept check mark drawing in (`DoneMark`). Both stand still under reduced motion.
import { createAnimatedValue, LayoutAnimation, reduceMotion, View } from "nsh";
import { CheckMark } from "./icons";
import { colors, motion, size } from "./theme";

/** A spring's damping as a ratio of critical damping (what LayoutAnimation takes), from its stiffness and damping. */
const ratio = (s: { stiffness: number; damping: number }) => Math.min(1, s.damping / (2 * Math.sqrt(s.stiffness)));

/**
 * Call just before removing or inserting an item of a list (the item handled in the triage view): the next layout
 * change animates, the removed item collapsing and the rest moving up on the `collapse` spring.
 */
export function collapseNext() {
  if (reduceMotion()) return;
  const { duration, spring } = motion.collapse;
  const springy = { type: "spring" as const, springDamping: ratio(spring) };
  LayoutAnimation.configureNext({ duration, create: { ...springy, property: "opacity" }, update: springy, delete: { ...springy, property: "opacity" } });
}

/**
 * The accept check: it draws in once, as it appears, springing up from small on the `check` spring (at its size at
 * once under reduced motion). `tone` `ok` (default) or the foreground.
 */
export function DoneMark(props: { tone?: "ok" | "default"; testID?: string }) {
  const scale = createAnimatedValue(reduceMotion() ? 1 : 0);
  if (!reduceMotion()) void scale.spring(1, motion.check.spring);
  return (
    <View testID={props.testID} style={{ transform: [{ scale }], opacity: scale }}>
      <CheckMark size={size.icon.md} tint={props.tone === "default" ? colors.fg : colors.ok} />
    </View>
  );
}
