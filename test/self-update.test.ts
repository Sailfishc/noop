import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateRejected } from "../src/setup";

test("a release whose tests failed here is not installed again until origin moves on", () => {
  const f = join(mkdtempSync(join(tmpdir(), "remi-up-")), "update-rejected");
  expect(updateRejected("1c6ae5a", f)).toBe(false); // nothing refused yet
  writeFileSync(f, "1c6ae5a\n");
  expect(updateRejected("1c6ae5a", f)).toBe(true); // the same bad release is skipped: no reinstall, no test run
  expect(updateRejected("d23c0de", f)).toBe(false); // a newer release is tried again
});
