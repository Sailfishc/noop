import { Text } from "nsh";
import { Avatar as BaseAvatar } from "nsh/base";
import { alpha, colors, scale, tints } from "./theme";

/** A person (round) or an agent (a rounded square, accent) by the first letter of their name. `size` default 32. */
export function Avatar(props: { name: string; agent?: boolean; size?: number }) {
  const s = () => props.size ?? 32;
  return (
    <BaseAvatar
      name={props.name}
      accessibilityLabel=""
      style={{ width: s(), height: s(), borderRadius: props.agent ? scale.radius.md : s() / 2, overflow: "hidden" }}
      fallbackStyle={{ width: s(), height: s(), alignItems: "center", justifyContent: "center", backgroundColor: props.agent ? tints.accent : alpha(colors.text, 0.08) }}
      fallback={<Text style={{ fontSize: s() * 0.42, fontWeight: "600", color: props.agent ? colors.accent : colors.text }}>{(props.name.trim()[0] ?? "?").toUpperCase()}</Text>}
    />
  );
}
