import { Scroll, Text, View, windowSize, type JSX } from "nsh";
import { AlertDialog, Dialog } from "nsh/base";
import { L } from "../i18n";
import { IconBtn } from "./button";
import { Sheet } from "./sheet";
import { colors, floatSurface, measure, size, space, stroke, touch } from "./theme";

/**
 * A dialog over the window (nsh/base's `Dialog`: Escape, the backdrop and back close it) on the floating surface: a
 * title bar with a close button, the content scrolling under it, and `footer` (its buttons, the main action last) at
 * the bottom. `width` is its widest (default `measure.dialog`). Test ids: `<testID>` the dialog, `<testID>-close` its
 * close button. On phones it is a `Sheet` from the bottom.
 */
export function Modal(props: { open: boolean; onClose: () => void; title: string; testID?: string; width?: number; footer?: JSX.Element; children: JSX.Element }) {
  const body = () => (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingLeft: space.xxl, paddingRight: space.lg, minHeight: size.row.md + space.lg, borderBottomWidth: stroke.hairline, borderBottomColor: colors.hairline }}>
        <Text style={{ flex: 1, fontSize: size.text.title, fontWeight: "600", color: colors.fg, numberOfLines: 1 }}>{props.title}</Text>
        <IconBtn icon="close" tone="muted" testID={props.testID ? `${props.testID}-close` : undefined} label={L("Close", "关闭")} onPress={props.onClose} />
      </View>
      <Scroll style={{ flexShrink: 1, minHeight: 0 }} contentStyle={{ paddingHorizontal: touch ? space.xl : space.xxl, paddingVertical: space.xl, gap: space.lg }}>
        {props.children}
      </Scroll>
      {props.footer ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: touch ? space.xl : space.xxl, paddingVertical: space.lg, borderTopWidth: stroke.hairline, borderTopColor: colors.hairline }}>
          {props.footer}
        </View>
      ) : null}
    </>
  );
  // phones: a sheet from the bottom, where the thumb is
  if (touch) return <Sheet testID={props.testID} open={props.open} onClose={props.onClose}>{body()}</Sheet>;
  return (
    <Dialog
      testID={props.testID}
      open={props.open}
      animation="fade"
      onOpenChange={({ open }) => !open && props.onClose()}
      backdropClass="bg-scrim"
      style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl, pointerEvents: "box-none" }}
    >
      <View style={[floatSurface(), { width: "100%", maxWidth: props.width ?? measure.dialog, maxHeight: windowSize().height - 2 * space.xl, overflow: "hidden" }]}>
        {body()}
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
