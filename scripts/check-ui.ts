// Keeps the client's look in one place. Pages (app/team/, app/App.tsx) lay out components of app/ui and add logic;
// how things look (font sizes, radii, colors, pressables, the nsh/base behaviors) is decided in app/ui only
// (AGENTS.md, "Client components"). This counts what pages still do themselves, per file and per rule, and
// compares it with scripts/ui-baseline.json, the debt from before the rule:
//
// - a count above its baseline fails: new code must use app/ui (add what's missing to app/ui first);
// - a count below its baseline also fails, until the baseline is lowered with `--update`: the debt only goes down.
//
//   bun scripts/check-ui.ts             check
//   bun scripts/check-ui.ts --update    lower the baseline to the counts now (never raises it; starts one if missing)
//
// It reads text, not syntax: comments are skipped, everything else counts.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BASELINE = join(ROOT, "scripts/ui-baseline.json");

/** Spacing steps on the scale (Tailwind's 0.5, 1, 1.5, 2, 3, 4, 6), and 0. */
const STEPS = new Set([0, 2, 4, 6, 8, 12, 16, 24]);
const SPACING = /\b(gap|rowGap|columnGap|padding|paddingHorizontal|paddingVertical|paddingTop|paddingBottom|paddingLeft|paddingRight|margin|marginHorizontal|marginVertical|marginTop|marginBottom|marginLeft|marginRight)\s*:\s*(-?\d+(?:\.\d+)?)\b/g;

export type Rule = { id: string; what: string; count: (line: string) => number };

const matches = (re: RegExp) => (line: string) => line.match(re)?.length ?? 0;

export const RULES: Rule[] = [
  { id: "nsh-base", what: "imports nsh/base (wrap it in app/ui)", count: matches(/from\s+"nsh\/base"/g) },
  { id: "font-size", what: "sets a font size (use app/ui's text and controls)", count: matches(/\bfontSize\s*:|\btext-\[\d/g) },
  { id: "radius", what: "sets a corner radius (use app/ui's surfaces and controls)", count: matches(/\bborder(?:TopLeft|TopRight|BottomLeft|BottomRight)?Radius\s*:|\brounded(?:-[a-z]+)?(?:-\[|\b)/g) },
  { id: "color", what: "writes a color value (add a role to app/theme.json)", count: matches(/["'`]#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g) },
  {
    id: "spacing",
    what: "uses a spacing off the scale 2, 4, 6, 8, 12, 16, 24",
    count: (line) => [...line.matchAll(SPACING)].filter((m) => !STEPS.has(Math.abs(Number(m[2])))).length,
  },
  { id: "pressable", what: "builds a pressable from a View (use Btn, IconBtn, a row or a menu of app/ui)", count: matches(/\brole="(?:button|radio|tab|checkbox|switch|link)"/g) },
];

/** The counts of one file's source, by rule (comments skipped). */
export function count(src: string): Record<string, number> {
  const out: Record<string, number> = {};
  let block = false;
  for (const raw of src.split("\n")) {
    let line = raw;
    if (block) {
      const end = line.indexOf("*/");
      if (end < 0) continue;
      line = line.slice(end + 2);
      block = false;
    }
    line = line.replace(/\/\*.*?\*\//g, "");
    const open = line.indexOf("/*");
    if (open >= 0) {
      line = line.slice(0, open);
      block = true;
    }
    line = line.replace(/(^|[^:"'`])\/\/.*$/, "$1");
    for (const r of RULES) {
      const n = r.count(line);
      if (n) out[r.id] = (out[r.id] ?? 0) + n;
    }
  }
  return out;
}

/** Files that define the theme rather than draw with it: their colors are data. */
const THEME_FILES = new Set(["appearance.ts"]);

/** The files pages are made of. */
function pages(): string[] {
  const team = join(ROOT, "app/team");
  const files = readdirSync(team, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !THEME_FILES.has(f))
    .map((f) => join(team, f));
  return [join(ROOT, "app/App.tsx"), ...files].sort();
}

type Counts = Record<string, Record<string, number>>;

function measure(): Counts {
  const out: Counts = {};
  for (const f of pages()) {
    const c = count(readFileSync(f, "utf8"));
    if (Object.keys(c).length) out[relative(ROOT, f)] = c;
  }
  return out;
}

if (import.meta.main) {
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
    console.log("\ncheck-ui: pages must not add their own look; use or extend app/ui (AGENTS.md, \"Client components\"):");
    for (const o of over) console.log(`  ${o}`);
  }
  if (under.length && !update) {
    console.log("\ncheck-ui: less debt than the baseline, good: lock it in with `bun scripts/check-ui.ts --update`:");
    for (const u of under) console.log(`  ${u}`);
  }
  process.exit(over.length || (under.length && !update) ? 1 : 0);
}
