// The app's own updates (update.ts decides; nsh/updater does the work): checked now and then, downloaded quietly, and
// a row in the sidebar once there is something to press. The restart stays the person's.
import { cleanup, openUrl, platform, signal, Text, View } from "nsh";
import { checkForPackage, checkForUpdate, downloadPackage, downloadUpdate, installAndRestart, restartToPackage, runningPackage } from "nsh/updater";
import { L } from "../i18n";
import { alpha, colors, hovered, Spinner } from "../ui";
import { CHECK_EVERY_MS, createUpdates, type UpdateState } from "../update";
import { CLIENT_VERSION } from "../version";

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

/** A development build has no update source (scripts/release-config.sh adds it to release builds only). */
export const canCheckUpdates = CLIENT_VERSION !== "dev";

/** What a check someone asked for found, shown in the update row's place while there is nothing to press. */
export const checkNote = signal<"" | "checking" | "current" | "failed" | "staged">("");
let noteTimer: ReturnType<typeof setTimeout> | undefined;

/** The menu's "Check for updates": checks now; a found update shows as the timer's would, the rest as a short note. */
export async function checkNow() {
  clearTimeout(noteTimer);
  checkNote.set("checking");
  const result = await updates.check();
  if (result === "busy") return;
  const note = result === "current" ? "current" : result === "failed" ? "failed" : appUpdate().kind === "staged" ? "staged" : "";
  checkNote.set(note);
  if (note) noteTimer = setTimeout(() => checkNote.set(""), 8000);
}

function noteText(note: ReturnType<typeof checkNote>): string {
  const u = appUpdate();
  if (note === "checking") return L("Checking for updates…", "正在检查更新…");
  if (note === "current") return L(`Remi ${CLIENT_VERSION} is up to date`, `Remi ${CLIENT_VERSION} 已是最新版本`);
  if (note === "failed") return L("Couldn't check for updates. Try again later.", "检查更新失败，稍后再试");
  if (note === "staged" && u.kind === "staged") return L(`${u.version} is downloaded and runs from the next launch`, `${u.version} 已下载，下次打开时生效`);
  return "";
}

/** Above the sidebar's footer, only when there is something to press, or a note from a check someone asked for. */
export function UpdateRow() {
  return (
    <>
      <UpdateButton />
      <If when={(appUpdate().kind === "none" || appUpdate().kind === "staged") && noteText(checkNote())}>
        <View testID="update-note" style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 30, paddingHorizontal: 10 }}>
          <If when={checkNote() === "checking"}>
            <Spinner size={12} tint={colors.muted} />
          </If>
          <Text style={{ flexShrink: 1, fontSize: 12.5, color: colors.muted, numberOfLines: 2 }}>{noteText(checkNote())}</Text>
        </View>
      </If>
    </>
  );
}

function UpdateButton() {
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
