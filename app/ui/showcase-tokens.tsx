// The showcase's Tokens tab: every semantic token, listed from the generated file (tokens.gen.ts), so what is listed
// here is exactly what exists. Colors with their light / dark values, the sizes of this density beside the other,
// spacing, radii, strokes, motion, and the lowest contrast per appearance.
import { View } from "nsh";
import { Section, Row } from "./showcase";
import { Txt } from "./text";
import { colors, measure, radius, size, space, stroke, touch } from "./theme";
import { colorTable, contrastTable, densities, motion } from "./tokens.gen";

const entries = (o: object) => Object.entries(o) as [string, unknown][];
const show = (v: unknown) => (typeof v === "object" ? JSON.stringify(v).replace(/"/g, "").replace(/,/g, ", ") : String(v));

function Swatch(props: { role: keyof typeof colors; name: string; light: string; dark: string }) {
  return (
    <View style={{ width: touch ? "100%" : measure.note, flexDirection: "row", alignItems: "center", gap: space.md }}>
      <View style={{ width: size.control.sm, height: size.control.sm, borderRadius: radius.sm, borderWidth: stroke.hairline, borderColor: colors.hairline, backgroundColor: colors[props.role] }} />
      <View style={{ flex: 1 }}>
        <Txt weight="semibold" lines={1}>{props.role}</Txt>
        <Txt variant="caption" tone="faint" mono lines={1}>{`${props.light}  ·  ${props.dark}`}</Txt>
      </View>
    </View>
  );
}

function Table(props: { rows: [string, unknown][] }) {
  return (
    <View style={{ gap: space.xxs }}>
      <Each of={props.rows}>
        {(r) => (
          <Row>
            <View style={{ width: measure.code * 2 }}><Txt tone="muted" mono>{r()[0]}</Txt></View>
            <Txt mono grow>{show(r()[1])}</Txt>
          </Row>
        )}
      </Each>
    </View>
  );
}

export function TokensPage() {
  const other = touch ? densities.pointer : densities.touch;
  const lowest = (mode: string) => [...contrastTable.filter((c) => c.mode === mode)].sort((a, b) => a.ratio / a.min - b.ratio / b.min)[0];
  return (
    <View testID="showcase-tokens" style={{ gap: space.xxl }}>
      <Section title={`Colors: ${colorTable.length} semantic roles (light · dark), generated from 3 inputs in app/design/tokens.ts`}>
        <Row>
          <Each of={colorTable}>{(c) => <Swatch role={c().role} name={c().name} light={c().light} dark={c().dark} />}</Each>
        </Row>
      </Section>
      <Section title="Contrast: the closest pair per appearance (the generator fails below the minimum)">
        <Each of={["light", "dark", "black"]}>
          {(m) => <Txt mono>{`${m()}: ${lowest(m()).fg} on ${lowest(m()).on} ${lowest(m()).ratio}:1 (min ${lowest(m()).min})`}</Txt>}
        </Each>
      </Section>
      <Section title={`Sizes: this device draws ${touch ? "touch" : "pointer"}; the other density in brackets`}>
        <Table rows={entries(size).map(([k, v]) => [k, `${show(v)}   [${show((other as Record<string, unknown>)[k])}]`])} />
      </Section>
      <Section title="Space · radius · stroke · measure">
        <Table rows={[["space", space], ["radius", radius], ["stroke", stroke], ["measure", measure]]} />
      </Section>
      <Section title="Motion: the six moments (and the spinner, and state fades)">
        <Table rows={entries(motion)} />
      </Section>
    </View>
  );
}
