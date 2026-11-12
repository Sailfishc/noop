import { Text, View, type JSX } from "nsh";
import { Button } from "nsh/base";
import { Noted } from "./noted";
import { colors, focusRing, hovered, radius, size, slop, space, stroke } from "./theme";

/**
 * A titled section on the raised surface (a settings group), its note behind the title's ⓘ; `right` at the title's
 * end; `grow` takes the rest of a row. Its edge is a hairline: inside a page, levels of surface separate things, not borders.
 */
export function Panel(props: { title: string; note?: string; testID?: string; children: JSX.Element; right?: JSX.Element; grow?: boolean }) {
  return (
    <View style={[{ gap: space.lg, padding: space.xl, borderRadius: radius.lg, borderWidth: stroke.hairline, borderColor: colors.hairline, backgroundColor: colors.raised, flex: props.grow ? 1 : undefined }]}>
      <Noted
        note={props.note}
        testID={props.testID}
        label={<Text style={{ fontSize: size.text.title, fontWeight: "600", color: colors.fg }}>{props.title}</Text>}
        right={props.right}
      />
      {props.children}
    </View>
  );
}

/**
 * A group of things that belong together without a title (an editor and its buttons, a picked item), on the raised
 * surface with a hairline edge. `tight` pads less; `flat` leaves the surface out (only the hairline).
 */
export function Card(props: { children: JSX.Element; tight?: boolean; flat?: boolean; testID?: string }) {
  return (
    <View testID={props.testID} style={{ gap: props.tight ? space.sm : space.md, padding: props.tight ? space.md : space.lg, borderRadius: radius.lg, borderWidth: stroke.hairline, borderColor: colors.hairline, backgroundColor: props.flat ? "transparent" : colors.raised }}>
      {props.children}
    </View>
  );
}

/** A pressable header row inside a card (such as a task card's title row that opens the workspace panel). */
export function CardHead(props: { label: string; onPress: () => void; testID?: string; children: JSX.Element }) {
  return (
    <Button
      testID={props.testID}
      accessibilityLabel={props.label}
      onPress={props.onPress}
      hitSlop={slop(size.control.sm)}
      hoverStyle={hovered()}
      focusStyle={focusRing("inset")}
      style={{ minHeight: size.control.sm, flexDirection: "row", alignItems: "center", gap: space.md, borderRadius: radius.sm }}
    >
      {props.children}
    </Button>
  );
}
