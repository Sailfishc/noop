// The app's look, picked in Settings › General and kept on this device: the system's, light, dark, or black (true
// black surfaces, for OLED screens and dark rooms). Black is the dark appearance with the generated black tokens over
// it (app/design/tokens.ts, `ladder.black`).
import { setColorScheme, setTheme, signal, Storage } from "nsh";
import { blackTheme } from "../ui";

export type Appearance = "system" | "light" | "dark" | "black";
export const APPEARANCES: Appearance[] = ["system", "light", "dark", "black"];
export const APPEARANCE_KEY = "team.appearance";

/** The look picked (reactive). */
export const appearance = signal<Appearance>("system");

/** Shows the app in `a` at once. */
export function applyAppearance(a: Appearance) {
  appearance.set(a);
  setColorScheme(a === "system" ? "system" : a === "light" ? "light" : "dark");
  setTheme(a === "black" ? blackTheme() : null);
}

/** Picks `a` and keeps it on this device. */
export function pickAppearance(a: Appearance) {
  applyAppearance(a);
  void Storage.setItem(APPEARANCE_KEY, a);
}

/** The look this device kept, if any. */
export async function loadAppearance() {
  const saved = await Storage.getItem(APPEARANCE_KEY);
  if (saved && (APPEARANCES as string[]).includes(saved)) applyAppearance(saved as Appearance);
}
