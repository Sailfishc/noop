import { Scroll, Text, View, windowSize, type JSX } from "nsh";
import { AlertDialog, Dialog } from "nsh/base";
import { L } from "../i18n";
import { IconBtn } from "./button";
import { colors, scale } from "./theme";

/**
 * A dialog over the window (nsh/base's `Dialog`: Escape, the backdrop and back close it): a title bar with a close
 * button, the content scrolling under it, and `footer` (its buttons, the main action last) at the bottom. `width` is
 * its widest (default 640). Test ids: `<testID>` the dialog, `<testID>-close` its close button.
 */
export function Modal(props: { open: boolean; onClose: () => void; title: string; testID?: string; width?: number; footer?: JSX.Element; children: JSX.Element }) {
  return (
    <Dialog
      testID={props.testID}
      open={props.open}
      animation="fade"
      onOpenChange={({ open }) => !open && props.onClose()}
      backdropClass="bg-scrim"
      style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "box-none" }}
    >
      <View style={{ width: "100%", maxWidth: props.width ?? 640, maxHeight: windowSize().height - 32, borderRadius: scale.radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background, overflow: "hidden" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 24, paddingRight: 12, height: 56, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <Text style={{ flex: 1, fontSize: scale.text.title, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{props.title}</Text>
          <IconBtn icon="close" tone="muted" testID={props.testID ? `${props.testID}-close` : undefined} label={L("Close", "关闭")} onPress={props.onClose} />
        </View>
        <Scroll style={{ flexShrink: 1, minHeight: 0 }} contentStyle={{ paddingHorizontal: 24, paddingVertical: 16, gap: 12 }}>
          {props.children}
        </Scroll>
        {props.footer ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 24, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border }}>
            {props.footer}
          </View>
        ) : null}
      </View>
    </Dialog>
  );
}

/**
 * Asks before something that can't be undone or that sends data elsewhere, in the system's own alert: resolves true
 * when the person chose `confirm`. `message` is the one sentence they must read first; `danger` marks the action as
 * destructive.
 */
export async function confirm(o: { title: string; message?: string; confirm: string; cancel?: string; danger?: boolean }): Promise<boolean> {
  const r = await AlertDialog.show({
    title: o.title,
    description: o.message,
    actions: [
      { id: "cancel", label: o.cancel ?? L("Cancel", "取消"), role: "cancel" },
      { id: "confirm", label: o.confirm, role: o.danger ? "destructive" : "default" },
    ],
  });
  return r.action === "confirm";
}
