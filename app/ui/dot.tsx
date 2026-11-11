import { View } from "nsh";
import { colors } from "./theme";

/**
 * A status dot: `on` green or grey (a machine online), or a `tone` (an agent's state: `up` ready, `warn` working,
 * `danger` an error, anything else grey).
 */
export function Dot(props: { on?: boolean; tone?: string }) {
  const c = () =>
    props.tone !== undefined
      ? ({ up: colors.up, warn: colors.warn, danger: colors.danger, accent: colors.accent } as Record<string, string>)[props.tone] ?? colors.faint
      : props.on ? colors.up : colors.faint;
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c() }} />;
}
