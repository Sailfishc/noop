// The app's look, picked in Settings › General and kept on this device: the system's, light, dark (graphite), or black
// (true black surfaces, for OLED screens and dark rooms). Black is the dark appearance with darker tokens over it.
import { setColorScheme, setTheme, signal, Storage, type Theme } from "nsh";
import base from "../theme.json";

export type Appearance = "system" | "light" | "dark" | "black";
export const APPEARANCES: Appearance[] = ["system", "light", "dark", "black"];
export const APPEARANCE_KEY = "team.appearance";

/** The look picked (reactive). */
export const appearance = signal<Appearance>("system");

/** Black's surfaces: the page is #000, cards and controls a step above it, lines just visible. Text and accents stay. */
const BLACK: Record<string, string> = {
  background: "#000000", card: "#0f0f10", popover: "#121213", muted: "#161617", accent: "#1f1f21", border: "#262628",
  input: "#333336", inset: "#0a0a0a", raised: "#1a1a1c", field: "#0f0f10", line: "#1e1e20", hover: "#151516",
  track: "#2a2a2c", sidebar: "#060606", "sidebar-accent": "#1a1a1c", "sidebar-border": "#1a1a1c",
};

export function blackTheme(): Theme {
  const t = base as Theme;
  return { ...t, cssVars: { ...t.cssVars, dark: { ...t.cssVars.dark, ...BLACK } } };
}

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
