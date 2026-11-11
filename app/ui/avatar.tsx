import { Text, View } from "nsh";
import { alpha, colors, tints } from "./theme";

export function Avatar(props: { name: string; agent?: boolean; size?: number }) {
  const s = () => props.size ?? 32;
  return (
    <View style={{ width: s(), height: s(), borderRadius: props.agent ? 8 : s() / 2, alignItems: "center", justifyContent: "center", backgroundColor: props.agent ? tints.accent : alpha(colors.text, 0.08) }}>
      <Text style={{ fontSize: s() * 0.42, fontWeight: "600", color: props.agent ? colors.accent : colors.text }}>{(props.name.trim()[0] ?? "?").toUpperCase()}</Text>
    </View>
  );
}
