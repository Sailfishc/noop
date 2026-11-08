// Runtime adapters: one way to start an agent engine headless on this machine, follow what it does, and resume its
// session for the next turn: Codex (`codex exec --json`), Claude Code (`claude -p --output-format stream-json`) and pi
// (`pi -p --mode json`).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_GATES } from "./gates";

/** What a run is doing, for the task card ("运行 bun test", "改 src/orders.ts"). */
export type RunEvent = { kind: "session"; id: string } | { kind: "step"; text: string } | { kind: "message"; text: string } | { kind: "error"; text: string };

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
export function codexEvent(line: string): RunEvent | null {
  let e: any;
  try { e = JSON.parse(line); } catch { return null; }
  switch (e?.type) {
    case "thread.started":
      return e.thread_id ? { kind: "session", id: String(e.thread_id) } : null;
    case "turn.failed":
      return { kind: "error", text: String(e.error?.message ?? "turn failed") };
    case "error":
      return { kind: "error", text: String(e.message ?? "error") };
    case "item.started":
    case "item.completed": {
      const it = e.item ?? {};
      switch (it.type) {
        case "agent_message":
          return e.type === "item.completed" ? { kind: "message", text: String(it.text ?? "") } : null;
        case "command_execution":
          return e.type === "item.started" ? { kind: "step", text: `运行 ${short(it.command, 100)}` } : null;
        case "file_change": {
          const paths = (it.changes ?? []).map((c: any) => String(c.path ?? "").split("/").slice(-2).join("/")).filter(Boolean);
          return paths.length ? { kind: "step", text: `改 ${short(paths.join(", "), 100)}` } : null;
        }
        case "web_search":
          return { kind: "step", text: `搜索 ${short(it.query, 100)}` };
        case "mcp_tool_call":
          return { kind: "step", text: `调用 ${it.server ?? ""}${it.tool ? `.${it.tool}` : ""}` };
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

/** The command line of a Codex run: non-interactive, sandboxed to the work directory (plus `writable`), with network. */
export function codexCommand(o: Pick<RunOptions, "cwd" | "resume" | "writable" | "model">): string[] {
  const cmd = ["codex", "exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write",
    "-c", 'approval_policy="never"', "-c", "sandbox_workspace_write.network_access=true", "--cd", o.cwd];
  for (const d of o.writable ?? []) cmd.push("--add-dir", d);
  if (o.model) cmd.push("-m", o.model);
  if (o.resume) cmd.push("resume", o.resume);
  return [...cmd, "-"];
}

/** Starts `command` with the prompt on stdin, turns each JSON line of its output into RunEvents with `parse`, and
 * collects the session, the last message and the error. Shared by the adapters below. */
function jsonlRun(bin: string, command: (o: RunOptions) => string[], parse: (line: string) => RunEvent | RunEvent[] | null, o: RunOptions): RunHandle {
  const cmd = command(o);
  const proc = Bun.spawn(cmd, {
    cwd: o.cwd, stdin: new Blob([o.prompt]), stdout: "pipe", stderr: "pipe", env: { ...process.env, ...o.env },
  });
  let killed = false;
  const done = (async (): Promise<RunResult> => {
    let session = o.resume ?? "", text = "", error: string | undefined, buf = "", log = "";
    const dec = new TextDecoder();
    const onLine = (line: string) => {
      if (!line.trim()) return;
      log += line + "\n";
      const got = parse(line);
      for (const ev of got ? (Array.isArray(got) ? got : [got]) : []) {
        if (ev.kind === "session") session = ev.id;
        else if (ev.kind === "message") text = ev.text;
        else if (ev.kind === "error") error = ev.text;
        o.onEvent?.(ev);
      }
    };
    const errText = new Response(proc.stderr).text();
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop()!;
      lines.forEach(onLine);
    }
    onLine(buf);
    const exitCode = await proc.exited;
    const stderr = await errText;
    if (o.logFile) {
      try {
        if (!existsSync(dirname(o.logFile))) mkdirSync(dirname(o.logFile), { recursive: true });
        writeFileSync(o.logFile, `$ ${cmd.join(" ")}\n(exit ${exitCode})\n\n${log}\n[stderr]\n${stderr}`);
      } catch {}
    }
    if (exitCode && !error) error = stderr.trim().split("\n").slice(-3).join("\n") || `${bin} exited ${exitCode}`;
    return { session, text, exitCode, killed, error };
  })();
  return { done, kill: () => { killed = true; proc.kill(); } };
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
    case "result": {
      const out: RunEvent[] = [];
      if (e.session_id) out.push({ kind: "session", id: String(e.session_id) });
      if (typeof e.result === "string" && e.result) out.push({ kind: "message", text: e.result });
      if (e.is_error) out.push({ kind: "error", text: String(e.result || e.subtype || "error") });
      return out;
    }
  }
  return null;
}

/** Tools a Claude Code run may use without asking (nobody is there to answer), and what it may never run. */
const CLAUDE_TOOLS = ["Bash", "Read", "Edit", "MultiEdit", "Write", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "Task", "NotebookEdit"];

/** The command line of a Claude Code run: print mode, JSON stream, edits accepted, the listed tools allowed, the gates
 * denied; its own attribution lines off (the task's PR says who did it). */
export function claudeCommand(o: Pick<RunOptions, "resume" | "writable" | "model">): string[] {
  const cmd = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits",
    "--allowedTools", CLAUDE_TOOLS.join(","), "--disallowedTools", ...DEFAULT_GATES,
    "--settings", JSON.stringify({ attribution: { commit: "", pr: "" }, includeCoAuthoredBy: false })];
  for (const d of o.writable ?? []) cmd.push("--add-dir", d);
  if (o.model) cmd.push("--model", o.model);
  if (o.resume) cmd.push("--resume", o.resume);
  return cmd;
}

export const claude: Runtime = {
  name: "claude",
  available: () => onPath("claude"),
  start: (o) => jsonlRun("claude", claudeCommand, claudeEvent, { ...o, env: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0", ...o.env } }),
};

// ---------------------------------------------------------------- pi

const textOf = (m: any) => (Array.isArray(m?.content) ? m.content : []).filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join("");

/** One line of `pi -p --mode json` → what it means for us. */
export function piEvent(line: string): RunEvent | null {
  let e: any;
  try { e = JSON.parse(line); } catch { return null; }
  switch (e?.type) {
    case "session":
      return e.id ? { kind: "session", id: String(e.id) } : null;
    case "tool_execution_start": {
      const s = toolStep(String(e.toolName ?? ""), e.args);
      return s ? { kind: "step", text: s } : null;
    }
    case "message_end": {
      const m = e.message ?? {};
      if (m.role !== "assistant") return null;
      if (m.stopReason === "error" || m.stopReason === "aborted") return { kind: "error", text: String(m.errorMessage ?? m.stopReason) };
      const t = textOf(m);
      return t.trim() ? { kind: "message", text: t } : null;
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
