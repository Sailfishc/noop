import { Text, View } from "nsh";
import { type IconName, Icon } from "./icons";
import { Spinner } from "./spinner";
import { colors, hovered, radius, tints } from "./theme";

export function Btn(props: { label: string; onPress: () => void; kind?: "primary" | "plain" | "ghost" | "danger"; testID?: string; busy?: boolean; disabled?: boolean; icon?: IconName; grow?: boolean; small?: boolean }) {
  const kind = () => props.kind ?? "plain";
  const fg = () => (kind() === "primary" ? colors.onAccent : kind() === "danger" ? colors.danger : kind() === "ghost" ? colors.muted : colors.text);
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: !!props.disabled }}
      onPress={() => !props.disabled && !props.busy && props.onPress()}
      hoverStyle={props.disabled ? undefined : kind() === "primary" ? { opacity: 0.92 } : hovered()}
      style={{
        minHeight: props.small ? 30 : 40,
        flexGrow: props.grow ? 1 : 0,
        flexShrink: 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingHorizontal: props.small ? 10 : 14,
        borderRadius: radius.control,
        borderWidth: kind() === "plain" ? 0.5 : 0,
        borderColor: colors.fieldBorder,
        backgroundColor: kind() === "primary" ? colors.accentFill : kind() === "danger" ? tints.danger : kind() === "plain" ? colors.surface : "transparent",
        opacity: props.disabled ? 0.45 : 1,
      }}
    >
      <If when={props.busy}>
        <Spinner size={14} tint={fg()} />
      </If>
      <If when={!props.busy && props.icon}>
        <Icon name={props.icon!} size={16} tint={fg()} />
      </If>
      <Text style={{ fontSize: props.small ? 13.5 : 15, fontWeight: kind() === "primary" ? "600" : "500", color: fg() }}>{props.label}</Text>
    </View>
  );
}
