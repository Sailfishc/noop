import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addedLines, localRules, parseAllow, RULES, scanLines, sensitiveIp } from "../scripts/check-secrets";

// The samples are glued together at runtime so this file does not trip the scan itself.
const IP = ["8", "8", "4", "4"].join(".");
const GH = "gh" + "p_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const rules = (s: string, file = "app/x.ts") =>
  scanLines(s.split("\n").map((text, i) => ({ file, line: i + 1, text })), RULES).map((h) => h.rule);

test("an ATS exception that names the server's IP is refused", () => {
  const nsh = `"NSExceptionDomains": {\n  "${IP}": { "NSExceptionAllowsInsecureHTTPLoads": true }\n}`;
  expect(rules(nsh, "app/nsh.json")).toEqual(["ip-address"]);
});

test("private and public addresses are refused; loopback, bind-all and documentation addresses pass", () => {
  for (const ip of [IP, ["10", "1", "2", "3"].join("."), ["172", "16", "0", "9"].join("."), ["192", "168", "1", "1"].join(".")])
    expect(sensitiveIp(ip)).toBe(true);
  for (const ip of ["127.0.0.1", "0.0.0.0", "255.255.255.255", "192.0.2.5", "198.51.100.7", "203.0.113.9"])
    expect(sensitiveIp(ip)).toBe(false);
  expect(sensitiveIp("300.1.1.1")).toBe(false);
  expect(sensitiveIp("01.2.3.4")).toBe(false);
});

test("versions, SVG paths and other dotted numbers are not addresses", () => {
  expect(rules('"version": "0.1.0", go 1.22.3, semver 1.2.3-beta.4')).toEqual([]);
  expect(rules('"M8 0C3.58 0 0 3.58 0 8c0 1.23.82.72 1.21 1.87"')).toEqual([]);
  expect(rules("listen on http://127.0.0.1:8080 or http://192.0.2.5:8080")).toEqual([]);
});

test("token formats and literal secrets are refused", () => {
  expect(rules(`token = "${GH}"`)).toContain("github-token");
  expect(rules("glpat-" + "abcdefghij1234567890")).toEqual(["gitlab-token"]);
  expect(rules("AKIA" + "ABCDEFGHIJKLMNOP")).toEqual(["aws-key"]);
  expect(rules("-----BEGIN OPENSSH " + "PRIVATE KEY-----")).toEqual(["private-key"]);
  expect(rules("sk-" + "ant-" + "a".repeat(20) + "B9".repeat(10))).toEqual(["llm-key"]);
  expect(rules(`const password = "${"Zq81kLmP0xYt3vRw"}"`)).toEqual(["assigned-secret"]);
  expect(rules("https://bot:" + "S3cr3tPassw0rd" + "@git.corp/x.git")).toEqual(["url-credentials"]);
});

test("placeholders and obvious test values pass", () => {
  expect(rules('token = "tam_abc"; secret: "${TOKEN}"; password = "<your password>"')).toEqual([]);
  expect(rules('api_key = "xxxxxxxxxxxxxxxxxxxx"')).toEqual([]);
  expect(rules("https://user:secret@github.com/acme/pay.git")).toEqual([]);
});

test("an inline marker or the allow file lets a reviewed line through", () => {
  expect(rules(`ping ${IP} // secret-scan: allow public DNS in a doc example`)).toEqual([]);
  const allow = parseAllow("# vendored\nip-address app/vendor/**\n* fixtures/*.pem\n");
  const scan = (file: string, text: string) => scanLines([{ file, line: 1, text }], RULES, allow).map((h) => h.rule);
  expect(scan("app/vendor/a.ts", IP)).toEqual([]);
  expect(scan("app/a.ts", IP)).toEqual(["ip-address"]);
  expect(scan("fixtures/k.pem", "-----BEGIN RSA " + "PRIVATE KEY-----")).toEqual([]);
});

test("local patterns come from .git/info and the environment, never the repository", () => {
  const root = mkdtempSync(join(tmpdir(), "scan-"));
  mkdirSync(join(root, ".git", "info"), { recursive: true });
  writeFileSync(join(root, ".git", "info", "sensitive-patterns"), "# intranet\n\\bcorp-intra\\.example\\b\n");
  const r = localRules(root, { REMI_SENSITIVE_PATTERNS: "acme-internal" });
  expect(r).toHaveLength(2);
  expect(scanLines([{ file: "a", line: 1, text: "see https://wiki.corp-intra.example/x" }], r)).toHaveLength(1);
  expect(scanLines([{ file: "a", line: 1, text: "ACME-INTERNAL build" }], r)).toHaveLength(1);
});

test("only added lines of a diff are scanned, with their new line numbers", () => {
  const diff = [
    "diff --git a/app/nsh.json b/app/nsh.json",
    "--- a/app/nsh.json",
    "+++ b/app/nsh.json",
    "@@ -3,0 +4,2 @@",
    `+  "host": "${IP}",`,
    "+  \"ok\": true",
    "@@ -9 +11 @@",
    `-  "old": "${IP}"`,
    '+  "old": "127.0.0.1"',
  ].join("\n");
  const lines = addedLines(diff);
  expect(lines.map((l) => [l.file, l.line])).toEqual([["app/nsh.json", 4], ["app/nsh.json", 5], ["app/nsh.json", 11]]);
  expect(scanLines(lines, RULES).map((h) => h.line)).toEqual([4]);
});

test("the pre-commit mode refuses a staged IP and passes once it is gone", () => {
  const dir = mkdtempSync(join(tmpdir(), "scan-repo-"));
  const run = (...a: string[]) => Bun.spawnSync(a, { cwd: dir, stdout: "pipe", stderr: "pipe" });
  run("git", "init", "-q");
  writeFileSync(join(dir, "nsh.json"), `{ "NSExceptionDomains": { "${IP}": {} } }\n`);
  run("git", "add", ".");
  const script = join(import.meta.dir, "..", "scripts", "check-secrets.ts");
  const bad = run(process.execPath, script, "--staged");
  expect(bad.exitCode).toBe(1);
  expect(bad.stderr.toString()).toContain(`nsh.json:1  [ip-address]`);
  writeFileSync(join(dir, "nsh.json"), "{}\n");
  run("git", "add", ".");
  expect(run(process.execPath, script, "--staged").exitCode).toBe(0);
});
