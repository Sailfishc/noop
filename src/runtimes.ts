// Runtime adapters: one way to start an agent engine headless on this machine, follow what it does, and resume its
// session for the next turn. v1 ships Codex (`codex exec --json`); Claude Code is the next adapter on the same shape.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

export const codex: Runtime = {
  name: "codex",
  available: () => Bun.which("codex", { PATH: process.env.PATH ?? "" }) !== null,
  start(o) {
    const proc = Bun.spawn(codexCommand(o), {
      cwd: o.cwd, stdin: new Blob([o.prompt]), stdout: "pipe", stderr: "pipe", env: { ...process.env, ...o.env },
    });
    let killed = false;
    const done = (async (): Promise<RunResult> => {
      let session = o.resume ?? "", text = "", error: string | undefined, buf = "", log = "";
      const dec = new TextDecoder();
      const onLine = (line: string) => {
        if (!line.trim()) return;
        log += line + "\n";
        const ev = codexEvent(line);
        if (!ev) return;
        if (ev.kind === "session") session = ev.id;
        else if (ev.kind === "message") text = ev.text;
        else if (ev.kind === "error") error = ev.text;
        o.onEvent?.(ev);
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
          writeFileSync(o.logFile, `$ ${codexCommand(o).join(" ")}\n(exit ${exitCode})\n\n${log}\n[stderr]\n${stderr}`);
        } catch {}
      }
      if (exitCode && !error) error = stderr.trim().split("\n").slice(-3).join("\n") || `codex exited ${exitCode}`;
      return { session, text, exitCode, killed, error };
    })();
    return { done, kill: () => { killed = true; proc.kill(); } };
  },
};

export const RUNTIMES: Record<string, Runtime> = { codex };
