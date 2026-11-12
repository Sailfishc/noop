import type { ViewStyle } from "nsh";
import { Switch } from "nsh/base";
import { colors, elevation, follow, motion, radius, size, slop, stroke } from "./theme";

/**
 * An on / off switch (nsh/base's `Switch`): the knob slides across on the `select` spring, the track turns `ok`.
 * Desktop and touch sizes come from the density; on touch it takes presses over the full hit target.
 */
export function Toggle(props: { value: boolean; onChange: (value: boolean) => void; label?: string; testID?: string }) {
  const look = switchLook(() => props.value);
  return (
    <Switch
      testID={props.testID}
      checked={props.value}
      onChange={({ checked }) => props.onChange(checked)}
      accessibilityLabel={props.label}
      hitSlop={slop(size.switch.height)}
      trackStyle={look.trackStyle}
      thumbStyle={look.thumbStyle}
    />
  );
}

/**
 * The switch's parts as styles: a track that turns `ok` when on and a knob that springs across, both natively. `on`
 * is the value the app owns: the knob follows it, from a press or from elsewhere. Read the styles in JSX, so the
 * appearance is followed.
 */
export function switchLook(on: () => boolean): { readonly trackStyle: ViewStyle; readonly thumbStyle: ViewStyle } {
  const width = size.switch.width, height = size.switch.height, knob = size.switch.knob;
  const inset = (height - knob) / 2 - stroke.edge;
  const t = follow(() => (on() ? 1 : 0), motion.select.spring);
  const x = t.interpolate({ inputRange: [0, 1], outputRange: [0, width - knob - 2 * (inset + stroke.edge)] });
  return {
    get trackStyle(): ViewStyle {
      return {
        width,
        height,
        borderRadius: radius.full,
        padding: inset,
        backgroundColor: t.interpolate({ inputRange: [0, 1], outputRange: [colors.track, colors.ok] }),
        borderWidth: stroke.edge,
        borderColor: on() ? colors.ok : "transparent",
        transitionProperty: "border-color",
        transitionDuration: motion.fade.duration,
      };
    },
    get thumbStyle(): ViewStyle {
      return {
        width: knob,
        height: knob,
        borderRadius: radius.full,
        backgroundColor: colors.knob,
        boxShadow: elevation.knob,
        transform: [{ translateX: x }],
      };
    },
  };
}
