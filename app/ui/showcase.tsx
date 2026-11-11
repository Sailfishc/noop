// The component showcase: every component of app/ui with its variants and states, side by side. It is not part of
// the app: app/Showcase.tsx mounts it for screens.test.tsx, which saves it as showcase-light.png and
// showcase-dark.png. Look at it before building a page (what is there to use), and after changing a component.
// When you add a component or a variant to app/ui, add it here too.
import { Scroll, signal, Text, View, type JSX } from "nsh";
import { Avatar } from "./avatar";
import { Btn } from "./button";
import { Choice } from "./choice";
import { Dot, StateDot } from "./dot";
import { ErrorNote } from "./error-note";
import { Field } from "./field";
import { Icon, type IconName } from "./icons";
import { Label, Noted } from "./noted";
import { Panel } from "./panel";
import { PickCard } from "./pick-card";
import { Spinner } from "./spinner";
import { Toggle } from "./switch";
import { Tag } from "./tag";
import { colors, scale } from "./theme";

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: scale.text.caption, fontWeight: "600", color: colors.faint }}>{props.title}</Text>
      {props.children}
    </View>
  );
}

const Row = (props: { children: JSX.Element }) => <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>{props.children}</View>;

const ICONS: IconName[] = ["plus", "check", "back", "chevron-down", "reply", "chat", "task", "user", "github", "info", "bell", "copy", "close", "search", "settings"];

export function Showcase() {
  const text = signal("");
  const pick = signal<"a" | "b" | "c">("a");
  const on = signal(true);
  const card = signal("one");
  return (
    <Scroll testID="showcase" style={{ flex: 1, backgroundColor: colors.background }} contentStyle={{ padding: 24, gap: 24 }}>
      <Text style={{ fontSize: scale.text.display, fontWeight: "700", color: colors.text }}>Remi components</Text>

      <Section title="Text scale: caption 12 · body 13 · message 14 · title 16 · display 22">
        <View style={{ gap: 4 }}>
          <Text style={{ fontSize: scale.text.caption, color: colors.muted }}>Caption: a note, a time, meta</Text>
          <Text style={{ fontSize: scale.text.body, color: colors.text }}>Body: most text on a page</Text>
          <Text style={{ fontSize: scale.text.message, color: colors.text }}>Message: messages and what people type</Text>
          <Text style={{ fontSize: scale.text.title, fontWeight: "600", color: colors.text }}>Title: a section or a panel</Text>
          <Text style={{ fontSize: scale.text.display, fontWeight: "700", color: colors.text }}>Display: a page</Text>
        </View>
      </Section>

      <Section title="Btn: kind × size, icon, busy, disabled">
        <Row>
          <Btn label="Primary" kind="primary" onPress={() => {}} />
          <Btn label="Plain" onPress={() => {}} />
          <Btn label="Ghost" kind="ghost" onPress={() => {}} />
          <Btn label="Danger" kind="danger" onPress={() => {}} />
          <Btn label="With icon" icon="plus" onPress={() => {}} />
          <Btn label="Busy" kind="primary" busy onPress={() => {}} />
          <Btn label="Disabled" disabled onPress={() => {}} />
        </Row>
        <Row>
          <Btn small label="Primary" kind="primary" onPress={() => {}} />
          <Btn small label="Plain" onPress={() => {}} />
          <Btn small label="Ghost" kind="ghost" onPress={() => {}} />
          <Btn small label="Danger" kind="danger" onPress={() => {}} />
          <Btn small label="With icon" icon="plus" onPress={() => {}} />
          <Btn small label="Disabled" disabled onPress={() => {}} />
        </Row>
      </Section>

      <Section title="Field: label, hint, big (a code)">
        <View style={{ flexDirection: "row", gap: 16 }}>
          <View style={{ flex: 1 }}>
            <Field label="Name" value={text()} onChange={text.set} placeholder="Placeholder" hint="One line of hint at most." />
          </View>
          <View style={{ flex: 1 }}>
            <Field value="12345678" onChange={() => {}} big />
          </View>
        </View>
      </Section>

      <Section title="ErrorNote">
        <ErrorNote text="Can’t reach the server. Check the address and your network." />
      </Section>

      <Section title="Choice, Toggle">
        <Row>
          <Choice options={[{ value: "a", label: "One" }, { value: "b", label: "Two" }, { value: "c", label: "Three" }]} value={pick()} onChange={pick.set} />
          <Toggle value={on()} onChange={on.set} label="On" />
          <Toggle value={false} onChange={() => {}} label="Off" />
        </Row>
      </Section>

      <Section title="Label, Noted (ⓘ), Panel">
        <View style={{ flexDirection: "row", gap: 16, alignItems: "flex-start" }}>
          <View style={{ flex: 1, gap: 12 }}>
            <Label text="A label with a note" note="The explanation lives behind the ⓘ, never under the label." />
            <Noted label={<Text style={{ fontSize: scale.text.body, color: colors.text }}>Noted, with something on the right</Text>} note="Pressing ⓘ shows this." right={<Tag label="right" />} />
          </View>
          <Panel title="Panel" note="A panel's note is behind its ⓘ too." style={{ flex: 1 }}>
            <Text style={{ fontSize: scale.text.body, color: colors.muted }}>Content</Text>
          </Panel>
        </View>
      </Section>

      <Section title="Tag tones, Dot, StateDot, Spinner">
        <Row>
          <Tag label="muted" />
          <Tag label="accent" tone="accent" />
          <Tag label="up" tone="up" />
          <Tag label="warn" tone="warn" />
          <Tag label="danger" tone="danger" />
          <Dot on />
          <Dot on={false} />
          <StateDot tone="up" />
          <StateDot tone="warn" />
          <StateDot tone="danger" />
          <StateDot tone="muted" />
          <Spinner size={14} tint={colors.muted} />
        </Row>
      </Section>

      <Section title="Avatar: person, agent, sizes">
        <Row>
          <Avatar name="张伟" />
          <Avatar name="acha" agent />
          <Avatar name="王磊" size={24} />
          <Avatar name="notes" agent size={24} />
        </Row>
      </Section>

      <Section title="PickCard: picked, plain, disabled">
        <View style={{ flexDirection: "row", gap: 8 }}>
          <PickCard title="One" note="Picked" picked={card() === "one"} onPress={() => card.set("one")} />
          <PickCard title="Two" note="Not picked" picked={card() === "two"} onPress={() => card.set("two")} />
          <PickCard title="Three" note="Disabled" picked={false} disabled onPress={() => {}} />
        </View>
      </Section>

      <Section title="Icon (a sample)">
        <Row>
          <Each of={ICONS}>{(n) => <Icon name={n()} size={18} tint={colors.text} />}</Each>
        </Row>
      </Section>
    </Scroll>
  );
}
