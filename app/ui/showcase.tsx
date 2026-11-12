// The component showcase: every component of app/ui with its variants and states, side by side. It is not part of
// the app: app/Showcase.tsx mounts it for screens.test.tsx, which saves it as showcase-light.png and
// showcase-dark.png. Look at it before building a page (what is there to use), and after changing a component.
// When you add a component or a variant to app/ui, add it here too.
import { Scroll, signal, Text, View, type JSX } from "nsh";
import { Avatar } from "./avatar";
import { Btn, IconBtn } from "./button";
import { Choice } from "./choice";
import { Count } from "./count";
import { Dot } from "./dot";
import { Empty } from "./empty";
import { ListRow } from "./list-row";
import { AccountRow } from "./account-row";
import { Tabs } from "./tabs";
import { ErrorNote } from "./error-note";
import { Field, TextArea } from "./field";
import { Icon, type IconName } from "./icons";
import { Label, Noted } from "./noted";
import { Card, Panel } from "./panel";
import { PickCard } from "./pick-card";
import { QrCode } from "./qr-code";
import { Spinner } from "./spinner";
import { Toggle } from "./switch";
import { Tag } from "./tag";
import { Modal } from "./dialog";
import { MenuHeading, MenuLine, MenuRow, PopMenu } from "./menu";
import { Dropdown } from "./select";
import { toast, Toaster } from "./toast";
import { Txt } from "./text";
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

const ICONS: IconName[] = ["plus", "check", "back", "chevron-down", "reply", "chat", "task", "user", "github", "info", "bell", "copy", "close", "search", "settings", "scan"];

export function Showcase() {
  const text = signal("");
  const area = signal("");
  const pick = signal<"a" | "b" | "c">("a");
  const on = signal(true);
  const card = signal("one");
  const dialog = signal(false);
  const tab = signal<"chat" | "tasks">("chat");
  const pickOne = signal<string | null>("codex");
  return (
    <Scroll testID="showcase" style={{ flex: 1, backgroundColor: colors.background }} contentStyle={{ padding: 24, gap: 24 }}>
      <Text style={{ fontSize: scale.text.display, fontWeight: "700", color: colors.text }}>Remi components</Text>

      <Section title="Txt: variant (caption 12 · body 13 · message 14 · title 16 · display 22) and tone">
        <View style={{ gap: 4 }}>
          <Txt variant="caption" tone="muted">Caption: a note, a time, meta</Txt>
          <Txt>Body: most text on a page</Txt>
          <Txt variant="message">Message: messages and what people type</Txt>
          <Txt variant="title">Title: a section or a panel</Txt>
          <Txt variant="display">Display: a page</Txt>
        </View>
        <Row>
          <Txt>default</Txt>
          <Txt tone="muted">muted</Txt>
          <Txt tone="faint">faint</Txt>
          <Txt tone="accent">accent</Txt>
          <Txt tone="up">up</Txt>
          <Txt tone="warn">warn</Txt>
          <Txt tone="danger">danger</Txt>
          <Txt weight="semibold">semibold</Txt>
          <Txt tabular mono>T-0042 12:30</Txt>
        </Row>
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

      <Section title="IconBtn: md, sm, selected, tones, disabled (hover shows its label)">
        <Row>
          <IconBtn icon="plus" label="Add" onPress={() => {}} />
          <IconBtn icon="copy" label="Copy" onPress={() => {}} />
          <IconBtn icon="bell" label="Notifications" selected onPress={() => {}} />
          <IconBtn icon="close" label="Close" size="sm" tone="muted" onPress={() => {}} />
          <IconBtn icon="trash" label="Delete" tone="danger" onPress={() => {}} />
          <IconBtn icon="settings" label="Settings" disabled onPress={() => {}} />
        </Row>
      </Section>

      <Section title="Field: label, hint, big (a code), small; TextArea (grows with its text)">
        <View style={{ flexDirection: "row", gap: 16 }}>
          <View style={{ flex: 1 }}>
            <Field label="Name" value={text()} onChange={text.set} placeholder="Placeholder" hint="One line of hint at most." />
          </View>
          <View style={{ flex: 1 }}>
            <Field value="12345678" onChange={() => {}} big />
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: 16, alignItems: "flex-start" }}>
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Field small grow value="A small inline field" onChange={() => {}} />
            <Btn small kind="ghost" label="Cancel" onPress={() => {}} />
            <Btn small kind="primary" label="Save" onPress={() => {}} />
          </View>
          <View style={{ flex: 1 }}>
            <TextArea value={area()} onChange={area.set} min={64} max={160} placeholder={"- One per line\n- It grows"} />
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
            <Label testID="showcase-label" text="A label with a note" note="The explanation lives behind the ⓘ, never under the label." />
            <Noted label={<Text style={{ fontSize: scale.text.body, color: colors.text }}>Noted, with something on the right</Text>} note="Pressing ⓘ shows this." right={<Tag label="right" />} />
            <View style={{ width: 260 }}>
              <Noted wrap label={<Text style={{ fontSize: scale.text.body, color: colors.text }}>Noted wrap: a sentence on a card wraps in a narrow column, its ⓘ after it</Text>} note="Without wrap a long label runs past the column." />
            </View>
          </View>
          <Panel title="Panel" note="A panel's note is behind its ⓘ too." style={{ flex: 1 }}>
            <Text style={{ fontSize: scale.text.body, color: colors.muted }}>Content</Text>
          </Panel>
        </View>
      </Section>

      <Section title="Overlays: Dropdown, PopMenu, Modal, toast (Tip shows on hover; confirm() is the system alert)">
        <Row>
          <View style={{ width: 200 }}>
            <Dropdown testID="showcase-dropdown" options={[{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude Code" }, { value: "pi", label: "Pi" }]} value={pickOne()} onChange={pickOne.set} label="Runtime" />
          </View>
          <View style={{ width: 120 }}>
            <Dropdown small options={[{ value: "a", label: "Small" }]} value={null} placeholder="Placeholder" onChange={() => {}} />
          </View>
          <PopMenu trigger={<View testID="showcase-menu" style={{ height: 30, justifyContent: "center", paddingHorizontal: 12, borderRadius: scale.radius.md, borderWidth: 1, borderColor: colors.fieldBorder }}><Text style={{ fontSize: scale.text.body, color: colors.text }}>Menu</Text></View>}>
            <MenuHeading text="Heading" />
            <MenuRow icon="settings" label="With an icon" right="⌘," onSelect={() => {}} />
            <MenuRow label="Checked" checked onSelect={() => {}} />
            <MenuRow label="Not checked" checked={false} onSelect={() => {}} />
            <MenuLine />
            <MenuRow icon="external" label="Danger" danger onSelect={() => {}} />
          </PopMenu>
          <Btn small testID="showcase-dialog-open" label="Open a Modal" onPress={() => dialog.set(true)} />
          <Btn small testID="showcase-toast" label="Toasts" onPress={() => { toast("Saved"); toast("Couldn’t save: the server returned 500", "error"); }} />
        </Row>
        <Modal open={dialog()} onClose={() => dialog.set(false)} title="A Modal" testID="showcase-dialog" width={480}
          footer={<View style={{ flex: 1, flexDirection: "row", justifyContent: "flex-end", gap: 8 }}><Btn kind="ghost" label="Cancel" onPress={() => dialog.set(false)} /><Btn kind="primary" label="Create" onPress={() => dialog.set(false)} /></View>}>
          <Field label="Name" value="" onChange={() => {}} placeholder="Its content scrolls; the footer stays." />
        </Modal>
      </Section>

      <Section title="Tag tones, Count, Dot (on / off / tones), Spinner, Empty">
        <Row>
          <Tag label="muted" />
          <Tag label="accent" tone="accent" />
          <Tag label="up" tone="up" />
          <Tag label="warn" tone="warn" />
          <Tag label="danger" tone="danger" />
          <Count n={3} />
          <Count n={128} />
          <Dot on />
          <Dot on={false} />
          <Dot tone="up" />
          <Dot tone="warn" />
          <Dot tone="danger" />
          <Dot tone="muted" />
          <Spinner size={14} tint={colors.muted} />
          <Empty />
        </Row>
      </Section>

      <Section title="Tabs, ListRow (plain, subtitle, selected), AccountRow, Card">
        <View style={{ flexDirection: "row", gap: 16, alignItems: "flex-start" }}>
          <View style={{ flex: 1, gap: 8 }}>
            <Tabs testID="showcase-tab" value={tab()} onChange={tab.set} tabs={[{ value: "chat", label: "Conversation" }, { value: "tasks", label: "Tasks", count: 4 }]} />
            <ListRow title="A row" left={<Icon name="chat" size={16} tint={colors.muted} />} right={<Tag label="3" />} onPress={() => {}} />
            <ListRow title="With a subtitle" subtitle="Codex · Ready" left={<Avatar name="acha" agent size={28} />} right={<Dot tone="up" />} onPress={() => {}} />
            <ListRow title="Selected" selected left={<Icon name="chat" size={16} tint={colors.muted} />} onPress={() => {}} />
            <AccountRow name="张伟" status="Live" live />
          </View>
          <View style={{ flex: 1 }}>
            <Card>
              <Txt>A Card: a bordered group without a title.</Txt>
              <Row><Btn small kind="primary" label="Save" onPress={() => {}} /></Row>
            </Card>
          </View>
        </View>
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

      <Section title="QrCode: black on white in both themes, 96 and 148">
        <Row>
          <QrCode value="remi://login?server=http%3A%2F%2Fremi.corp%3A8080&code=ABCD-EFGH" size={96} />
          <QrCode value="remi://login?server=http%3A%2F%2Fremi.corp%3A8080&code=ABCD-EFGH" size={148} />
        </Row>
      </Section>

      <Section title="Icon (a sample)">
        <Row>
          <Each of={ICONS}>{(n) => <Icon name={n()} size={18} tint={colors.text} />}</Each>
        </Row>
      </Section>
      <Toaster />
    </Scroll>
  );
}
