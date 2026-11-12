import { Text, View } from "nsh";
import { Toggle, ToggleGroup } from "nsh/base";
import { slider } from "./slide";
import { colors, focusRing, hovered, radius, size, slop, space, stroke, touch } from "./theme";

/**
 * A row of choices, one picked (a segmented choice: nsh/base's `ToggleGroup` of `Toggle`s, so the arrow keys move
 * along it and screen readers hear which is pressed). The picked one's fill slides to a newly picked choice. For more
 * options than fit in a row, use `Dropdown`; on a phone, choices wider than the screen stack as a list. Test ids: `<testID>-<value>`.
 */
export function Choice<T extends string>(props: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; testID?: string }) {
  const s = slider(() => props.value);
  // phones: a row of choices wider than the screen becomes a list, one choice per row
  const list = () => touch && s.wrapped();
  return (
    <ToggleGroup style={{ flexDirection: list() ? "column" : "row", flexWrap: list() ? "nowrap" : "wrap", gap: list() ? space.xxs : space.sm }}>
      <If when={s.ready()}>
        <View style={[s.style(), { borderRadius: radius.md, borderWidth: stroke.edge, borderColor: colors.primary, backgroundColor: colors.selected }]} />
      </If>
      <Each of={props.options}>
        {(o) => (
          <Toggle
            testID={props.testID ? `${props.testID}-${o().value}` : undefined}
            pressed={props.value === o().value}
            onChange={() => props.onChange(o().value)}
            onLayout={s.layout(o().value)}
            hitSlop={slop(size.control.sm)}
            hoverStyle={hovered()}
            focusStyle={focusRing("edge")}
            style={{
              minHeight: list() ? size.row.sm : size.control.sm, paddingHorizontal: space.lg, justifyContent: "center", borderRadius: radius.md, borderWidth: stroke.edge,
              // the slider draws the picked one's fill; until it has measured, the picked one fills itself
              borderColor: props.value !== o().value ? colors.edge : s.ready() ? "transparent" : colors.primary,
              backgroundColor: props.value === o().value && !s.ready() ? colors.selected : "transparent",
            }}
          >
            <Text style={{ fontSize: size.text.body, color: colors.fg }}>{o().label}</Text>
          </Toggle>
        )}
      </Each>
    </ToggleGroup>
  );
}
