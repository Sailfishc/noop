import { Text, View } from "nsh";
import { Button } from "nsh/base";
import { colors, focusRing, hovered, scale } from "./theme";

/**
 * A row of tabs over a view (Conversation | Tasks): the picked one underlined, an optional count after each label.
 * Test ids: `<testID>-<value>`.
 */
export function Tabs<T extends string>(props: { tabs: { value: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void; testID?: string }) {
  return (
    <View role="tablist" style={{ flexDirection: "row", alignItems: "flex-end", gap: 4 }}>
      <Each of={props.tabs}>
        {(t) => (
          <Button
            role="tab"
            testID={props.testID ? `${props.testID}-${t().value}` : undefined}
            selected={props.value === t().value}
            onPress={() => props.onChange(t().value)}
            hoverStyle={hovered()}
            focusStyle={focusRing(0)}
            style={{ height: 34, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, borderBottomWidth: 2, borderBottomColor: props.value === t().value ? colors.accent : "transparent" }}
          >
            <Text style={{ fontSize: scale.text.body, fontWeight: props.value === t().value ? "600" : "400", color: props.value === t().value ? colors.text : colors.muted }}>{t().label}</Text>
            <If when={t().count}>
              <Text style={{ fontSize: scale.text.caption, color: colors.faint }}>{String(t().count)}</Text>
            </If>
          </Button>
        )}
      </Each>
    </View>
  );
}
