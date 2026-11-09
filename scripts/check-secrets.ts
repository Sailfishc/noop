#!/usr/bin/env bun
// Refuses keys, tokens and IP addresses before they reach the repository.
// The same script runs in the pre-commit hook and in CI, so a hit fails the
// same way in both places. Rules, allowlist and how to handle a false positive:
// docs/secret-scan.md.
//
//   bun scripts/check-secrets.ts              every tracked file as it is now
//   bun scripts/check-secrets.ts --staged     lines added in the staged change (pre-commit)
//   bun scripts/check-secrets.ts --range A..B lines added by each commit in A..B (CI)
//
// Exit 0 = clean, 1 = hits, 2 = usage or git error.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Rule = { id: string; re: RegExp; why: string; check?: (match: string, line: string) => boolean };
export type Hit = { file: string; line: number; rule: string; why: string; text: string; where?: string };
type Line = { file: string; line: number; text: string; where?: string };

/** An IPv4 literal that is not a loopback, wildcard or documentation address. */
export function sensitiveIp(ip: string): boolean {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((n, i) => n > 255 || String(n) !== ip.split(".")[i])) return false;
  const [a, b, c] = o;
  if (a === 127 || a === 0) return false; // loopback, 0.0.0.0 bind address
  if (o.every((n) => n === 255)) return false; // broadcast
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1 (RFC 5737)
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

const PLACEHOLDER = /\$\{|\$[A-Z_]|<[^>]*>|…|\.\.\.|x{4,}|\*{3,}|example|placeholder|changeme|your[_-]|dummy|fake|redacted/i;

/** SVG path data ("M8 0C3.58 0 ... 1.23.82.72") is full of dotted numbers that look like addresses. */
const SVG_PATH = /(?:^|["'\s=])[Mm]-?[\d.]+[ ,-]?-?[\d.]+[CcSsQqLlHhVvAaZz]/;

export const RULES: Rule[] = [
  { id: "private-key", re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/, why: "a private key" },
  { id: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/, why: "a GitHub token" },
  { id: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/, why: "a GitLab personal access token" },
  { id: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/, why: "a Slack token" },
  { id: "aws-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, why: "an AWS access key" },
  { id: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/, why: "a Google API key" },
  { id: "llm-key", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/, why: "an OpenAI/Anthropic-style API key" },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, why: "a JWT" },
  {
    id: "url-credentials",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'`]+:[^\s/@"'`]{3,}@/i,
    why: "a password inside a URL",
    check: (m) => {
      const pass = m.match(/:([^:@]+)@$/)?.[1] ?? "";
      return !PLACEHOLDER.test(m) && !/^(?:pass(?:word)?|secret|token|pwd)$/i.test(pass);
    },
  },
  {
    id: "assigned-secret",
    re: /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["'`]([^"'`\s]{16,})["'`]/i,
    why: "a literal secret assigned to a password/secret/token/key field",
    check: (m) => {
      const v = m.match(/["'`]([^"'`\s]{16,})["'`]$/)?.[1] ?? "";
      return !PLACEHOLDER.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v) && new Set(v).size >= 10;
    },
  },
  {
    id: "ip-address",
    re: /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.]*\d)/,
    why: "an IP address (intranet and server addresses belong in local config, not the repository)",
    check: (m, line) => sensitiveIp(m) && !SVG_PATH.test(line),
  },
];

/** Extra patterns for things the repository itself must not name, such as the company's intranet domains.
 * They never live in the repository: one regex per line in .git/info/sensitive-patterns, or
 * REMI_SENSITIVE_PATTERNS (newline separated; CI fills it from a repository secret). */
export function localRules(root: string, env = process.env): Rule[] {
  const lines: string[] = [];
  const f = join(root, ".git", "info", "sensitive-patterns");
  if (existsSync(f)) lines.push(...readFileSync(f, "utf8").split("\n"));
  if (env.REMI_SENSITIVE_PATTERNS) lines.push(...env.REMI_SENSITIVE_PATTERNS.split("\n"));
  return lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((p, i) => ({ id: "local-pattern", re: new RegExp(p, "i"), why: `matches local sensitive pattern #${i + 1}` }));
}

/** .secretscan-allow: "<rule-id|*> <path-glob>" per line; that rule is skipped for those files. */
export type Allow = { rule: string; glob: Bun.Glob };
export function parseAllow(text: string): Allow[] {
  return text
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean)
    .map((l) => {
      const [rule, glob] = l.split(/\s+/, 2);
      return { rule, glob: new Bun.Glob(glob ?? "") };
    });
}

/** Files never scanned: generated lockfiles and binaries. */
const SKIP = [/(^|\/)bun\.lock$/, /(^|\/)go\.sum$/, /\.(png|jpe?g|gif|ico|icns|webp|woff2?|ttf|otf|pdf|zip|gz)$/i];

export const INLINE_ALLOW = "secret-scan: allow";

export function scanLines(lines: Line[], rules: Rule[], allow: Allow[] = []): Hit[] {
  const hits: Hit[] = [];
  for (const l of lines) {
    if (SKIP.some((r) => r.test(l.file)) || l.text.includes(INLINE_ALLOW)) continue;
    for (const rule of rules) {
      if (allow.some((a) => (a.rule === "*" || a.rule === rule.id) && a.glob.match(l.file))) continue;
      const re = new RegExp(rule.re.source, rule.re.flags.replace("g", "") + "g");
      for (const m of l.text.matchAll(re)) {
        if (rule.check && !rule.check(m[0], l.text)) continue;
        hits.push({ file: l.file, line: l.line, rule: rule.id, why: rule.why, text: m[0], where: l.where });
        break;
      }
    }
  }
  return hits;
}

/** Added lines of a unified diff produced with -U0. */
export function addedLines(diff: string, where?: string): Line[] {
  const out: Line[] = [];
  let file = "";
  let n = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) file = raw.slice(4).replace(/^b\//, "");
    else if (raw.startsWith("@@")) n = Number(raw.match(/\+(\d+)/)?.[1] ?? 0);
    else if (raw.startsWith("+") && file !== "/dev/null") out.push({ file, line: n++, text: raw.slice(1), where });
  }
  return out;
}

function git(args: string[], cwd: string): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) {
    console.error(`git ${args.join(" ")} failed:\n${p.stderr.toString()}`);
    process.exit(2);
  }
  return p.stdout.toString();
}

const DIFF = ["-U0", "--no-color", "--no-ext-diff", "--diff-filter=ACMR", "--text"];

function collect(mode: string, arg: string | undefined, root: string): Line[] {
  if (mode === "--staged") return addedLines(git(["diff", "--cached", ...DIFF], root));
  if (mode === "--range") {
    if (!arg) throw new Error("--range needs A..B");
    const commits = git(["rev-list", "--reverse", arg], root).split("\n").filter(Boolean);
    return commits.flatMap((c) => addedLines(git(["show", "--format=", ...DIFF, c], root), c.slice(0, 8)));
  }
  const out: Line[] = [];
  for (const file of git(["ls-files", "-z"], root).split("\0").filter(Boolean)) {
    if (SKIP.some((r) => r.test(file)) || !existsSync(join(root, file))) continue;
    const buf = readFileSync(join(root, file));
    if (buf.includes(0)) continue; // binary
    buf.toString("utf8").split("\n").forEach((text, i) => out.push({ file, line: i + 1, text }));
  }
  return out;
}

if (import.meta.main) {
  const [mode = "--all", arg] = process.argv.slice(2);
  if (!["--all", "--staged", "--range"].includes(mode)) {
    console.error("usage: check-secrets.ts [--all | --staged | --range A..B]");
    process.exit(2);
  }
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const allowFile = join(root, ".secretscan-allow");
  const allow = existsSync(allowFile) ? parseAllow(readFileSync(allowFile, "utf8")) : [];
  const hits = scanLines(collect(mode, arg, root), [...RULES, ...localRules(root)], allow);
  if (hits.length === 0) {
    console.log(`secret scan (${mode}): clean`);
    process.exit(0);
  }
  console.error(`secret scan (${mode}): ${hits.length} hit(s)\n`);
  for (const h of hits) {
    const shown = h.rule === "local-pattern" || h.rule === "ip-address" ? h.text : h.text.slice(0, 8) + "…";
    console.error(`  ${h.where ? h.where + " " : ""}${h.file}:${h.line}  [${h.rule}] ${h.why}: ${shown}`);
  }
  console.error(`
Keep secrets, server addresses and intranet names out of the repository: read them from
local config, environment variables or what the user types at runtime.
If a hit is a false positive, add "${INLINE_ALLOW} <reason>" in a comment on that line,
or a "<rule> <path-glob>" line to .secretscan-allow. See docs/secret-scan.md.
If a real secret was committed, rotate it: deleting it from the branch is not enough.`);
  process.exit(1);
}
