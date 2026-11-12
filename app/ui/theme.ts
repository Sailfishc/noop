// The design system's middle tier as app/ui's components read it: the semantic tokens generated from
// app/design/tokens.ts (./tokens.gen.ts), the density this device draws at, and a few helpers built only of tokens
// (hover, focus, the floating surface, the press motion). Components in app/ui read these; pages (app/team) don't:
// they use components (AGENTS.md, "Client components"; scripts/check-ui.ts enforces it).
import type { AnimatedValue, Theme, ViewStyle } from "nsh";
import { colorScheme, createAnimatedValue, effect, platform, reduceMotion } from "nsh";
import base from "../theme.json";
import * as gen from "./tokens.gen";

export { backdrop, colors, type ColorRole, identities, measure, motion, opacity, radius, space, stroke } from "./tokens.gen";
const { colors } = gen;

/**
 * Touch density: a finger instead of a pointer. Decided by the device (NSH's `platform.desktop`: macOS, Windows,
 * Linux and browsers with a mouse and a wide window), never by the window's width, and only here: pages never read
 * the platform for their look.
 */
export const touch = !platform.desktop;

/** The sizes this device draws with: `densities.touch` on phones and pads, `densities.pointer` on desktops. */
export const size = touch ? gen.densities.touch : gen.densities.pointer;

/** Whether the dark (or black) appearance shows (reactive: reading it subscribes). */
export const isDark = () => colorScheme() !== "light";

/** Shadows by appearance: read them in JSX so a change of appearance is followed. */
export const elevation = {
  get float() {
    return gen.elevation[isDark() ? "dark" : "light"].float;
  },
  get knob() {
    return gen.elevation[isDark() ? "dark" : "light"].knob;
  },
};

/** Whether the platform draws a backdrop blur (Linux's native views don't: floating surfaces go opaque there). */
const blurs = platform.os !== "linux";

/**
 * The floating surface every menu, popover, tooltip, toast, dialog and the command palette share: glass (the float
 * color, translucent, over a blur) where the platform draws blur and opaque where it doesn't, a hairline edge, three
 * faint shadow layers and the floating radius.
 */
export const floatSurface = (): ViewStyle => ({
  backgroundColor: blurs ? colors.float : colors.floatSolid,
  backdropFilter: blurs ? gen.backdrop : undefined,
  borderRadius: gen.radius.float,
  borderWidth: gen.stroke.hairline,
  borderColor: colors.hairline,
  boxShadow: elevation.float,
});

/**
 * A pressable under the pointer (`hoverStyle`): a whisper of the foreground over its surface, quieter than pressed and
 * than selected. Leave it off a disabled control and off a selected one, whose own fill shows.
 */
export const hovered = (): ViewStyle => ({ backgroundColor: colors.hover });

/**
 * The keyboard focus (`focusStyle`): the edge turns `focus` and a halo of `focusHalo` lies around the view: on its
 * edge (`inset`, rows that fill their column), just outside (`edge`, small controls) or clear of it (`out`, buttons).
 */
export const focusRing = (where: "inset" | "edge" | "out" = "inset"): ViewStyle => ({
  borderColor: colors.focus,
  outlineStyle: "solid",
  outlineWidth: gen.stroke.focus,
  outlineColor: colors.focusHalo,
  outlineOffset: where === "inset" ? 0 : where === "edge" ? gen.stroke.edge : gen.stroke.underline,
});

/** The `hitSlop` that grows a `box`-sized pressable to the density's smallest hit target (44 on touch). */
export const slop = (box: number) => Math.max(0, Math.ceil((size.hit - box) / 2));

/**
 * An animated value that springs to `target` each time it changes, natively: JS only starts each spring. A change
 * mid-way turns it from where it is, with its velocity; with reduced motion it lands at once.
 */
export function follow(target: () => number, spring: { stiffness: number; damping: number }): AnimatedValue {
  const v = createAnimatedValue(target());
  let shown = target();
  effect(() => {
    const next = target();
    if (next === shown) return;
    shown = next;
    if (reduceMotion()) v.set(next);
    else v.spring(next, spring);
  });
  return v;
}

/**
 * Moment 1 of the motion budget: pressing gives a little (`motion.press.scale`) and springs back. Spread `handlers`
 * on the pressable and add `style` to its style. Nothing moves under reduced motion.
 */
export function pressMotion() {
  const v = createAnimatedValue(1);
  const to = (x: number) => (reduceMotion() ? v.set(x) : void v.spring(x, gen.motion.press.spring));
  return {
    handlers: { onPressDown: () => to(gen.motion.press.scale), onPressUp: () => to(1) },
    style: { transform: [{ scale: v }] } satisfies ViewStyle,
  };
}

/** A tone of text, an icon or a tag: the foreground's strengths, the attention color, or a status. */
export type Tone = "default" | "muted" | "faint" | "attention" | "danger" | "ok" | "info";
const toneColor: Record<Tone, () => string> = {
  default: () => colors.fg,
  muted: () => colors.fg2,
  faint: () => colors.fg3,
  attention: () => colors.attention,
  danger: () => colors.danger,
  ok: () => colors.ok,
  info: () => colors.info,
};
const toneTint: Record<Tone, () => string> = {
  default: () => colors.selected,
  muted: () => colors.hover,
  faint: () => colors.hover,
  attention: () => colors.attentionTint,
  danger: () => colors.dangerTint,
  ok: () => colors.okTint,
  info: () => colors.infoTint,
};

/** A tone's color (`fg`) and its fill (`tint`) behind text of that color. Unknown names are muted. */
export function tone(t: Tone | undefined): { fg: string; tint: string } {
  const k = (t && t in toneColor ? t : "muted") as Tone;
  return { fg: toneColor[k](), tint: toneTint[k]() };
}

/** An agent's identity color, picked by its name (the same name, the same color, everywhere). */
export function identityOf(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return colors[gen.identities[h % gen.identities.length]];
}

/** The black appearance's theme: the dark theme with the generated black surfaces over it. */
export function blackTheme(): Theme {
  const t = base as unknown as Theme;
  return { ...t, cssVars: { ...t.cssVars, dark: { ...t.cssVars.dark, ...gen.blackTokens } } } as Theme;
}
