import { View } from "nsh";
import { colors } from "./theme";

export function Dot(props: { on: boolean }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: props.on ? colors.up : colors.faint }} />;
}


export function StateDot(props: { tone: string }) {
  const c = () => ({ up: colors.up, warn: colors.warn, danger: colors.danger, accent: colors.accent })[props.tone] ?? colors.faint;
  return <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: c() }} />;
}
