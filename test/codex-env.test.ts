// What the shell commands of a Codex run see. Codex filters its own environment before it starts a command
// (shell_environment_policy): with `inherit = "core"` and the default excludes on, REMI_URL and REMI_TOKEN were
// dropped and `remi` could not reach the server. A stand-in `codex` applies that policy the way Codex does (inherit,
// default excludes, then `set` from -c), and the run goes through the real launch layer (codex.start, cliEnv).
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codex, codexEnvArgs, redact } from "../src/runtimes";
import { cliEnv, gateEnv } from "../src/teamwork";

const FAKE_CODEX = `#!/usr/bin/env bun
// inherit = "core", ignore_default_excludes = false, then shell_environment_policy.set.* from -c
const CORE = ["PATH", "SHELL", "TMPDIR", "TEMP", "TMP", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "USER"];
const env = {};
for (const k of CORE) if (process.env[k] !== undefined) env[k] = process.env[k];
for (const k of Object.keys(env)) if (/KEY|SECRET|TOKEN/i.test(k)) delete env[k];
const a = process.argv.slice(2);
for (let i = 0; i < a.length; i++) {
  const m = a[i - 1] === "-c" && /^shell_environment_policy\\.set\\.([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(a[i]);
  if (m) env[m[1]] = JSON.parse(m[2]);
}
const r = Bun.spawnSync(["sh", "-c", 'remi who @acha; echo "push=$GIT_CONFIG_COUNT url=$REMI_URL"'], { env, stdout: "pipe", stderr: "pipe" });
console.log(JSON.stringify({ type: "thread.started", thread_id: "thr_env" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: r.stdout.toString() + r.stderr.toString() } }));
`;

test("a Codex run's shell commands get REMI_URL, REMI_TOKEN and the push gate, whatever Codex's env policy", async () => {
  const seen: string[] = [];
  const server = Bun.serve({ port: 0, fetch(req) { seen.push(req.headers.get("authorization") ?? ""); return new Response("acha: agent\n"); } });
  const W = mkdtempSync(join(tmpdir(), "codex-env-"));
  const PATH = process.env.PATH;
  try {
    writeFileSync(join(W, "codex"), FAKE_CODEX);
    chmodSync(join(W, "codex"), 0o755);
    process.env.PATH = `${W}:${PATH}`;
    const env = { ...gateEnv({ cwd: join(W, "T-0001"), writable: [] }), ...cliEnv(W, `http://127.0.0.1:${server.port}/`, "rt_secret"), no_proxy: "127.0.0.1", NO_PROXY: "127.0.0.1" };
    const logFile = join(W, "run.jsonl");
    const r = await codex.start({ cwd: W, prompt: "go", env, logFile }).done;
    expect(r.exitCode).toBe(0);
    expect(r.text).toContain("acha: agent");
    expect(r.text).toContain(`push=7 url=http://127.0.0.1:${server.port}`);
    expect(seen).toEqual(["Bearer rt_secret"]);
    // the token is on Codex's command line, but not in the run's log
    const log = readFileSync(logFile, "utf8");
    expect(log).toContain("shell_environment_policy.set.REMI_TOKEN=\"***\"");
    expect(log).not.toContain("rt_secret");
  } finally {
    process.env.PATH = PATH;
    server.stop(true);
    rmSync(W, { recursive: true, force: true });
  }
});

test("codex env overrides: one -c per variable, values as TOML strings; odd names left out", () => {
  expect(codexEnvArgs({ REMI_URL: "http://h:1", GH_TOKEN: "", Q: 'a"b\\c' })).toEqual([
    "-c", 'shell_environment_policy.set.REMI_URL="http://h:1"',
    "-c", 'shell_environment_policy.set.GH_TOKEN=""',
    "-c", 'shell_environment_policy.set.Q="a\\"b\\\\c"',
  ]);
  expect(codexEnvArgs({ "A.B": "x", "": "y" })).toEqual([]);
  expect(redact("x REMI_TOKEN=rt_1 y", { REMI_TOKEN: "rt_1", GIT_CONFIG_KEY_0: "url" })).toBe("x REMI_TOKEN=*** y");
});
