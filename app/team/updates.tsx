// The app's own updates (update.ts decides; nsh/updater does the work): checked now and then, downloaded quietly, and
// a row in the sidebar once there is something to press. The restart stays the person's.
import { cleanup, openUrl, platform, signal, Text, View } from "nsh";
import { checkForPackage, checkForUpdate, downloadPackage, downloadUpdate, installAndRestart, restartToPackage, runningPackage } from "nsh/updater";
import { L } from "../i18n";
import { alpha, colors, hovered, Spinner } from "../ui";
import { CHECK_EVERY_MS, createUpdates, type UpdateState } from "../update";

export const appUpdate = signal<UpdateState>({ kind: "none" });
export const updates = createUpdates(
  {
    check: checkForUpdate, download: () => downloadUpdate(), install: installAndRestart,
    // OTA: a signed package of the app's code. Phones cannot restart an app, so there it runs from the next launch.
    packages: { check: checkForPackage, download: () => downloadPackage(), restart: platform.os === "ios" || platform.os === "android" ? null : restartToPackage, running: runningPackage },
  },
  (state) => appUpdate.set(state),
);

/** The first check waits for the app to settle; nsh/updater answers null where apps do not update (the web, a dev run). */
export function watchUpdates() {
  const first = setTimeout(() => void updates.check(), 5000);
  const timer = setInterval(() => void updates.check(), CHECK_EVERY_MS);
  cleanup(() => { clearTimeout(first); clearInterval(timer); });
}

/** Above the sidebar's footer, only when there is something to press. */
export function UpdateRow() {
  const state = () => appUpdate();
  const version = () => { const u = state(); return u.kind === "none" ? "" : u.version; };
  const label = () => {
    const u = state();
    if (u.kind === "link") return L(`Download ${u.version}`, `下载新版本 ${u.version}`);
    if (u.kind === "installing") return L("Updating…", "正在更新…");
    if (u.kind === "failed") return L("Update failed. Click to retry.", "更新失败，点此重试");
    return L(`Restart to update to ${version()}`, `重启以更新到 ${version()}`);
  };
  const press = () => {
    const u = state();
    if (u.kind === "link") void openUrl(u.url).catch(() => {});
    else if (u.kind !== "installing") void updates.install();
  };
  return (
    <If when={state().kind !== "none" && state().kind !== "staged"}>
      <View role="button" testID="app-update" accessibilityLabel={label()} onPress={press} hoverStyle={hovered()}
        style={{ minHeight: 36, justifyContent: "center", gap: 2, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: alpha(colors.text, 0.08) }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <If when={state().kind === "installing"}>
            <Spinner size={12} tint={colors.muted} />
          </If>
          <Text style={{ flexShrink: 1, fontSize: 13.5, color: state().kind === "installing" ? colors.muted : colors.accent, numberOfLines: 1 }}>{label()}</Text>
        </View>
        <If when={state().kind === "failed"}>
          <Text style={{ fontSize: 12, lineHeight: 16, color: colors.muted, numberOfLines: 2 }}>{(state() as { message?: string }).message}</Text>
        </If>
      </View>
    </If>
  );
}
