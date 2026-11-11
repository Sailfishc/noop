// Remi's design tokens: the colors, the type, radius, spacing and control scales of app/theme.json, and the
// finishes (shadows and gradients) the popups and the switch use. Components in app/ui read these; pages don't.
import type { Tokens, ViewStyle } from "nsh";
import { token } from "nsh";
import { Easing } from "nsh";
import { colorScheme } from "nsh";
import finishes from "./finishes.json";

/** Whether the shared example UI shows its dark palette (reactive: reading it subscribes). */
export const isDark = () => colorScheme() !== "light";

/**
 * An object with `dark`'s keys whose getters read `dark` or `light` by the
 * appearance shown, for the finishes below: shadows and gradients are no
 * design tokens, so they stay here while every color is the theme's.
 */
function themed<T extends object>(dark: T, light: T): T {
  const out = {} as T;
  for (const key of Object.keys(dark) as (keyof T)[]) {
    Object.defineProperty(out, key, { enumerable: true, get: () => (isDark() ? dark : light)[key] });
  }
  return out;
}

/** The roles of the palette. */
export interface Palette {
  /** The page behind the cards. */
  background: string;
  /** A card. */
  surface: string;
  /** A surface inside a card. */
  inset: string;
  /** A control on a card (buttons, fields, tracks). */
  raised: string;
  /** An input's well: below the card and the insets it sits on. */
  field: string;
  /** An input's edge. */
  fieldBorder: string;
  border: string;
  /** Hairlines inside insets. */
  line: string;
  text: string;
  muted: string;
  faint: string;
  /** The accent as a foreground: text, icons, lines, small marks. */
  accent: string;
  /** The accent as a fill (buttons, bubbles), with `onAccent` on it. */
  accentFill: string;
  /** Text on the accent fill. */
  onAccent: string;
  /** The main action's button: light on the dark page, dark on the light one. */
  light: string;
  /** Text on `light`. */
  onLight: string;
  /** The app's sidebar, beside the page. */
  sidebar: string;
  /** A switch's track when off. */
  track: string;
  /** A switch's knob when off. */
  knob: string;
  /** Code inside insets. */
  code: string;
  info: string;
  warn: string;
  danger: string;
  up: string;
  switchOn: string;
  down: string;
}

/** An object whose getters read the theme's tokens: reads in a reactive
 * scope (JSX, a `draw`, an effect) follow the appearance and the theme. */
function tokens<K extends string>(names: Record<K, keyof Tokens>): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const key of Object.keys(names) as K[]) {
    Object.defineProperty(out, key, { enumerable: true, get: () => token(names[key]) });
  }
  return out;
}

/**
 * The shared example UI's look: a graphite page (or a paper one in light
 * appearance), cards with an inset surface, tabular numbers and one citrus
 * accent, its colors the tokens of `theme.json`. Desktops are compact
 * (28-point controls, 13-point labels), touch screens roomier (36 to 40
 * points).
 */
export const colors: Palette = tokens<keyof Palette>({
  background: "background",
  surface: "card",
  inset: "inset",
  raised: "raised",
  field: "field",
  fieldBorder: "input",
  border: "border",
  line: "line",
  text: "foreground",
  muted: "muted-foreground",
  faint: "faint",
  accent: "brand",
  accentFill: "brand-fill",
  onAccent: "on-brand",
  light: "primary",
  onLight: "primary-foreground",
  sidebar: "sidebar",
  track: "track",
  knob: "knob",
  code: "code",
  info: "info",
  warn: "warn",
  danger: "destructive",
  up: "up",
  switchOn: "switch-on",
  down: "down",
});

/** `color` at opacity `a`. */
export function alpha(color: string, a: number) {
  return `color-mix(in srgb, ${color} ${a * 100}%, transparent)`;
}

/** Translucent tints of the tones, for fills behind text. */
export const tints = tokens({
  accent: "brand-tint",
  info: "info-tint",
  warn: "warn-tint",
  danger: "destructive-tint",
  up: "up-tint",
  down: "down-tint",
});

/** A surface's finish: a gradient over its color and its shadows. */
export interface Finish {
  backgroundColor?: string;
  backgroundImage?: string;
  boxShadow: string;
  borderColor?: string;
  backdropFilter?: string;
}

/**
 * Light and depth, kept quiet: one-color edges (corners join cleanly), a
 * hard 1-point drop under what stands up and a 1-point inner shade in what
 * is sunk; only floating surfaces (menus, glass) cast a soft
 * shadow. `hover` and `pressed` are a raised control's states, `fill` a
 * slider's or a meter's run of the accent.
 */
export const finish = themed<
  Record<"card" | "inset" | "field" | "raised" | "hover" | "pressed" | "light" | "accent" | "track" | "fill" | "knob" | "pill" | "chip" | "glass" | "menu", Finish>
>(finishes.dark, finishes.light);

/**
 * Corner radii in use today (`theme.json`'s `radius-card`, `radius`, `radius-control`). New code takes a step of
 * `scale.radius` instead; these go once the components that read them move onto it.
 */
export const radius = {
  get card() {
    return token("radius-card");
  },
  get inset() {
    return token("radius");
  },
  get control() {
    return token("radius-control");
  },
};


/**
 * The motion every control shares: quick, slightly springy. `control` and
 * `move` are gpui-kit's `spring_control` (a 180 ms response, no overshoot:
 * a mark or a fill coming and going) and `spring_move` (280 ms, a damping
 * ratio of 0.85: a thumb or an indicator traveling) as a unit mass's
 * stiffness (2π / response)² and damping 2 · ratio · 2π / response.
 */
export const motion = {
  press: { stiffness: 520, damping: 34 },
  settle: { stiffness: 320, damping: 30 },
  control: { stiffness: 1218, damping: 70 },
  move: { stiffness: 504, damping: 38 },
  enter: { duration: 420, easing: Easing.out(Easing.cubic) },
} as const;

/**
 * A pressable under the pointer (`hoverStyle`): a whisper of the text color
 * over its surface, quieter than pressed and than selected. Leave it off a
 * disabled control and off a selected one, whose own fill shows.
 */
export const hovered = (): ViewStyle => ({ backgroundColor: alpha(colors.text, 0.05) });

/**
 * The keyboard focus (`focusStyle`): the edge turns the theme's muted olive
 * `ring` and a 3-point halo of it lies around the view (`offset` moves the
 * halo out from the edge).
 */
export const focusRing = (offset = 0): ViewStyle => ({
  borderColor: token("ring"),
  outlineStyle: "solid",
  outlineWidth: 3,
  outlineColor: isDark() ? "rgba(245,245,245,0.12)" : "rgba(17,17,17,0.10)",
  outlineOffset: offset,
});


/**
 * The scales every component draws with (`theme.json`, under `cssVars.theme`). Text sizes: `caption` 12 (secondary
 * notes, meta), `body` 13 (most text), `message` 14 (messages and inputs), `title` 16 (headings), `display` 22 (a
 * page's big title). Radii: `sm` 6 (tags, small marks), `md` 8 (buttons, inputs), `lg` 12 (cards, panels, popups).
 * Spacing is Tailwind's steps 0.5, 1, 1.5, 2, 3, 4, 6 (2, 4, 6, 8, 12, 16, 24 points) and nothing else. Controls are
 * `sm` 30 or `md` 40 tall. Read them in JSX so a theme change is followed.
 */
export const scale = {
  text: {
    get caption() { return token("text-caption"); },
    get body() { return token("text-body"); },
    get message() { return token("text-message"); },
    get title() { return token("text-title"); },
    get display() { return token("text-display"); },
  },
  radius: {
    get sm() { return token("radius-sm"); },
    get md() { return token("radius-md"); },
    get lg() { return token("radius-lg"); },
  },
  space: [2, 4, 6, 8, 12, 16, 24] as const,
  control: {
    get sm() { return token("control-sm"); },
    get md() { return token("control-md"); },
  },
};
