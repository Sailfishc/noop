// Keeps the client's look in one place: the design system's tiers (AGENTS.md, "Client components"; app/ui/README.md).
//
//   app/design/tokens.ts (the one source) → app/theme.json + app/ui/tokens.gen.ts (generated) → app/ui (components)
//   → app/team, app/App.tsx (pages)
//
// Three checks, all deterministic:
//
// 1. Components (app/ui) hold NO raw values: no color literals, font sizes, line heights, radii, control sizes,
//    off-token spacing, line widths, opacities, durations, spring parameters or shadow strings, and no density
//    decisions outside theme.ts. Everything comes from the generated tokens. Baseline zero, no debt. A few data files
//    are exempt by name (DATA_FILES below, each with its reason).
// 2. Pages (app/team, app/App.tsx) don't style themselves: what they still do is counted per file and compared with
//    scripts/ui-baseline.json, the debt from before the rule. A count above its baseline fails (use or extend
//    app/ui); a count below fails until the baseline is lowered with `--update`: the debt only goes down. Pages never
//    read tokens (`token()`, tokens.gen, app/design) nor the platform's idiom for their look.
// 3. Every token of app/design/tokens.ts is used somewhere: a token nobody reads fails (delete it, or use it). A
//    token that doesn't exist fails the type check (`nsh check app`), since every read goes through typed objects.
//
//   bun scripts/check-ui.ts             check
//   bun scripts/check-ui.ts --update    lower the pages' baseline to the counts now (never raises it)
//
// It reads text, not syntax: comments are skipped, everything else counts.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as src from "../app/design/tokens";

const ROOT = join(import.meta.dir, "..");
const BASELINE = join(ROOT, "scripts/ui-baseline.json");

/** Spacing steps on the scale (Tailwind's 0.5, 1, 1.5, 2, 3, 4, 6), and 0. */
const STEPS = new Set(Object.values(src.space).concat(0));
const SPACING_PROPS = "gap|rowGap|columnGap|padding|paddingHorizontal|paddingVertical|paddingTop|paddingBottom|paddingLeft|paddingRight|margin|marginHorizontal|marginVertical|marginTop|marginBottom|marginLeft|marginRight";
const SPACING = new RegExp(`\\b(${SPACING_PROPS})\\s*:\\s*(-?\\d+(?:\\.\\d+)?)\\b`, "g");

export type Rule = { id: string; what: string; count: (line: string) => number };

const matches = (re: RegExp) => (line: string) => line.match(re)?.length ?? 0;

/** What pages may not do (counted against the baseline). */
export const RULES: Rule[] = [
  { id: "nsh-base", what: "imports nsh/base (wrap it in app/ui)", count: matches(/from\s+"nsh\/base"/g) },
  { id: "font-size", what: "sets a font size (use app/ui's text and controls)", count: matches(/\bfontSize\s*:|\btext-\[\d/g) },
  { id: "radius", what: "sets a corner radius (use app/ui's surfaces and controls)", count: matches(/\bborder(?:TopLeft|TopRight|BottomLeft|BottomRight)?Radius\s*:|\brounded(?:-[a-z]+)?(?:-\[|\b)/g) },
  { id: "color", what: "writes a color value (add a role to app/design/tokens.ts)", count: matches(/["'`]#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|color-mix)\(/g) },
  {
    id: "spacing",
    what: "uses a spacing off the scale 2, 4, 6, 8, 12, 16, 24",
    count: (line) => [...line.matchAll(SPACING)].filter((m) => !STEPS.has(Math.abs(Number(m[2])))).length,
  },
  { id: "pressable", what: "builds a pressable from a View (use Btn, IconBtn, a row or a menu of app/ui)", count: matches(/\brole="(?:button|radio|tab|checkbox|switch|link)"/g) },
  { id: "platform", what: "reads the platform's idiom for its look (density is decided in app/ui/theme.ts)", count: matches(/\bplatform\.(?:idiom|desktop)\b/g) },
  { id: "tokens", what: "reads design tokens directly (use app/ui's components)", count: matches(/\btoken\(|tokens\.gen\b|\/design\/tokens\b/g) },
];

const nonzero = (re: RegExp) => (line: string) => [...line.matchAll(re)].filter((m) => Number(m[1]) !== 0).length;

/** What components may not do at all (baseline zero). */
export const COMPONENT_RULES: Rule[] = [
  { id: "color", what: "a color literal (add a role to app/design/tokens.ts)", count: matches(/["'`]#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|color-mix)\(/g) },
  { id: "font-size", what: "a raw font size or line height (use size.text / size.leading)", count: matches(/\b(?:fontSize|lineHeight|letterSpacing)\s*:\s*-?\d|\btext-\[\d|\btext-(?:xs|sm|base|lg|xl|\dxl)\b/g) },
  { id: "radius", what: "a raw corner radius (use radius.*)", count: (l) => nonzero(/\bborder(?:TopLeft|TopRight|BottomLeft|BottomRight)?Radius\s*:\s*(\d+(?:\.\d+)?)/g)(l) + matches(/\brounded(?:-[a-z0-9]+)?\b/g)(l) },
  { id: "size", what: "a raw width, height or icon size (use size.*, measure.*)", count: (l) => nonzero(/\b(?:width|height|minWidth|minHeight|maxWidth|maxHeight|flexBasis)\s*:\s*(\d+(?:\.\d+)?)\b/g)(l) + nonzero(/\bsize=\{(\d+)/g)(l) },
  { id: "spacing", what: "a raw spacing (use space.*)", count: nonzero(new RegExp(`\\b(?:${SPACING_PROPS}|offset|margin|hitSlop)\\s*[:=]\\s*\\{?\\s*-?(\\d+(?:\\.\\d+)?)\\b`, "g")) },
  { id: "stroke", what: "a raw line width (use stroke.*)", count: nonzero(/\b(?:border(?:Top|Bottom|Left|Right)?Width|outlineWidth|outlineOffset)\s*:\s*(\d+(?:\.\d+)?)/g) },
  { id: "opacity", what: "a raw opacity (use opacity.*)", count: (l) => [...l.matchAll(/\bopacity\s*:\s*(\d*\.\d+)/g)].length },
  { id: "motion", what: "a raw duration, delay or spring (use motion.*)", count: (l) => nonzero(/\b(?:duration|transitionDuration|animationDuration|delay|transitionDelay)\s*:\s*(\d+)/g)(l) + matches(/\b(?:stiffness|damping)\s*:\s*\d/g)(l) + matches(/\bduration-\d|\bEasing\.bezier\(\s*\d/g)(l) },
  { id: "shadow", what: "a shadow or blur string (use elevation.*, backdrop)", count: matches(/\b(?:boxShadow|backdropFilter)\s*:\s*["'`]/g) },
];

/** Components that may decide the density: only the theme. */
const DENSITY = /\bplatform\.(?:idiom|desktop)\b/g;

/**
 * app/ui files exempt from the component rules, and why. They are data, not look: drawing paths, a QR code (always
 * black on white, as cameras read it), the camera page, a vendored decoder, and the scrollbar's class config (NSH's
 * Scrollbar.setTheme takes Tailwind classes only). The generated file is the tokens themselves.
 */
const DATA_FILES = new Set(["icons.tsx", "qr.ts", "qr-code.tsx", "qr-scanner.tsx", "qr-scanner-page.ts", "jsqr.ts", "scrollbar-theme.ts", "tokens.gen.ts"]);

/** Lines of `src` without comments. */
function code(src: string): string[] {
  const out: string[] = [];
  let block = false;
  for (const raw of src.split("\n")) {
    let line = raw;
    if (block) {
      const end = line.indexOf("*/");
      if (end < 0) {
        out.push("");
        continue;
      }
      line = line.slice(end + 2);
      block = false;
    }
    line = line.replace(/\/\*.*?\*\//g, "");
    const open = line.indexOf("/*");
    if (open >= 0) {
      line = line.slice(0, open);
      block = true;
    }
    out.push(line.replace(/(^|[^:"'`])\/\/.*$/, "$1"));
  }
  return out;
}

/** The counts of one file's source, by rule (comments skipped). */
export function count(src: string, rules = RULES): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of code(src)) {
    for (const r of rules) {
      const n = r.count(line);
      if (n) out[r.id] = (out[r.id] ?? 0) + n;
    }
  }
  return out;
}

const tsx = (dir: string) =>
  readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.startsWith(".nsh"))
    .map((f) => join(ROOT, dir, f));

/** The files pages are made of. */
const pages = () => [join(ROOT, "app/App.tsx"), ...tsx("app/team")].sort();
/** The component library's files. */
const components = () => tsx("app/ui").sort();

type Counts = Record<string, Record<string, number>>;

function measure(): Counts {
  const out: Counts = {};
  for (const f of pages()) {
    const c = count(readFileSync(f, "utf8"));
    if (Object.keys(c).length) out[relative(ROOT, f)] = c;
  }
  return out;
}

/** Each raw value in a component file, as `file:line: what`. */
export function componentFindings(): string[] {
  const out: string[] = [];
  for (const f of components()) {
    const name = relative(join(ROOT, "app/ui"), f);
    if (DATA_FILES.has(name)) continue;
    code(readFileSync(f, "utf8")).forEach((line, i) => {
      for (const r of COMPONENT_RULES) if (r.count(line)) out.push(`app/ui/${name}:${i + 1}: ${r.what}`);
      if (name !== "theme.ts" && DENSITY.test(line)) out.push(`app/ui/${name}:${i + 1}: decides the density (only theme.ts reads platform.idiom / platform.desktop; use \`touch\`)`);
      DENSITY.lastIndex = 0;
    });
  }
  return out;
}

/**
 * Tokens defined in app/design/tokens.ts that nothing reads. Each token is a path (`space.xs`, `size.control.sm`,
 * `colors.attention`); it counts as read where the client's code (app/, generated files left out) names it, or
 * indexes its group with a computed key (`size.text[v()]` reads every text step).
 */
export function unusedTokens(): string[] {
  const files = [...components(), ...pages()].filter((f) => !f.endsWith("tokens.gen.ts"));
  const all = files.map((f) => code(readFileSync(f, "utf8")).join("\n")).join("\n");
  const used = (group: string, key: string, theme?: string) =>
    new RegExp(`\\b${group}\\.${key}\\b`).test(all) ||
    new RegExp(`\\b${group}\\[(?!\\s*["'\`])`).test(all) ||
    (theme !== undefined && new RegExp(`[-:"'\`\\s]${theme}\\b`).test(all));
  const out: string[] = [];
  const check = (group: string, keys: string[], alias = group) => {
    for (const k of keys) if (!used(alias, k)) out.push(`${group}.${k}`);
  };
  // the density scales are read through `size`
  const DENSITY_GROUPS: Record<string, object> = {
    text: src.text, leading: src.leading, control: src.control, row: src.row, iconButton: src.iconButton, icon: src.icon,
    avatar: src.avatar, switch: src.switchSize, mark: src.mark, chrome: src.chrome,
  };
  for (const [g, o] of Object.entries(DENSITY_GROUPS)) check(`size.${g}`, Object.keys(o), `size\\.${g}`);
  if (!/\bsize\.hit\b|\bslop\(/.test(all)) out.push("size.hit");
  check("space", Object.keys(src.space));
  check("radius", Object.keys(src.radius));
  check("stroke", Object.keys(src.stroke));
  check("measure", Object.keys(src.measure));
  check("opacity", Object.keys(src.opacity));
  check("motion", Object.keys(src.motion));
  // colors: the generated roles, read as `colors.x` or as a class / token name (`bg-scrim`, `text-fg-3`)
  const gen = readFileSync(join(ROOT, "app/ui/tokens.gen.ts"), "utf8");
  const roles = [...gen.matchAll(/^ {2}get (\w+)\(\) \{ return token\("([\w-]+)"\); \},$/gm)].map((m) => [m[1], m[2]]);
  for (const [role, theme] of roles) {
    if (role.startsWith("identity")) continue; // read by index, through `identities`
    if (!used("colors", role, theme)) out.push(`colors.${role}`);
  }
  if (!/\bidentities\b|\bidentityOf\(/.test(all)) out.push("colors.identity*");
  return out;
}

if (import.meta.main) {
  let failed = false;

  // 1. components
  const raw = componentFindings();
  console.log(`check-ui: components (app/ui): ${raw.length} raw values`);
  if (raw.length) {
    failed = true;
    console.log("\ncheck-ui: app/ui reads every value from the tokens (app/design/tokens.ts → app/ui/tokens.gen.ts); found raw ones:");
    for (const r of raw) console.log(`  ${r}`);
  }

  // 2. pages
  const now = measure();
  let base: Counts | null = null;
  try {
    base = JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch {
    // no baseline yet: `--update` starts one from the counts now
  }
  const update = process.argv.includes("--update");
  const over: string[] = [];
  const under: string[] = [];
  const next: Counts = base ? {} : now;
  base ??= update ? now : {};
  for (const file of new Set([...Object.keys(now), ...Object.keys(base)])) {
    for (const r of RULES) {
      const n = now[file]?.[r.id] ?? 0;
      const b = base![file]?.[r.id] ?? 0;
      if (n > b) over.push(`${file}: ${n - b} more than allowed (${n}, baseline ${b}): ${r.what}`);
      if (n < b) under.push(`${file}: ${r.id} ${b} → ${n}`);
      const keep = Math.min(n, b);
      if (keep && next !== now) (next[file] ??= {})[r.id] = keep;
    }
  }
  const total = (c: Counts) => RULES.map((r) => `${r.id} ${Object.values(c).reduce((s, x) => s + (x[r.id] ?? 0), 0)}`).join(", ");
  console.log(`check-ui: pages now: ${total(now)}`);
  if (update) {
    writeFileSync(BASELINE, JSON.stringify(next, null, 2) + "\n");
    console.log(`check-ui: baseline written: ${total(next)}`);
  }
  if (over.length) {
    failed = true;
    console.log("\ncheck-ui: pages must not add their own look; use or extend app/ui (AGENTS.md, \"Client components\"):");
    for (const o of over) console.log(`  ${o}`);
  }
  if (under.length && !update) {
    failed = true;
    console.log("\ncheck-ui: less debt than the baseline, good: lock it in with `bun scripts/check-ui.ts --update`:");
    for (const u of under) console.log(`  ${u}`);
  }

  // 3. tokens nobody reads
  const unused = unusedTokens();
  console.log(`check-ui: tokens: ${unused.length} unused`);
  if (unused.length) {
    failed = true;
    console.log("\ncheck-ui: these tokens of app/design/tokens.ts are read nowhere: use them or delete them:");
    for (const u of unused) console.log(`  ${u}`);
  }
  process.exit(failed ? 1 : 0);
}
