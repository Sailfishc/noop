// Remi's design tokens: the ONE hand-written source of every color, size and motion the client draws with.
//
// Nobody reads this file but scripts/gen-tokens.ts, which turns it into
//   - app/theme.json        the semantic colors, light and dark (NSH's theme file: classes and `token()`),
//   - app/ui/tokens.gen.ts  the same roles typed for TS, the size scales of both densities, motion, elevation.
// Both carry a "generated, do not edit" header, and CI regenerates them and fails on any difference
// (`bun scripts/gen-tokens.ts --check`), so the only way to change how Remi looks is a line here.
//
// Three tiers (AGENTS.md, "Client components"): this source → semantic tokens (generated) → components (app/ui).
// Pages (app/team) use components only.
//
// Colors come from three inputs, computed in OKLCH (perceptually even: a step of lightness looks like the same
// step at every hue): the warm gray base, the one attention color, and the contrast. Sizes come in two densities:
// `pointer` (a mouse and a keyboard: desktops) and `touch` (a finger: phones and pads); app/ui picks one by device,
// never by window width.

/** A color in OKLCH: lightness 0..1, chroma 0..~0.37, hue in degrees. */
export type Oklch = { l: number; c: number; h: number };

/** The three color inputs. */
export const input = {
  /** The warm gray every surface and text is made of: a hue toward yellow-red and a whisper of chroma. */
  base: { h: 75, c: 0.006 },
  /** The attention color, amber, taken from the logo's cup: the only accent, used for "waiting on you" only. */
  attention: { h: 66, c: 0.15 },
  /** How far apart the surface levels and the text strengths sit: 1 is the default; more is a high-contrast theme. */
  contrast: 1,
};

/**
 * Where the surface levels and the foreground sit on the lightness axis, per appearance. `sidebar` is the darkest
 * level, then `page`, then `raised` (what stands on the page); `float` is a menu, a popover, a dialog or the command
 * palette (glass where the platform draws blur). `sunken` is a well inside a raised surface (code, an inset),
 * `field` an input. The steps between them are multiplied by `input.contrast` around `page`.
 */
export const ladder = {
  light: { sidebar: 0.955, page: 0.985, raised: 1, sunken: 0.965, field: 1, float: 1, fg: 0.215 },
  dark: { sidebar: 0.175, page: 0.205, raised: 0.245, sunken: 0.185, field: 0.225, float: 0.265, fg: 0.935 },
  /** The black appearance (OLED, dark rooms): dark's foreground over darker surfaces. */
  black: { sidebar: 0, page: 0, raised: 0.17, sunken: 0.12, field: 0.15, float: 0.2, fg: 0.935 },
};

/**
 * The foreground's strengths: one text color at three opacities (primary text, secondary, tertiary), and the fills
 * made of it (a row under the pointer, a selected row, a pressed one, a hairline, an input's edge, the focus ring).
 */
export const strength = {
  fg2: 0.66,
  fg3: 0.5,
  hover: 0.05,
  selected: 0.08,
  pressed: 0.11,
  hairline: 0.1,
  edge: 0.2,
  track: 0.14,
  focus: 0.4,
  focusHalo: 0.12,
};

/** The status hues, at the attention color's chroma or near it. Danger and ok are words of state, not decoration. */
export const status = {
  danger: { h: 25, c: 0.17 },
  ok: { h: 155, c: 0.13 },
  info: { h: 255, c: 0.14 },
};

/** The lightness of a colored mark (attention, status, identity) as text or icon on each appearance's surfaces. */
export const markLightness = { light: 0.555, dark: 0.79 };

/** How strong a tint (a colored fill behind text of the same color) is, per appearance. */
export const tintAlpha = { light: 0.12, dark: 0.16 };

/**
 * Identity hues: an agent's avatar keeps a color of its own (the only colored thing that isn't a state), picked from
 * these by its name. None sits near amber (50 to 100): that hue means "waiting on you".
 */
export const identity = [20, 125, 160, 195, 230, 265, 300, 335];

/** The dimmed layer behind a dialog: black at these opacities. */
export const scrim = { light: 0.36, dark: 0.55 };

// ---- sizes ---------------------------------------------------------------------------------------------------
// [pointer, touch]. Text sizes follow the user's text size (fontScale) on their own; the boxes around text use these
// as minimum heights, so they grow with it.

/** Type: caption (a note, a time), body (most text), message (messages and inputs), title (a section), display (a page). */
export const text = {
  caption: [12, 13],
  body: [13, 15],
  message: [14, 16],
  title: [16, 17],
  display: [22, 28],
} as const;

/** Line heights of the type steps. */
export const leading = {
  caption: [17, 18],
  body: [19, 21],
  message: [20, 22],
  title: [22, 23],
  display: [28, 34],
} as const;

/** Control heights: buttons, inputs, choices. */
export const control = { sm: [30, 36], md: [40, 48] } as const;

/** Row heights: a list row, a row with a subtitle, a menu row. */
export const row = { sm: [32, 48], md: [44, 56], menu: [32, 44] } as const;

/** The smallest a pressable may be to the finger (44 on touch: Apple's and Android's guidance), reached with hitSlop. */
export const hit = [24, 44] as const;

/** Icon-only buttons. */
export const iconButton = { sm: [24, 36], md: [32, 44] } as const;

/** Icons: fewer, smaller, one color. */
export const icon = { sm: [14, 16], md: [16, 20] } as const;

/** Avatars. */
export const avatar = { sm: [22, 28], md: [32, 36], lg: [44, 48] } as const;

/** A switch's track (width, height) and knob. */
export const switchSize = { width: [28, 42], height: [16, 24], knob: [12, 20] } as const;

/** The window's chrome: the hidden title bar's height. */
export const chrome = { titleBar: [52, 56] } as const;

/** Small marks: a status dot, an ⓘ, a count pill, a tag. */
export const mark = { dot: [8, 8], info: [20, 24], count: [18, 20], tag: [20, 22], tab: [34, 44] } as const;

// ---- one scale for both densities ------------------------------------------------------------------------------

/** Spacing: Tailwind's steps 0.5, 1, 1.5, 2, 3, 4, 6 and nothing else. */
export const space = { xxs: 2, xs: 4, sm: 6, md: 8, lg: 12, xl: 16, xxl: 24 } as const;

/** Corner radii: small marks, controls, cards, floating surfaces; `full` a pill or a circle. */
export const radius = { sm: 6, md: 8, lg: 12, float: 14, full: 999 } as const;

/** Line widths: the 0.5 hairline, an input's edge, a selected underline, the focus halo. */
export const stroke = { hairline: 0.5, edge: 1, underline: 2, focus: 3 } as const;

/** Whole-view opacities: a disabled control, the primary button under the pointer. */
export const opacity = { disabled: 0.45, hoverPrimary: 0.9 } as const;

/** The widest a few things get. */
export const measure = { note: 320, toast: 360, menu: 200, menuWide: 240, list: 320, dialog: 640, code: 52 } as const;

// ---- motion: exactly six moments move, and all of them stand still under reduce motion ----------------------------

/** A spring, as stiffness and damping of a unit mass. */
export type Spring = { stiffness: number; damping: number };

export const motion = {
  /** 1. Pressing a button or a row: it gives a little and springs back. */
  press: { scale: 0.97, spring: { stiffness: 500, damping: 30 } },
  /** 2. The selection pill slides to the new tab, choice or sidebar row. */
  select: { spring: { stiffness: 420, damping: 28 } },
  /** 3. A menu, popover, dialog or the command palette comes in: up 6 and fading in; on phones a sheet rises. */
  float: { y: 6, duration: 180, easing: [0.16, 1, 0.3, 1] },
  /** 4. A handled item collapses and the next moves up (lists, the triage view). */
  collapse: { spring: { stiffness: 400, damping: 32 }, duration: 260 },
  /** 5. Accepting: the check mark draws in. */
  check: { spring: { stiffness: 300, damping: 20 } },
  /** 6. An agent at work: its dot breathes, slowly. The only motion that repeats. */
  breathe: { duration: 2400 },
  /** Not a moment of the six: a spinner turning while something loads. */
  progress: { duration: 800 },
  /** Not a moment either: how fast a color or an edge changes state (a switch's track, a focus ring). */
  fade: { duration: 150 },
} as const;

// ---- depth -------------------------------------------------------------------------------------------------------

/** One shadow layer: offset y, blur, spread, and black at `alpha`. */
export type Shadow = { y: number; blur: number; spread?: number; alpha: number };

/** Floating surfaces cast three faint layers; nothing else casts a shadow. Dark's are stronger to read on dark. */
export const elevation = {
  float: {
    light: [{ y: 0, blur: 1, alpha: 0.06 }, { y: 2, blur: 6, alpha: 0.06 }, { y: 12, blur: 32, spread: -6, alpha: 0.14 }],
    dark: [{ y: 0, blur: 1, alpha: 0.3 }, { y: 2, blur: 6, alpha: 0.25 }, { y: 16, blur: 36, spread: -8, alpha: 0.5 }],
  } satisfies Record<string, Shadow[]>,
  /** A switch's knob: one hairline drop. */
  knob: { light: [{ y: 1, blur: 2, alpha: 0.2 }], dark: [{ y: 1, blur: 2, alpha: 0.4 }] } satisfies Record<string, Shadow[]>,
};

/** Glass on floating surfaces only: how opaque the float color is and how much behind it blurs. */
export const glass = { opacity: { light: 0.8, dark: 0.78 }, blur: 20 };

/**
 * Minimum contrast (WCAG 2.x ratios) the generator enforces, light, dark and black: primary and secondary text on
 * every surface, tertiary text and colored marks (attention, status) at least large-text / non-text contrast.
 */
export const minContrast = { text: 4.5, mark: 3 };
