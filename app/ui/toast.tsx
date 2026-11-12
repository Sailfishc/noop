import { Overlay, signal, Text, View } from "nsh";
import { Toast } from "nsh/base";
import { Icon, type IconName } from "./icons";
import { colors, floatSurface, measure, radius, size, space } from "./theme";

type Tone = "done" | "error" | "info";
type Item = { id: number; text: string; tone: Tone };

const items = signal<Item[]>([]);
let next = 1;

/**
 * Says how something went, for a few seconds at the window's top right: `done` (saved, sent), `error` (it failed;
 * stays 6 s), `info`. Use it for the outcome of an action instead of a line of text left on the page. Needs one
 * `<Toaster />` in the app (App.tsx has it).
 */
export function toast(text: string, tone: Tone = "done") {
  const id = next++;
  items.update((xs) => [...xs.slice(-2), { id, text, tone }]);
  setTimeout(() => items.update((xs) => xs.filter((x) => x.id !== id)), tone === "error" ? 6000 : 3000);
}

const look: Record<Tone, { icon: IconName; tint: () => string }> = {
  done: { icon: "check", tint: () => colors.ok },
  error: { icon: "info", tint: () => colors.danger },
  info: { icon: "info", tint: () => colors.fg2 },
};

/** Where `toast` shows its messages: mount one, at the app's root. */
export function Toaster() {
  return (
    <If when={items().length}>
      <Overlay style={{ top: space.xl, right: space.xl, gap: space.md, alignItems: "flex-end", pointerEvents: "box-none" }}>
        <Each of={items()} key={(x) => x.id}>
          {(x) => (
            <Toast
              testID={`toast-${x().tone}`}
              accessibilityLabel={x().text}
              swipeDirection="right"
              onDismissRequest={() => items.update((xs) => xs.filter((y) => y.id !== x().id))}
              style={[floatSurface(), { maxWidth: measure.toast, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.lg }]}
            >
              <Icon name={look[x().tone].icon} size={size.icon.sm} tint={look[x().tone].tint()} />
              <Text style={{ flexShrink: 1, fontSize: size.text.body, lineHeight: size.leading.body, color: colors.fg }}>{x().text}</Text>
            </Toast>
          )}
        </Each>
      </Overlay>
    </If>
  );
}
