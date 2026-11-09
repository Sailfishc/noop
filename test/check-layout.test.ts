import { expect, test } from "bun:test";
import { parse, RULES } from "../scripts/check-layout";

const trace = (cols: [number, number][]) => [
  "── open(App.tsx): 9 items",
  "   Create { id: 2, kind: View }",
  "   Insert { parent: 2, child: 3, before: None }",
  "   Frame { id: 2, x: 0, y: 0, w: 1280, h: 800 }",
  "   Frame { id: 3, x: 200, y: 50, w: 1000, h: 700 }",
  ...cols.flatMap(([x, y], i) => [
    `   Insert { parent: 3, child: ${10 + i}, before: None }`,
    `   ViewProps { id: ${10 + i}, props: ViewProps { pointer_events: Auto, test_id: Some("tasks-col-${"abc"[i]}"), pan_scroll_handoff: false } }`,
    `   Frame { id: ${10 + i}, x: ${x}, y: ${y}, w: 264, h: 300 }`,
  ]),
  "✓ steps",
].join("\n");
const board = RULES.find((r) => r.name.includes("board"))!;

test("columns side by side pass, positions are in the window", () => {
  const [app] = parse(trace([[12, 12], [286, 12], [560, 12]]));
  expect(app.ids.get("tasks-col-b")).toEqual({ x: 486, y: 62, w: 264, h: 300 });
  expect(board.check(app.ids)).toBeNull();
});

test("stacked columns fail", () => {
  const [app] = parse(trace([[12, 12], [12, 322], [12, 632]]));
  expect(board.check(app.ids)).toMatch(/tasks-col-b .* not to the right of tasks-col-a/);
});

test("a later frame for the same view wins", () => {
  const t = trace([[12, 12], [12, 322]]) + "\n── press(x): 1 items\n   Frame { id: 11, x: 286, y: 12, w: 264, h: 300 }";
  expect(board.check(parse(t)[0].ids)).toBeNull();
});
