import { Text } from "nsh";
import { Avatar as BaseAvatar } from "nsh/base";
import { colors, identityOf, radius, size } from "./theme";

/**
 * A person (round, in the foreground's quiet fill) or an agent (a rounded square in its identity color: the one
 * colored thing that isn't a state) by the first letter of the name. `size` `sm`, `md` (default) or `lg`; a number
 * is the old way pages still pass, kept until they move to a step.
 */
export function Avatar(props: { name: string; agent?: boolean; size?: "sm" | "md" | "lg" | number }) {
  const s = () => (typeof props.size === "number" ? props.size : size.avatar[props.size ?? "md"]);
  return (
    <BaseAvatar
      name={props.name}
      accessibilityLabel=""
      style={{ width: s(), height: s(), borderRadius: props.agent ? radius.md : radius.full, overflow: "hidden" }}
      fallbackStyle={{ width: s(), height: s(), alignItems: "center", justifyContent: "center", backgroundColor: props.agent ? identityOf(props.name) : colors.selected }}
      fallback={<Text style={{ fontSize: Math.round(s() * 0.42), fontWeight: "600", color: props.agent ? colors.onIdentity : colors.fg }}>{(props.name.trim()[0] ?? "?").toUpperCase()}</Text>}
    />
  );
}
