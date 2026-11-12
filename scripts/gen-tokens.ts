// Generates Remi's semantic tokens from the one hand-written source, app/design/tokens.ts:
//
//   app/theme.json         the semantic colors, light and dark, as NSH's theme file (`token()`, classes), plus the
//                          shadcn names nsh/base and Tailwind's classes know, as aliases of the semantic roles;
//   app/ui/tokens.gen.ts   the same roles typed for TS (getters over `token()`, so they follow the appearance), the
//                          size scales of both densities, spacing, radii, strokes, motion, elevation, the black
//                          appearance and the contrast report.
//
// It also checks contrast: primary and secondary text on every surface at least 4.5:1, tertiary text and colored
// marks at least 3:1, in light, dark and black. A miss fails the run.
//
//   bun scripts/gen-tokens.ts           write both files
//   bun scripts/gen-tokens.ts --check   fail if regenerating would change either file (CI: no hand edits), or contrast misses
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as src from "../app/design/tokens";

const ROOT = join(import.meta.dir, "..");
const THEME = join(ROOT, "app/theme.json");
const GEN = join(ROOT, "app/ui/tokens.gen.ts");

// ---- color math: OKLCH → sRGB (Björn Ottosson's OKLab), gamut mapped by lowering chroma -----------------------------

type RGB = [number, number, number];

function oklabToLinear(L: number, a: number, b: number): RGB {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (c: RGB) => c.every((x) => x >= -1e-4 && x <= 1 + 1e-4);

/** OKLCH to linear sRGB, lowering chroma until it fits. */
function oklch(l: number, c: number, h: number): RGB {
  const rad = (h * Math.PI) / 180;
  let lo = 0, hi = c;
  let rgb = oklabToLinear(l, c * Math.cos(rad), c * Math.sin(rad));
  if (inGamut(rgb)) return rgb.map(clamp01) as RGB;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    rgb = oklabToLinear(l, mid * Math.cos(rad), mid * Math.sin(rad));
    if (inGamut(rgb)) lo = mid;
    else hi = mid;
  }
  return oklabToLinear(l, lo * Math.cos(rad), lo * Math.sin(rad)).map(clamp01) as RGB;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const toSrgb = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const byte = (x: number) => Math.round(clamp01(toSrgb(x)) * 255);
const hex = (c: RGB) => "#" + c.map((x) => byte(x).toString(16).padStart(2, "0")).join("");
const rgba = (c: RGB, a: number) => `rgba(${c.map(byte).join(",")},${+a.toFixed(3)})`;

/** A color as the generator carries it: linear sRGB and an opacity. */
type Color = { rgb: RGB; a: number };
const solid = (rgb: RGB): Color => ({ rgb, a: 1 });
const write = (c: Color) => (c.a >= 1 ? hex(c.rgb) : rgba(c.rgb, c.a));
const BLACK: RGB = [0, 0, 0];
const WHITE: RGB = [1, 1, 1];

/** Relative luminance (WCAG) of a linear sRGB color, from its 8-bit sRGB values as browsers draw it. */
function luminance(c: RGB) {
  const lin = (b: number) => {
    const s = b / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = c.map(byte).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** `top` over the opaque `bottom`, blended in gamma-encoded sRGB as the platforms and browsers draw it. */
const fromSrgb = (s: number) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
const over = (top: Color, bottom: RGB): RGB =>
  top.rgb.map((x, i) => fromSrgb(toSrgb(x) * top.a + toSrgb(bottom[i]) * (1 - top.a))) as RGB;

function ratio(fg: Color, bg: RGB) {
  const a = luminance(over(fg, bg)), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// ---- the roles -----------------------------------------------------------------------------------------------------

type Mode = "light" | "dark" | "black";

/** The semantic roles, in the order they are listed: TS name → what it is for (the generated file's doc comments). */
const ROLES: Record<string, string> = {
  sidebar: "The sidebar: the darkest surface level, beside the page.",
  page: "The page: the surface level content sits on.",
  raised: "What stands on the page: a card, a panel, a plain button.",
  sunken: "A well inside a raised surface: code, an inset.",
  field: "An input's well.",
  float: "A floating surface (menu, popover, dialog, command palette): translucent where blur is drawn.",
  floatSolid: "A floating surface where the platform draws no blur (Linux): opaque.",
  fg: "Text and icons, full strength.",
  fg2: "Secondary text: the same foreground, weaker.",
  fg3: "Tertiary text: placeholders, meta, empty states.",
  hover: "A pressable under the pointer.",
  selected: "A selected row, tab or choice; a picked card.",
  pressed: "A pressable held down.",
  hairline: "The 0.5 line between regions; the only line inside a page.",
  edge: "An input's or a plain control's edge.",
  track: "A switch's track when off.",
  knob: "A switch's knob.",
  focus: "The keyboard focus ring's edge.",
  focusHalo: "The halo around the focused control.",
  primary: "The one main action's fill: black on light, white on dark.",
  onPrimary: "Text on `primary`.",
  attention: "Amber: something waits on you (align, decide, accept; their counts). Nothing else.",
  attentionTint: "Amber's fill behind a waiting card or count.",
  onAttention: "Text on `attention`.",
  danger: "Something failed, is stuck, or removes data.",
  dangerTint: "Danger's fill behind its text.",
  ok: "Done, confirmed, on.",
  okTint: "Ok's fill behind its text.",
  info: "A neutral notice.",
  infoTint: "Info's fill behind its text.",
  link: "A link in text.",
  scrim: "The dimmed layer behind a dialog.",
  onIdentity: "The letter on an agent's identity color.",
};

const kebab = (s: string) => s.replace(/([a-z])([A-Z0-9])/g, "$1-$2").toLowerCase();

function palette(mode: Mode): Record<string, Color> {
  const { base, attention, contrast } = src.input;
  const step = src.ladder[mode];
  const look = mode === "light" ? "light" : "dark";
  const warm = base.c[look];
  const at = (l: number) => oklch(l, warm, base.h);
  // surface levels spread around the page by the contrast
  const lv = (k: keyof typeof step) => step.page + (step[k] - step.page) * contrast;
  const fgL = step.fg;
  const fg = solid(oklch(fgL, base.fg[look], base.h));
  const s = src.strength;
  const of = (a: number) => ({ rgb: fg.rgb, a: Math.min(1, a * contrast) });
  const markL = src.markLightness[look];
  const mark = (h: number, c: number) => solid(oklch(markL, c, h));
  const tint = (c: Color) => ({ rgb: c.rgb, a: src.tintAlpha[look] });
  const floatRgb = at(lv("float"));
  const amber = solid(oklch(markL, attention.c, attention.h));
  const out: Record<string, Color> = {
    sidebar: solid(at(lv("sidebar"))),
    page: solid(at(step.page)),
    raised: solid(at(lv("raised"))),
    sunken: solid(at(lv("sunken"))),
    field: solid(at(lv("field"))),
    float: { rgb: floatRgb, a: src.glass.opacity[look] },
    floatSolid: solid(floatRgb),
    fg,
    fg2: of(s.fg2),
    fg3: of(s.fg3),
    hover: of(s.hover),
    selected: of(s.selected),
    pressed: of(s.pressed),
    hairline: of(s.hairline),
    edge: of(s.edge),
    track: of(s.track),
    knob: solid(look === "light" ? WHITE : oklch(0.98, warm, base.h)),
    focus: of(s.focus),
    focusHalo: of(s.focusHalo),
    primary: solid(fg.rgb),
    onPrimary: solid(at(look === "light" ? 1 : step.page)),
    attention: amber,
    attentionTint: tint(amber),
    onAttention: solid(look === "light" ? WHITE : oklch(0.2, warm, base.h)),
    danger: mark(src.status.danger.h, src.status.danger.c),
    ok: mark(src.status.ok.h, src.status.ok.c),
    info: mark(src.status.info.h, src.status.info.c),
    link: mark(src.status.info.h, src.status.info.c),
    scrim: { rgb: BLACK, a: src.scrim[look] },
    onIdentity: solid(look === "light" ? WHITE : oklch(0.2, warm, base.h)),
  };
  out.dangerTint = tint(out.danger);
  out.okTint = tint(out.ok);
  out.infoTint = tint(out.info);
  src.identity.forEach((h, i) => (out[`identity${i + 1}`] = mark(h, src.status.info.c)));
  return out;
}

/** shadcn's names, which nsh/base and Tailwind's classes know, as the semantic role each one is. */
const ALIASES: Record<string, string> = {
  background: "page",
  foreground: "fg",
  card: "raised",
  "card-foreground": "fg",
  popover: "floatSolid",
  "popover-foreground": "fg",
  "primary-foreground": "onPrimary",
  secondary: "raised",
  "secondary-foreground": "fg",
  muted: "sunken",
  "muted-foreground": "fg2",
  accent: "selected",
  "accent-foreground": "fg",
  destructive: "danger",
  border: "hairline",
  input: "edge",
  ring: "focus",
  "sidebar-foreground": "fg",
  "sidebar-primary": "primary",
  "sidebar-primary-foreground": "onPrimary",
  "sidebar-accent": "selected",
  "sidebar-accent-foreground": "fg",
  "sidebar-border": "hairline",
  "sidebar-ring": "focus",
  "scrollbar-thumb": "fg3",
  "scrollbar-thumb-hover": "fg2",
};

// ---- contrast ------------------------------------------------------------------------------------------------------

type Check = { mode: Mode; fg: string; on: string; ratio: number; min: number };

function contrast(mode: Mode, p: Record<string, Color>): Check[] {
  const surfaces = ["sidebar", "page", "raised", "sunken", "field", "floatSolid"];
  const out: Check[] = [];
  const add = (fg: string, on: string, min: number, bg = p[on].rgb) => out.push({ mode, fg, on, ratio: +ratio(p[fg], bg).toFixed(2), min });
  for (const s of surfaces) {
    add("fg", s, src.minContrast.text);
    add("fg2", s, src.minContrast.text);
    add("fg3", s, src.minContrast.mark);
    for (const m of ["attention", "danger", "ok", "info", "link"]) add(m, s, src.minContrast.mark);
  }
  add("onPrimary", "primary", src.minContrast.text);
  add("onAttention", "attention", src.minContrast.text);
  // colored text on its own tint, over a raised surface
  for (const m of ["attention", "danger", "ok", "info"]) add(m, `${m}Tint`, src.minContrast.mark, over(p[`${m}Tint`], p.raised.rgb));
  src.identity.forEach((_, i) => add("onIdentity", `identity${i + 1}`, src.minContrast.mark));
  return out;
}

// ---- output --------------------------------------------------------------------------------------------------------

const HEADER = "GENERATED by scripts/gen-tokens.ts from app/design/tokens.ts. Do not edit: change the source and run `bun scripts/gen-tokens.ts`.";

const shadow = (layers: readonly src.Shadow[]) =>
  layers.map((s) => `0 ${s.y}px ${s.blur}px ${s.spread ?? 0}px ${rgba(BLACK, s.alpha)}`).join(", ");

function pick<T extends Record<string, readonly [number, number]>>(o: T, i: 0 | 1) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v[i]])) as { [K in keyof T]: number };
}

function densities() {
  const one = (i: 0 | 1) => ({
    text: pick(src.text, i),
    leading: pick(src.leading, i),
    control: pick(src.control, i),
    row: pick(src.row, i),
    hit: src.hit[i],
    iconButton: pick(src.iconButton, i),
    icon: pick(src.icon, i),
    avatar: pick(src.avatar, i),
    switch: pick(src.switchSize, i),
    mark: pick(src.mark, i),
    chrome: pick(src.chrome, i),
  });
  return { pointer: one(0), touch: one(1) };
}

export function generate() {
  const modes: Mode[] = ["light", "dark", "black"];
  const pals = Object.fromEntries(modes.map((m) => [m, palette(m)])) as Record<Mode, Record<string, Color>>;
  const names = Object.keys(pals.light);
  const roleDoc = (k: string) => ROLES[k] ?? `An agent's identity color (${k.slice(8)} of ${src.identity.length}), picked by its name.`;

  // theme.json
  const cssVars = (m: Mode) => {
    const o: Record<string, string> = {};
    for (const k of names) o[kebab(k)] = write(pals[m][k]);
    for (const [a, k] of Object.entries(ALIASES)) o[a] = write(pals[m][k]);
    return o;
  };
  const theme = {
    $comment: HEADER,
    name: "Remi",
    cssVars: { theme: { radius: `${src.radius.md}px` }, light: cssVars("light"), dark: cssVars("dark") },
  };
  const themeText = JSON.stringify(theme, null, 2) + "\n";

  // contrast
  const checks = modes.flatMap((m) => contrast(m, pals[m]));
  const misses = checks.filter((c) => c.ratio < c.min);

  // black: the dark theme's values that differ
  const dark = cssVars("dark"), black = cssVars("black");
  const blackDiff = Object.fromEntries(Object.entries(black).filter(([k, v]) => dark[k] !== v));

  const J = (v: unknown) => JSON.stringify(v);
  const lines: string[] = [];
  lines.push(`// ${HEADER}`);
  lines.push("// The semantic tokens of Remi's design system. Only app/ui reads this file; pages use app/ui's components.");
  lines.push('import { token } from "nsh";');
  lines.push("");
  lines.push("/** The semantic colors: each getter reads the theme's token, so reading it in JSX follows the appearance. */");
  lines.push("export const colors = {");
  for (const k of names) {
    lines.push(`  /** ${roleDoc(k)} */`);
    lines.push(`  get ${k}() { return token(${J(kebab(k))}); },`);
  }
  lines.push("};");
  lines.push("");
  lines.push("/** A semantic color's name. */");
  lines.push("export type ColorRole = keyof typeof colors;");
  lines.push("");
  lines.push("/** The agents' identity colors, in order. */");
  lines.push(`export const identities: ColorRole[] = ${J(src.identity.map((_, i) => `identity${i + 1}`))};`);
  lines.push("");
  lines.push("/** Each role's theme name and its values, for the tokens page. */");
  lines.push(`export const colorTable: { role: ColorRole; name: string; light: string; dark: string; black: string }[] = ${J(
    names.map((k) => ({ role: k, name: kebab(k), light: write(pals.light[k]), dark: write(pals.dark[k]), black: write(pals.black[k]) })),
  )};`);
  lines.push("");
  lines.push("/** The black appearance: the dark theme's tokens that differ, laid over it. */");
  lines.push(`export const blackTokens: Record<string, string> = ${J(blackDiff)};`);
  lines.push("");
  lines.push("/** The sizes of both densities: `pointer` (desktops) and `touch` (phones, pads). app/ui picks one by device. */");
  lines.push(`export const densities = ${J(densities())} as const;`);
  lines.push("");
  lines.push("/** Spacing steps. */");
  lines.push(`export const space = ${J(src.space)} as const;`);
  lines.push("/** Corner radii. */");
  lines.push(`export const radius = ${J(src.radius)} as const;`);
  lines.push("/** Line widths. */");
  lines.push(`export const stroke = ${J(src.stroke)} as const;`);
  lines.push("/** Whole-view opacities. */");
  lines.push(`export const opacity = ${J(src.opacity)} as const;`);
  lines.push("/** The widest a few things get. */");
  lines.push(`export const measure = ${J(src.measure)} as const;`);
  lines.push("/** The six moments that move (and the spinner, and state fades). */");
  lines.push(`export const motion = ${J(src.motion)} as const;`);
  lines.push("/** Shadows, per appearance: floating surfaces and a switch's knob. */");
  lines.push(`export const elevation = ${J({
    light: { float: shadow(src.elevation.float.light), knob: shadow(src.elevation.knob.light) },
    dark: { float: shadow(src.elevation.float.dark), knob: shadow(src.elevation.knob.dark) },
  })} as const;`);
  lines.push("/** The blur behind glass. */");
  lines.push(`export const backdrop = ${J(`blur(${src.glass.blur}px)`)};`);
  lines.push("");
  lines.push("/** Contrast of each text and mark on each surface, per appearance, against its minimum (all pass, or this file isn't written). */");
  lines.push(`export const contrastTable: { mode: string; fg: string; on: string; ratio: number; min: number }[] = ${J(checks)};`);
  const genText = lines.join("\n") + "\n";
  return { themeText, genText, misses, checks };
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const { themeText, genText, misses, checks } = generate();
  if (misses.length) {
    console.log("gen-tokens: contrast too low (raise the input contrast or move the ladder in app/design/tokens.ts):");
    for (const m of misses) console.log(`  ${m.mode}: ${m.fg} on ${m.on} is ${m.ratio}:1, needs ${m.min}:1`);
    process.exit(1);
  }
  const low = [...checks].sort((a, b) => a.ratio / a.min - b.ratio / b.min)[0];
  console.log(`gen-tokens: contrast ok (${checks.length} pairs; closest: ${low.mode} ${low.fg} on ${low.on} ${low.ratio}:1, min ${low.min})`);
  const read = (f: string) => {
    try {
      return readFileSync(f, "utf8");
    } catch {
      return "";
    }
  };
  if (check) {
    const stale = [[THEME, themeText], [GEN, genText]].filter(([f, t]) => read(f) !== t).map(([f]) => f.slice(ROOT.length + 1));
    if (stale.length) {
      console.log(`gen-tokens: ${stale.join(", ")} differ from what app/design/tokens.ts generates.`);
      console.log("  They are generated: change app/design/tokens.ts and run `bun scripts/gen-tokens.ts`, never edit them by hand.");
      process.exit(1);
    }
    console.log("gen-tokens: generated files are up to date");
  } else {
    writeFileSync(THEME, themeText);
    writeFileSync(GEN, genText);
    console.log("gen-tokens: wrote app/theme.json and app/ui/tokens.gen.ts");
  }
}
