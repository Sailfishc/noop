import { safeArea, Text, View } from "nsh";
import { Button } from "nsh/base";
import { type IconName, Icon } from "./icons";
import { colors, pressMotion, radius, size, space, stroke } from "./theme";

/**
 * The tab bar along a phone's bottom edge (待你决定 / 消息 / 任务 / 我): an icon over a word, the picked one in a pill, a
 * count on the icon. A count in `attention` is what waits on you (amber, like everywhere), any other count is plain.
 * It keeps clear of the home indicator. Test ids: `<testID>-<value>`, its count `<testID>-<value>-badge`.
 */
export function TabBar<T extends string>(props: {
  tabs: { value: T; icon: IconName; label: string; badge?: number; tone?: "attention" }[];
  value: T | null;
  onChange: (v: T) => void;
  testID?: string;
}) {
  return (
    <View
      testID={props.testID}
      role="tablist"
      style={{ flexDirection: "row", paddingTop: space.sm, paddingBottom: Math.max(space.sm, safeArea().bottom), borderTopWidth: stroke.hairline, borderTopColor: colors.hairline, backgroundColor: colors.page }}
    >
      <Each of={props.tabs} key={(x) => x.value}>
        {(x) => {
          const on = () => props.value === x().value;
          const press = pressMotion();
          return (
            <Button
              role="tab"
              testID={props.testID ? `${props.testID}-${x().value}` : undefined}
              accessibilityLabel={x().label}
              selected={on()}
              onPress={() => props.onChange(x().value)}
              {...press.handlers}
              style={{ flex: 1, minHeight: size.row.sm, alignItems: "center", justifyContent: "center", gap: space.xxs, ...press.style }}
            >
              <View style={{ paddingHorizontal: space.xl, paddingVertical: space.xs, borderRadius: radius.full, backgroundColor: on() ? colors.selected : "transparent" }}>
                <Icon name={x().icon} size={size.icon.md} tint={on() ? colors.fg : colors.fg2} />
                <If when={x().badge}>
                  <View style={{ position: "absolute", top: -space.xs, right: 0, minWidth: size.mark.count, minHeight: size.mark.count, paddingHorizontal: space.xs, borderRadius: radius.full, borderWidth: stroke.underline, borderColor: colors.page, alignItems: "center", justifyContent: "center", backgroundColor: x().tone === "attention" ? colors.attention : colors.primary }}>
                    <Text testID={props.testID ? `${props.testID}-${x().value}-badge` : undefined} style={{ fontSize: size.text.caption, fontWeight: "600", color: x().tone === "attention" ? colors.onAttention : colors.onPrimary, fontVariant: ["tabular-nums"] }}>{String(x().badge)}</Text>
                  </View>
                </If>
              </View>
              <Text style={{ fontSize: size.text.caption, fontWeight: on() ? "600" : "400", color: on() ? colors.fg : colors.fg2, numberOfLines: 1 }}>{x().label}</Text>
            </Button>
          );
        }}
      </Each>
    </View>
  );
}
