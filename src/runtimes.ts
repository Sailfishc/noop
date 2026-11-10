// Runtime adapters: one way to start an agent engine headless on this machine, follow what it does, and resume its
// session for the next turn: Codex (`codex exec --json`), Claude Code (`claude -p --output-format stream-json`) and pi
// (`pi -p --mode json`).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_GATES } from "./gates";
import { addUsage, type Usage } from "./runfail";
import { codexMcpArgs, type McpServer } from "./teamconfig";

/** What a run is doing, for the task card ("运行 bun test", "改 src/orders.ts"). "idle": a tool call finished and the
 * agent is between calls, a safe moment to stop it and resume the session with news (teamwork.ts, steering). */
export type RunEvent = { kind: "session"; id: string } | { kind: "step"; text: string } | { kind: "message"; text: string } | { kind: "error"; text: string }
  | { kind: "usage"; usage: Usage } | { kind: "idle" };
const IDLE: RunEvent = { kind: "idle" };

export type RunOptions = {
  cwd: string;
  prompt: string;
  /** Continue this session (the previous turn of the same task) instead of starting a new one. */
  resume?: string;
  /** More directories the run may write (a worktree's main repository .git). */
  writable?: string[];
  env?: Record<string, string>;
  model?: string;
  logFile?: string;
  onEvent?: (e: RunEvent) => void;
  /** MCP servers from the team config (teamconfig.ts), filled in; file: the same as an mcp.json for Claude Code. */
  mcp?: { servers: Record<string, McpServer>; file?: string };
  /** Stop the run when it has printed nothing for this long (ms; 0: never). */
  stallMs?: number;
  /** Stop the run after this long in all (ms; 0: never). */
  timeoutMs?: number;
};

export type RunResult = {
  /** The session to resume next time. */
  session: string;
  /** The agent's last message (it ends with the result block). */
  text: string;
  exitCode: number;
  /** Stopped from outside (the task was cancelled). */
  killed: boolean;
  error?: string;
  /** The watchdog stopped it: no output for stallMs, or past timeoutMs. */
  stopped?: "stall" | "timeout";
  /** The end of what it wrote to stderr. */
  stderr?: string;
  /** Tokens the run used, as far as the runtime said. */
  usage?: Usage;
  /** How many steps (tool calls) it took. */
  steps?: number;
};

export type RunHandle = { done: Promise<RunResult>; kill: () => void };

export interface Runtime {
  name: string;
  available(): boolean;
  start(o: RunOptions): RunHandle;
}

const short = (s: string, n = 120) => {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** One line of `codex exec --json` → what it means for us (null: nothing worth showing). */
export function codexEvent(line: string): RunEvent | RunEvent[] | null {
  let e: any;
  try { e = JSON.parse(line); } catch { return null; }
  switch (e?.type) {
    case "thread.started":
      return e.thread_id ? { kind: "session", id: String(e.thread_id) } : null;
    case "turn.failed":
      return { kind: "error", text: String(e.error?.message ?? "turn failed") };
    case "turn.completed": {
      // Codex counts cached input inside input_tokens: split it out
      const u = e.usage ?? {};
      if (typeof u.input_tokens !== "number") return null;
      const cached = Number(u.cached_input_tokens) || 0;
      return { kind: "usage", usage: { input: u.input_tokens - cached, cacheRead: cached, output: Number(u.output_tokens) || 0 } };
    }
    case "error":
      return { kind: "error", text: String(e.message ?? "error") };
    case "item.started":
    case "item.completed": {
      const it = e.item ?? {};
      switch (it.type) {
        case "agent_message":
          return e.type === "item.completed" ? { kind: "message", text: String(it.text ?? "") } : null;
        case "command_execution":
          return e.type === "item.started" ? { kind: "step", text: `运行 ${short(it.command, 100)}` } : IDLE;
        case "file_change": {
          const paths = (it.changes ?? []).map((c: any) => String(c.path ?? "").split("/").slice(-2).join("/")).filter(Boolean);
          return paths.length ? [{ kind: "step", text: `改 ${short(paths.join(", "), 100)}` }, IDLE] : IDLE;
        }
        case "web_search":
          return e.type === "item.started" ? { kind: "step", text: `搜索 ${short(it.query, 100)}` } : IDLE;
        case "mcp_tool_call":
          return e.type === "item.started" ? { kind: "step", text: `调用 ${it.server ?? ""}${it.tool ? `.${it.tool}` : ""}` } : IDLE;
        case "todo_list": {
          const next = (it.items ?? []).find((x: any) => !x.completed);
          return next ? { kind: "step", text: short(next.text, 100) } : null;
        }
      }
      return null;
    }
  }
  return null;
}

/** The run's own environment (`env`: the push gate, REMI_URL / REMI_TOKEN, PATH with the remi command) for the shell
 * commands Codex starts. Codex does not hand its whole environment to them: its shell_environment_policy may keep
 * only a few core variables (`inherit = "core"` drops everything but PATH, HOME, …) and may drop every name with KEY,
 * SECRET or TOKEN in it (`ignore_default_excludes = false`). Its `set` entries are applied after those filters, so
 * the run's variables reach the commands whatever the machine's config says. One entry per variable: the person's
 * own `set` entries stay. */
export function codexEnvArgs(env: Record<string, string> = {}): string[] {
  return Object.entries(env).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .flatMap(([k, v]) => ["-c", `shell_environment_policy.set.${k}=${JSON.stringify(v)}`]);
}

/** The command line of a Codex run: non-interactive, sandboxed to the work directory (plus `writable`), with network. */
export function codexCommand(o: Pick<RunOptions, "cwd" | "resume" | "writable" | "model" | "mcp" | "env">): string[] {
  const cmd = ["codex", "exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write",
    "-c", 'approval_policy="never"', "-c", "sandbox_workspace_write.network_access=true", ...codexMcpArgs(o.mcp?.servers ?? {}),
    ...codexEnvArgs(o.env), "--cd", o.cwd];
  for (const d of o.writable ?? []) cmd.push("--add-dir", d);
  if (o.model) cmd.push("-m", o.model);
  if (o.resume) cmd.push("resume", o.resume);
  return [...cmd, "-"];
}

/** `text` with the values of the run's secret variables (REMI_TOKEN, …) masked: the command line goes to the log. */
export function redact(text: string, env: Record<string, string> = {}): string {
  for (const [k, v] of Object.entries(env)) if (v && /TOKEN|SECRET|KEY/i.test(k) && !/^GIT_CONFIG_KEY_/.test(k)) text = text.split(v).join("***");
  return text;
}

/** Starts `command` with the prompt on stdin, turns each JSON line of its output into RunEvents with `parse`, and
 * collects the session, the last message and the error. Shared by the adapters below.
 * The run gets its own process group, so stopping it also stops what it started (a test run, a dev server). A
 * watchdog stops it when it prints nothing for `stallMs`, or runs past `timeoutMs`. */
export function jsonlRun(bin: string, command: (o: RunOptions) => string[], parse: (line: string) => RunEvent | RunEvent[] | null, o: RunOptions): RunHandle {
  const cmd = command(o);
  const proc = Bun.spawn(cmd, {
    cwd: o.cwd, stdin: new Blob([o.prompt]), stdout: "pipe", stderr: "pipe", env: { ...process.env, ...o.env }, detached: true,
  } as Parameters<typeof Bun.spawn>[1]);
  let killed = false, stopped: RunResult["stopped"], lastOutput = Date.now();
  const stop = () => {
    const signal = (sig: NodeJS.Signals) => { try { process.kill(-proc.pid, sig); } catch { try { proc.kill(sig); } catch {} } };
    signal("SIGTERM");
    const hard = setTimeout(() => signal("SIGKILL"), 10_000);
    void proc.exited.then(() => clearTimeout(hard));
  };
  const watch = o.stallMs || o.timeoutMs ? setInterval(() => {
    const now = Date.now();
    if (o.timeoutMs && now - started >= o.timeoutMs) stopped = "timeout";
    else if (o.stallMs && now - lastOutput >= o.stallMs) stopped = "stall";
    if (stopped) { clearInterval(watch); stop(); }
  }, Math.max(50, Math.min(30_000, (o.stallMs || o.timeoutMs || 30_000) / 4))) : undefined;
  const started = Date.now();
  const done = (async (): Promise<RunResult> => {
    let session = o.resume ?? "", text = "", error: string | undefined, buf = "", log = "", usage: Usage | undefined, steps = 0;
    const dec = new TextDecoder();
    const onLine = (line: string) => {
      if (!line.trim()) return;
      log += line + "\n";
      const got = parse(line);
      for (const ev of got ? (Array.isArray(got) ? got : [got]) : []) {
        if (ev.kind === "session") session = ev.id;
        else if (ev.kind === "message") text = ev.text;
        else if (ev.kind === "error") error = ev.text;
        else if (ev.kind === "usage") usage = addUsage(usage, ev.usage);
        else if (ev.kind === "step") steps++;
        o.onEvent?.(ev);
      }
    };
    const errText = (async () => {
      let all = "";
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) { lastOutput = Date.now(); all += dec.decode(chunk, { stream: true }); if (all.length > 64_000) all = all.slice(-32_000); }
      return all;
    })();
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      lastOutput = Date.now();
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop()!;
      lines.forEach(onLine);
    }
    onLine(buf);
    const exitCode = await proc.exited;
    clearInterval(watch);
    const stderr = await errText;
    if (o.logFile) {
      try {
        if (!existsSync(dirname(o.logFile))) mkdirSync(dirname(o.logFile), { recursive: true });
        writeFileSync(o.logFile, `$ ${redact(cmd.join(" "), o.env)}\n(exit ${exitCode}${stopped ? `, stopped: ${stopped}` : ""})\n\n${log}\n[stderr]\n${stderr}`);
      } catch {}
    }
    if (exitCode && !error && !killed && !stopped) error = stderr.trim().split("\n").slice(-3).join("\n") || `${bin} exited ${exitCode}`;
    return { session, text, exitCode, killed, error, stopped, stderr: stderr.slice(-4000), usage, steps };
  })();
  return { done, kill: () => { killed = true; clearInterval(watch); stop(); } };
}

const onPath = (bin: string) => Bun.which(bin, { PATH: process.env.PATH ?? "" }) !== null;

export const codex: Runtime = {
  name: "codex",
  available: () => onPath("codex"),
  start: (o) => jsonlRun("codex", codexCommand, codexEvent, o),
};

// ---------------------------------------------------------------- Claude Code

const tail = (p: unknown) => String(p ?? "").split("/").slice(-2).join("/");

/** What a tool call of Claude Code or pi does, for the card (null: not worth showing). */
function toolStep(name: string, input: any): string | null {
  const i = input ?? {};
  switch (name.toLowerCase()) {
    case "bash": return i.command ? `运行 ${short(i.command, 100)}` : null;
    case "edit": case "multiedit": case "write": case "notebookedit": return `改 ${tail(i.file_path ?? i.path ?? i.notebook_path)}`;
    case "read": return `读 ${tail(i.file_path ?? i.path)}`;
    case "grep": case "glob": case "find": case "ls": return `查找 ${short(i.pattern ?? i.path ?? "", 80)}`;
    case "websearch": return `搜索 ${short(i.query, 100)}`;
    case "webfetch": return `打开 ${short(i.url, 100)}`;
    case "todowrite": {
      const next = (i.todos ?? []).find((x: any) => x.status === "in_progress") ?? (i.todos ?? []).find((x: any) => x.status !== "completed");
      return next ? short(next.content ?? next.activeForm, 100) : null;
    }
    case "task": case "agent": return `交给子 Agent：${short(i.description ?? "", 80)}`;
  }
  return `调用 ${name}`;
}

/** One line of `claude -p --output-format stream-json --verbose` → what it means for us. */
export function claudeEvent(line: string): RunEvent | RunEvent[] | null {
  let e: any;
  try { e = JSON.parse(line); } catch { return null; }
  switch (e?.type) {
    case "system":
      return e.subtype === "init" && e.session_id ? { kind: "session", id: String(e.session_id) } : null;
    case "assistant": {
      if (e.parent_tool_use_id) return null; // a subagent's inner steps
      const out: RunEvent[] = [];
      for (const c of e.message?.content ?? []) {
        if (c.type === "tool_use") { const s = toolStep(String(c.name ?? ""), c.input); if (s) out.push({ kind: "step", text: s }); }
        else if (c.type === "text" && c.text) out.push({ kind: "message", text: String(c.text) }); // said along the way (the result is the last word)
      }
      return out.length ? out : null;
    }
    case "user": // a tool's result came back: between tool calls
      return !e.parent_tool_use_id && Array.isArray(e.message?.content) && e.message.content.some((c: any) => c?.type === "tool_result") ? IDLE : null;
    case "result": {
      const out: RunEvent[] = [];
      if (e.session_id) out.push({ kind: "session", id: String(e.session_id) });
      if (typeof e.result === "string" && e.result) out.push({ kind: "message", text: e.result });
      if (e.is_error) out.push({ kind: "error", text: String(e.result || e.subtype || "error") });
      const u = e.usage;
      if (u && typeof u.input_tokens === "number") {
        out.push({ kind: "usage", usage: { input: u.input_tokens, cacheRead: Number(u.cache_read_input_tokens) || 0,
          cacheWrite: Number(u.cache_creation_input_tokens) || 0, output: Number(u.output_tokens) || 0 } });
      }
      return out;
    }
  }
  return null;
}

/** Tools a Claude Code run may use without asking (nobody is there to answer), and what it may never run. Skill: the
 * skills installed on the machine (~/.claude/skills, the team config repo) and in the repository. */
const CLAUDE_TOOLS = ["Bash", "Read", "Edit", "MultiEdit", "Write", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "Task", "NotebookEdit", "Skill"];

/** The MCP servers Claude Code would load in `cwd`: the user's (~/.claude.json mcpServers), the local ones of `cwd` and
 * the folders above it (~/.claude.json projects), and the repository's .mcp.json. In print mode a tool that is not
 * allowed is simply refused, and `--allowedTools` takes no wildcard over servers ("mcp__*" matches nothing), so each
 * server is allowed by name ("mcp__github" allows all of its tools). Servers come from the machine's own config: what
 * someone installed on this Computer is what its agents may use. */
export function claudeMcpServers(cwd: string, home = homedir()): string[] {
  const names = new Set<string>();
  const add = (servers: unknown) => {
    if (servers && typeof servers === "object") for (const k of Object.keys(servers)) names.add(k);
  };
  const read = (path: string): any => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
  const user = read(join(home, ".claude.json"));
  add(user?.mcpServers);
  for (const [dir, p] of Object.entries<any>(user?.projects ?? {})) {
    if (cwd === dir || cwd.startsWith(dir.endsWith("/") ? dir : dir + "/")) add(p?.mcpServers);
  }
  add(read(join(cwd, ".mcp.json"))?.mcpServers);
  // Claude Code names a server's tools mcp__<name>__<tool>, with what is not a letter, digit, _ or - turned into _
  return [...names].map((n) => "mcp__" + n.replace(/[^A-Za-z0-9_-]/g, "_")).sort();
}

/** The command line of a Claude Code run: print mode, JSON stream, edits accepted, the listed tools and the machine's
 * MCP servers allowed, the gates denied; its own attribution lines off (the task's PR says who did it). */
export function claudeCommand(o: Pick<RunOptions, "resume" | "writable" | "model"> & { mcp?: string[]; mcpConfig?: RunOptions["mcp"] }): string[] {
  const team = o.mcpConfig?.file ? Object.keys(o.mcpConfig.servers).map((n) => `mcp__${n}`) : [];
  const allowed = [...new Set([...CLAUDE_TOOLS, ...(o.mcp ?? []), ...team])];
  const cmd = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits",
    "--allowedTools", allowed.join(","), "--disallowedTools", ...DEFAULT_GATES,
    "--settings", JSON.stringify({ attribution: { commit: "", pr: "" }, includeCoAuthoredBy: false })];
  if (o.mcpConfig?.file) cmd.push("--mcp-config", o.mcpConfig.file);
  for (const d of o.writable ?? []) cmd.push("--add-dir", d);
  if (o.model) cmd.push("--model", o.model);
  if (o.resume) cmd.push("--resume", o.resume);
  return cmd;
}

export const claude: Runtime = {
  name: "claude",
  available: () => onPath("claude"),
  start: (o) => jsonlRun("claude", (r) => claudeCommand({ ...r, mcp: claudeMcpServers(r.cwd), mcpConfig: r.mcp }), claudeEvent,
    { ...o, env: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0", ...o.env } }),
};

// ---------------------------------------------------------------- pi

const textOf = (m: any) => (Array.isArray(m?.content) ? m.content : []).filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join("");

/** One line of `pi -p --mode json` → what it means for us. */
export function piEvent(line: string): RunEvent | RunEvent[] | null {
  let e: any;
  try { e = JSON.parse(line); } catch { return null; }
  switch (e?.type) {
    case "session":
      return e.id ? { kind: "session", id: String(e.id) } : null;
    case "tool_execution_start": {
      const s = toolStep(String(e.toolName ?? ""), e.args);
      return s ? { kind: "step", text: s } : null;
    }
    case "tool_execution_end":
      return IDLE;
    case "message_end": {
      const m = e.message ?? {};
      if (m.role !== "assistant") return null;
      const u = m.usage;
      const usage: RunEvent[] = u && typeof u.input === "number"
        ? [{ kind: "usage", usage: { input: u.input, cacheRead: Number(u.cacheRead) || 0, cacheWrite: Number(u.cacheWrite) || 0, output: Number(u.output) || 0 } }] : [];
      if (m.stopReason === "error" || m.stopReason === "aborted") {
        const err: RunEvent = { kind: "error", text: String(m.errorMessage ?? m.stopReason) };
        return usage.length ? [...usage, err] : err;
      }
      const t = textOf(m);
      const out: RunEvent[] = [...usage, ...(t.trim() ? [{ kind: "message" as const, text: t }] : [])];
      return out.length === 0 ? null : out.length === 1 ? out[0]! : out;
    }
    case "auto_retry_end":
      return e.success ? null : { kind: "error", text: String(e.finalError ?? "retry failed") };
  }
  return null;
}

/** The command line of a pi run: print mode with the JSON event stream; the session continues by id. pi has no sandbox
 * of its own: the gate environment (no push, no gh/glab credentials) is what holds it back. */
export function piCommand(o: Pick<RunOptions, "resume" | "model">): string[] {
  const cmd = ["pi", "-p", "--mode", "json"];
  if (o.model) cmd.push("--model", o.model);
  if (o.resume) cmd.push("--session", o.resume);
  return cmd;
}

export const pi: Runtime = {
  name: "pi",
  available: () => onPath("pi"),
  start: (o) => jsonlRun("pi", piCommand, piEvent, o),
};

export const RUNTIMES: Record<string, Runtime> = { codex, claude, pi };
