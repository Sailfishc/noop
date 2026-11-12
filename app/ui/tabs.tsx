import { Text, View } from "nsh";
import { Button } from "nsh/base";
import { slider } from "./slide";
import { colors, focusRing, hovered, size, space, stroke } from "./theme";

/**
 * A row of tabs over a view (Conversation | Tasks): the picked one underlined, the underline sliding to a newly picked
 * tab; an optional count after each label. Test ids: `<testID>-<value>`.
 */
export function Tabs<T extends string>(props: { tabs: { value: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void; testID?: string }) {
  const s = slider(() => props.value);
  return (
    <View role="tablist" style={{ flexDirection: "row", alignItems: "flex-end", gap: space.xs }}>
      <If when={s.ready()}>
        <View style={s.style()}>
          <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: stroke.underline, backgroundColor: colors.fg }} />
        </View>
      </If>
      <Each of={props.tabs}>
        {(t) => (
          <Button
            role="tab"
            testID={props.testID ? `${props.testID}-${t().value}` : undefined}
            selected={props.value === t().value}
            onPress={() => props.onChange(t().value)}
            onLayout={s.layout(t().value)}
            hoverStyle={hovered()}
            focusStyle={focusRing()}
            style={{ minHeight: size.mark.tab, minWidth: size.hit, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, paddingHorizontal: space.md, borderBottomWidth: stroke.underline, borderBottomColor: props.value === t().value && !s.ready() ? colors.fg : "transparent" }}
          >
            <Text style={{ fontSize: size.text.body, fontWeight: props.value === t().value ? "600" : "400", color: props.value === t().value ? colors.fg : colors.fg2 }}>{t().label}</Text>
            <If when={t().count}>
              <Text style={{ fontSize: size.text.caption, color: colors.fg3, fontVariant: ["tabular-nums"] }}>{String(t().count)}</Text>
            </If>
          </Button>
        )}
      </Each>
    </View>
  );
}
