// Remi: several people and their agents in shared channels. One TSX app for the web (served by the Go server), macOS,
// Linux and phones. The client itself is app/team/ (TeamApp); this file only sets up the window and mounts it.
import { mount, Storage } from "nsh";
import { Scrollbar } from "nsh/base";
import { currentWindow, isAvailable as hasWindow } from "nsh/desktop";
import { lang, LANG_KEY } from "./i18n";
import { AppFrame, scrollbarTheme, titleBarHeight, Toaster } from "./ui";
import { loadAppearance } from "./team/appearance";
import { TeamApp } from "./team/TeamApp";
import { watchUpdates } from "./team/updates";

function Root() {
  void Storage.getItem(LANG_KEY).then((saved) => {
    if (saved === "en" || saved === "zh") lang.set(saved);
  });
  void loadAppearance();
  if (hasWindow) currentWindow().set({ title: "Remi", titleBar: { style: "hidden", height: titleBarHeight } });
  Scrollbar.setTheme(scrollbarTheme);
  watchUpdates();
  return (
    <AppFrame>
      <TeamApp />
      <Toaster />
    </AppFrame>
  );
}

mount(Root);
