import { expect, test } from "bun:test";
import { count } from "../scripts/check-ui";

test("counts what pages style themselves", () => {
  const src = [
    'import { Input } from "nsh/base";',
    '<View role="button" style={{ padding: 10, gap: 8, borderRadius: 6 }}>',
    '  <Text style={{ fontSize: 12.5, color: "#ff0000" }}>x</Text>',
    '</View>',
    '<View class="rounded-lg text-[13px]" style={{ boxShadow: "0 1px 2px rgba(0,0,0,0.2)", margin: -4, marginTop: 5 }} />',
  ].join("\n");
  expect(count(src)).toEqual({ "nsh-base": 1, pressable: 1, spacing: 2, radius: 2, "font-size": 2, color: 2 });
});

test("skips comments", () => {
  const src = ['// fontSize: 12, role="button"', "/* borderRadius: 4", "   padding: 5 */", "const url = \"https://x\"; // fontSize: 3"].join("\n");
  expect(count(src)).toEqual({});
});
