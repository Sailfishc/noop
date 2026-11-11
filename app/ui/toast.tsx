import { Overlay, signal, Text, View } from "nsh";
import { Toast } from "nsh/base";
import { Icon, type IconName } from "./icons";
import { colors, scale } from "./theme";

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
  done: { icon: "check", tint: () => colors.up },
  error: { icon: "info", tint: () => colors.danger },
  info: { icon: "info", tint: () => colors.muted },
};

/** Where `toast` shows its messages: mount one, at the app's root. */
export function Toaster() {
  return (
    <If when={items().length}>
      <Overlay style={{ top: 16, right: 16, gap: 8, alignItems: "flex-end", pointerEvents: "box-none" }}>
        <Each of={items()} key={(x) => x.id}>
          {(x) => (
            <Toast
              testID={`toast-${x().tone}`}
              accessibilityLabel={x().text}
              swipeDirection="right"
              onDismissRequest={() => items.update((xs) => xs.filter((y) => y.id !== x().id))}
              style={{ maxWidth: 360, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: scale.radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, boxShadow: "0 6px 20px rgba(0,0,0,0.12)" }}
            >
              <Icon name={look[x().tone].icon} size={14} tint={look[x().tone].tint()} />
              <Text style={{ flexShrink: 1, fontSize: scale.text.body, lineHeight: 19, color: colors.text }}>{x().text}</Text>
            </Toast>
          )}
        </Each>
      </Overlay>
    </If>
  );
}
