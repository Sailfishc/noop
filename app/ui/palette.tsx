import { Text, View, type JSX } from "nsh";
import { Command, Dialog } from "nsh/base";
import { Icon, type IconName } from "./icons";
import { colors, floatSurface, measure, radius, size, space, stroke } from "./theme";

/** One command of the palette: what it does in a few words, its group (前往, 动作, 搜索), the words it also answers to. */
export type PaletteItem = { id: string; label: string; group: string; keywords?: string[]; icon?: IconName; keys?: string; checked?: boolean; disabled?: boolean };

/** A key or a sequence of keys as a hint (⌘K, G I): the keycap look, quiet. */
export function Keys(props: { keys: string }) {
  return (
    <View style={{ flexDirection: "row", gap: space.xxs }}>
      <Each of={props.keys.split(" ")} key="index">
        {(k) => (
          <View style={{ minWidth: size.mark.count, minHeight: size.mark.count, paddingHorizontal: space.xs, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", backgroundColor: colors.hover }}>
            <Text style={{ fontSize: size.text.caption, color: colors.fg2, fontVariant: ["tabular-nums"] }}>{k()}</Text>
          </View>
        )}
      </Each>
    </View>
  );
}

/**
 * The command palette (⌘K; nsh/base's `Command` in a `Dialog`): a search field over every command, filtered as the
 * person types, the keys, Return and Escape included; the floating surface near the window's top. `items` come from
 * the app's one command registry, so the palette, the shortcuts and the context menus say the same names. `query` is
 * the app's (a search of messages answers it as one more group). Test ids: `<testID>` the dialog, `<testID>-<id>` a row.
 */
export function CommandPalette(props: {
  open: boolean;
  onClose: () => void;
  items: PaletteItem[];
  onSelect: (id: string) => void;
  query: string;
  onQuery: (q: string) => void;
  placeholder: string;
  label: string;
  empty?: string;
  testID?: string;
}) {
  const byId = () => new Map(props.items.map((x) => [x.id, x]));
  const row = (e: { id: string; label: string }): JSX.Element => {
    const it = byId().get(e.id);
    return (
      <View testID={props.testID ? `${props.testID}-${e.id}` : undefined} style={{ alignSelf: "stretch", flexGrow: 1, flexDirection: "row", alignItems: "center", gap: space.md }}>
        <If when={it?.icon}>{(i) => <Icon name={i()} size={size.icon.md} tint={colors.fg2} />}</If>
        <Text style={{ flex: 1, fontSize: size.text.body, color: colors.fg, numberOfLines: 1 }}>{e.label}</Text>
        <If when={it?.checked}><Icon name="check" size={size.icon.sm} tint={colors.fg2} /></If>
        <If when={it?.keys}>{(k) => <Keys keys={k()} />}</If>
      </View>
    );
  };
  return (
    <Dialog
      testID={props.testID}
      open={props.open}
      animation="fade"
      onOpenChange={({ open }) => !open && props.onClose()}
      backdropClass="bg-scrim"
      style={{ flex: 1, alignItems: "center", paddingTop: measure.paletteTop, paddingHorizontal: space.xl, pointerEvents: "box-none" }}
    >
      <View style={[floatSurface(), { width: "100%", maxWidth: measure.palette, overflow: "hidden" }]}>
        <Command
          testID={props.testID ? `${props.testID}-command` : undefined}
          items={props.items.map((x) => ({ id: x.id, label: x.label, group: x.group, keywords: x.keywords, checked: x.checked, disabled: x.disabled }))}
          query={props.query}
          onQueryChange={({ query }) => props.onQuery(query)}
          onSelect={({ id }) => props.onSelect(id)}
          onCancel={props.onClose}
          autoFocus
          placeholder={props.placeholder}
          accessibilityLabel={props.label}
          searchBarStyle={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: size.row.md, paddingHorizontal: space.lg, borderBottomWidth: stroke.hairline, borderBottomColor: colors.hairline }}
          searchStyle={{ flex: 1, fontSize: size.text.message, color: colors.fg, placeholderColor: colors.fg3 }}
          searchPrefix={<Icon name="search" size={size.icon.md} tint={colors.fg3} />}
          listStyle={{ maxHeight: measure.paletteList, padding: space.xs }}
          itemClass="focus:bg-selected hover:bg-hover"
          itemStyle={{ minHeight: size.row.menu, paddingHorizontal: space.md, borderRadius: radius.sm, justifyContent: "center" }}
          groupStyle={{ paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.xs, fontSize: size.text.caption, fontWeight: "600", color: colors.fg3 }}
          separatorStyle={{ height: stroke.hairline, marginVertical: space.xs, backgroundColor: colors.hairline }}
          renderItem={row}
          empty={<Text style={{ padding: space.xl, fontSize: size.text.body, color: colors.fg3 }}>{props.empty ?? ""}</Text>}
        />
      </View>
    </Dialog>
  );
}
