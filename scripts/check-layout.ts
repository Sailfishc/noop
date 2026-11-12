// Checks layouts that the UI tests can't see. nsh/test reads text and presses
// buttons but has no way to ask where a view is, so a board whose columns stack
// instead of standing side by side passes every test (#41). `nsh test --trace`
// prints every native view operation, frames included; this reads that trace,
// works out where each view with a testID sits (within its native pane: the
// sidebar and the channel each start at x 0), and applies the rules below.
//
//   cd app && nsh test screens.test.tsx --trace > ../.layout-trace.txt 2>&1
//   bun scripts/check-layout.ts .layout-trace.txt
//   bun scripts/check-layout.ts .layout-trace.txt --update   lower the hit-target baseline (never raises it; starts one if missing)
//
// Add a rule when a layout matters and a test can't say it.
//
// Hit targets on phones: in every app opened at phone width (the touch density), each pressable (a button, tab,
// switch, radio, combobox, menu item, link or checkbox) takes presses over at least 44 × 44 points, its frame plus its
// hitSlop. app/ui's components get there through `slop()`; pages' own pressables that don't yet are listed by testID in
// scripts/hit-baseline.json (the debt from before the rule), which may only shrink. A pressable without a testID is
// app/ui's and has no allowance.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Box = { x: number; y: number; w: number; h: number };
type Rule = { name: string; check: (ids: Map<string, Box>) => string | null };

/** Views whose testID matches `pattern`, in screen order of their first appearance. */
const matching = (ids: Map<string, Box>, pattern: RegExp) => [...ids].filter(([id]) => pattern.test(id));

export const RULES: Rule[] = [
  {
    // Board columns stand side by side: one row, left to right.
    name: "task board columns are in one row",
    check: (ids) => {
      const cols = matching(ids, /^tasks-col-[a-z_]+$/);
      if (cols.length < 2) return null;
      for (let i = 1; i < cols.length; i++) {
        const [pa, a] = cols[i - 1], [pb, b] = cols[i];
        if (Math.abs(a.y - b.y) > 1 || b.x < a.x + a.w - 1)
          return `${pb} (x ${b.x}, y ${b.y}) is not to the right of ${pa} (x ${a.x}, y ${a.y}, w ${a.w})`;
      }
      return null;
    },
  },
];

/** Rules across every pane of the trace: each testID where it first appears. */
export const ACROSS: Rule[] = [
  {
    // The columns' bottoms line up: the sidebar footer's top line is level with
    // the top of the empty channel and thread composer boxes. The sidebar and the
    // channel are separate panes in the trace, so this runs over all of them at
    // once (every screen in screens.test.tsx has the same window size).
    name: "sidebar footer and composers line up",
    check: (ids) => {
      const foot = ids.get("side-footer");
      if (!foot) return null;
      for (const [id, b] of matching(ids, /^(team|thread)-composer-box$/))
        if (Math.abs(b.y - foot.y) > 1 || Math.abs(b.y + b.h - (foot.y + foot.h - 10)) > 1)
          return `${id} (y ${b.y}, h ${b.h}) is not level with side-footer (y ${foot.y}, h ${foot.h})`;
      return null;
    },
  },
];

/** The smallest hit target on touch screens, in points (app/design/tokens.ts, `hit`). */
const HIT = 44;
/** Apps no wider than this are phones. */
const PHONE_WIDTH = 500;
const PRESSABLE = /^(Button|Tab|Switch|Radio|Combobox|Menuitem|Link|Checkbox)$/;

type App = { name: string; ids: Map<string, Box>; width: number; small: { id: string; w: number; h: number }[] };

/** Every app the trace opened: its views with a testID and where they sit in the window, its width, and its
 * pressables smaller than a hit target (frame plus hitSlop). */
export function parse(trace: string): App[] {
  const apps: App[] = [];
  let parent = new Map<number, number>(), frame = new Map<number, Box>(), tid = new Map<number, string>();
  let press = new Map<number, { role: string; slop: number[] }>();
  let name = "";
  let carried = 0;
  const finish = () => {
    if (!name) return;
    const abs = (id: number): Box | null => {
      const f = frame.get(id);
      if (!f) return null;
      let x = f.x, y = f.y;
      for (let p = parent.get(id), n = 0; p !== undefined && n < 1000; p = parent.get(p), n++) {
        const pf = frame.get(p);
        if (pf) { x += pf.x; y += pf.y; }
      }
      return { x, y, w: f.w, h: f.h };
    };
    const ids = new Map<string, Box>();
    for (const [id, t] of [...tid].sort((a, b) => a[0] - b[0])) {
      const b = abs(id);
      if (b && !ids.has(t)) ids.set(t, b);
    }
    // a test's later batches (after a press, a right click) only lay out what changed: the window's width is the
    // widest frame since the test began
    let width = carried;
    for (const f of frame.values()) width = Math.max(width, f.w);
    carried = width;
    const small: App["small"] = [];
    for (const [id, p] of press) {
      const f = frame.get(id);
      if (!f || !f.w || !f.h || !PRESSABLE.test(p.role)) continue;
      const w = f.w + p.slop[1] + p.slop[3], h = f.h + p.slop[0] + p.slop[2];
      if (w < HIT - 0.5 || h < HIT - 0.5) small.push({ id: tid.get(id) ?? `${p.role} (no testID: app/ui's)`, w, h });
    }
    apps.push({ name, ids, width, small });
  };
  for (const line of trace.split("\n")) {
    let m: RegExpMatchArray | null;
    if (/^[✓✗] .* › /.test(line)) { finish(); name = ""; carried = 0; continue; } // a test ended: the next opens its own window
    if ((m = line.match(/── open\(([^)]*)\)/))) {
      finish();
      name = m[1];
      parent = new Map(); frame = new Map(); tid = new Map(); press = new Map();
    } else if ((m = line.match(/Insert \{ parent: (\d+), child: (\d+)/))) {
      parent.set(+m[2], +m[1]);
    } else if ((m = line.match(/(?:Remove \{ parent: \d+, child: |Delete \{ id: )(\d+)/))) {
      parent.delete(+m[1]);
      if (line.includes("Delete")) { frame.delete(+m[1]); tid.delete(+m[1]); press.delete(+m[1]); }
    } else if ((m = line.match(/Frame \{ id: (\d+), x: (-?[\d.]+), y: (-?[\d.]+), w: ([\d.]+), h: ([\d.]+)/))) {
      frame.set(+m[1], { x: +m[2], y: +m[3], w: +m[4], h: +m[5] });
    } else if ((m = line.match(/ViewProps \{ id: (\d+),/))) {
      const id = +m[1];
      const t = line.match(/test_id: Some\("([^"]*)"\)/);
      if (t) tid.set(id, t[1]);
      const s = line.match(/hit_slop: Edges \{ top: ([\d.]+)pt, right: ([\d.]+)pt, bottom: ([\d.]+)pt, left: ([\d.]+)pt/);
      const r = line.match(/\brole: (\w+)/);
      if (s && r) press.set(id, { role: r[1], slop: [+s[1], +s[2], +s[3], +s[4]] });
    }
  }
  finish();
  return apps;
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) { console.error("usage: bun scripts/check-layout.ts <trace file>"); process.exit(2); }
  const apps = parse(readFileSync(file, "utf8"));
  const seen = apps.reduce((n, a) => n + a.ids.size, 0);
  // A trace with no testIDs means its format changed, not that all is well.
  if (!apps.length || !seen) { console.error(`check-layout: found ${apps.length} apps and ${seen} views with a testID in ${file}; has the --trace format changed?`); process.exit(2); }
  let failed = 0;
  for (const app of apps)
    for (const rule of RULES) {
      const err = rule.check(app.ids);
      if (err) { failed++; console.error(`✗ ${rule.name}: ${err}`); }
    }
  const all = new Map<string, Box>();
  for (const app of apps) for (const [id, b] of app.ids) if (!all.has(id)) all.set(id, b);
  for (const rule of ACROSS) {
    const err = rule.check(all);
    if (err) { failed++; console.error(`✗ ${rule.name}: ${err}`); }
  }
  // hit targets on phones, against the pages' baseline
  const BASE = join(import.meta.dir, "hit-baseline.json");
  let allowed: string[] = [];
  let started = true;
  try { allowed = JSON.parse(readFileSync(BASE, "utf8")).allowed; } catch { started = false; /* none yet: --update starts one */ }
  const small = new Map<string, string>();
  for (const app of apps.filter((a) => a.width && a.width <= PHONE_WIDTH))
    for (const s of app.small) if (!small.has(s.id)) small.set(s.id, `${s.id} (${s.w} × ${s.h}, in ${app.name})`);
  const over = [...small.keys()].filter((id) => !allowed.includes(id));
  const fixed = allowed.filter((id) => !small.has(id));
  if (process.argv.includes("--update")) {
    const keep = (started ? allowed.filter((id) => small.has(id)) : [...small.keys()]).sort();
    writeFileSync(BASE, JSON.stringify({ $comment: "Pages' pressables smaller than 44 x 44 on phones, from before the rule: this list only shrinks (scripts/check-layout.ts --update).", allowed: keep }, null, 2) + "\n");
    console.log(`check-layout: hit baseline written (${keep.length})`);
  } else {
    for (const id of over) { failed++; console.error(`✗ hit target under ${HIT} × ${HIT} on a phone: ${small.get(id)} (use app/ui's components, or give it hitSlop through slop())`); }
    if (fixed.length) { failed++; console.error(`✗ fewer small hit targets than scripts/hit-baseline.json lists, good: lock it in with --update (${fixed.join(", ")})`); }
  }
  console.log(`check-layout: ${apps.length} apps, ${seen} views with a testID, ${RULES.length + ACROSS.length + 1} rules, ${small.size} small hit targets on phones (${allowed.length} allowed), ${failed} failures`);
  process.exit(failed ? 1 : 0);
}
