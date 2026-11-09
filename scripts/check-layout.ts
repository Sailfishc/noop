// Checks layouts that the UI tests can't see. nsh/test reads text and presses
// buttons but has no way to ask where a view is, so a board whose columns stack
// instead of standing side by side passes every test (#41). `nsh test --trace`
// prints every native view operation, frames included; this reads that trace,
// works out where each view with a testID sits (within its native pane: the
// sidebar and the channel each start at x 0), and applies the rules below.
//
//   cd app && nsh test screens.test.tsx --trace > ../.layout-trace.txt 2>&1
//   bun scripts/check-layout.ts .layout-trace.txt
//
// Add a rule when a layout matters and a test can't say it.
import { readFileSync } from "node:fs";

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

/** Every app the trace opened: its views with a testID and where they sit in the window. */
export function parse(trace: string): { name: string; ids: Map<string, Box> }[] {
  const apps: { name: string; ids: Map<string, Box> }[] = [];
  let parent = new Map<number, number>(), frame = new Map<number, Box>(), tid = new Map<number, string>();
  let name = "";
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
    apps.push({ name, ids });
  };
  for (const line of trace.split("\n")) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/── open\(([^)]*)\)/))) {
      finish();
      name = m[1];
      parent = new Map(); frame = new Map(); tid = new Map();
    } else if ((m = line.match(/Insert \{ parent: (\d+), child: (\d+)/))) {
      parent.set(+m[2], +m[1]);
    } else if ((m = line.match(/(?:Remove \{ parent: \d+, child: |Delete \{ id: )(\d+)/))) {
      parent.delete(+m[1]);
      if (line.includes("Delete")) { frame.delete(+m[1]); tid.delete(+m[1]); }
    } else if ((m = line.match(/Frame \{ id: (\d+), x: (-?[\d.]+), y: (-?[\d.]+), w: ([\d.]+), h: ([\d.]+)/))) {
      frame.set(+m[1], { x: +m[2], y: +m[3], w: +m[4], h: +m[5] });
    } else if ((m = line.match(/ViewProps \{ id: (\d+),.*?test_id: Some\("([^"]*)"\)/))) {
      tid.set(+m[1], m[2]);
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
  console.log(`check-layout: ${apps.length} apps, ${seen} views with a testID, ${RULES.length + ACROSS.length} rules, ${failed} failures`);
  process.exit(failed ? 1 : 0);
}
