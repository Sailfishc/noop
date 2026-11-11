// Remi: several people and their agents in shared channels. One TSX app for the web (served by the Go server), macOS,
// Linux and phones. The client itself is app/team/ (TeamApp); this file only sets up the window and mounts it.
import { mount, platform, safeArea, Storage, View } from "nsh";
import { Scrollbar } from "nsh/base";
import { currentWindow, isAvailable as hasWindow } from "nsh/desktop";
import { lang, LANG_KEY } from "./i18n";
import { colors, scrollbarTheme, Toaster } from "./ui";
import { loadAppearance } from "./team/appearance";
import { TeamApp } from "./team/TeamApp";
import { watchUpdates } from "./team/updates";

const touch = !(platform.idiom === "desktop" || platform.idiom === "mac");

function Root() {
  void Storage.getItem(LANG_KEY).then((saved) => {
    if (saved === "en" || saved === "zh") lang.set(saved);
  });
  void loadAppearance();
  if (hasWindow) currentWindow().set({ title: "Remi", titleBar: { style: "hidden", height: touch ? 56 : 52 } });
  Scrollbar.setTheme(scrollbarTheme);
  watchUpdates();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: touch ? safeArea().top : 0 }}>
      <TeamApp />
      <Toaster />
    </View>
  );
}

mount(Root);
