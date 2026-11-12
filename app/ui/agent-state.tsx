import { reduceMotion, Text, View } from "nsh";
import { colors, motion, radius, size, space, stroke } from "./theme";

/**
 * An agent's state in five words, as people need it: `ready` (就绪), `working` (在做), `waiting` (等你: it waits for a
 * person), `stuck` (卡住: an error it can't get past by itself), `offline` (离线). Only `waiting` and `stuck` are
 * colored; `working` breathes (the one repeating motion); `offline` is a hollow dot.
 */
export type AgentStateKind = "ready" | "working" | "waiting" | "stuck" | "offline";

const ink = (s: AgentStateKind) => (s === "waiting" ? colors.attention : s === "stuck" ? colors.danger : colors.fg2);

/** The dot alone (a list's leading mark). */
export function StateDot(props: { state: AgentStateKind }) {
  const s = () => props.state;
  return (
    <View
      style={{
        width: size.mark.dot,
        height: size.mark.dot,
        borderRadius: radius.full,
        borderWidth: s() === "offline" ? stroke.edge : 0,
        borderColor: colors.fg3,
        backgroundColor: s() === "offline" ? "transparent" : s() === "ready" ? colors.fg3 : ink(s()),
        ...(s() === "working" && !reduceMotion() ? { animationName: "pulse", animationDuration: motion.breathe.duration, animationIterationCount: "infinite" } : {}),
      }}
    />
  );
}

/** The dot and a line of text: the state's word, with what goes before it (`Codex · `) and after it (the reason). */
export function StateMark(props: { state: AgentStateKind; text: string; testID?: string; grow?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flex: props.grow ? 1 : undefined, flexShrink: 1 }}>
      <StateDot state={props.state} />
      <Text testID={props.testID} style={{ flexShrink: 1, fontSize: size.text.caption, color: ink(props.state), numberOfLines: 1 }}>{props.text}</Text>
    </View>
  );
}
