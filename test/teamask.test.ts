import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_READ_TOOLS, claudeCommand, codexCommand, piCommand, type RunOptions, type Runtime } from "../src/runtimes";
import { askPrompt, createWorker, type AskClaim } from "../src/teamwork";

const sh = (cwd: string, ...cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  return { ok: p.exitCode === 0, out: (p.stdout.toString() + p.stderr.toString()).trim() };
};

test("each runtime's read-only mode for answering another agent", () => {
  const cx = codexCommand({ cwd: "/w/ask", readOnly: true, writable: ["/r/.git"] });
  expect(cx.join(" ")).toContain("--sandbox read-only");
  expect(cx.join(" ")).not.toContain("workspace-write");
  expect(cx).not.toContain("--add-dir");
  const cc = claudeCommand({ readOnly: true, model: "sonnet", writable: ["/r/.git"] });
  expect(cc.join(" ")).toContain("--permission-mode plan");
  expect(cc[cc.indexOf("--tools") + 1]).toBe(CLAUDE_READ_TOOLS.join(","));
  for (const t of ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]) expect(CLAUDE_READ_TOOLS).not.toContain(t);
  expect(cc).toContain("--strict-mcp-config");
  expect(cc).not.toContain("--add-dir");
  expect(piCommand({ readOnly: true }).join(" ")).toContain("--tools read,grep,find,ls");
  expect(piCommand({}).join(" ")).not.toContain("--tools");
});

const askClaim = (repo = ""): AskClaim => ({
  ask: { id: "ask_1", question: "订单接口返回什么格式？", task: "T-0001" },
  agent: { id: "a2", handle: "bei", name: "Bei", owner_id: "u1", machine_id: "m1", runtime: "codex", dispatch: "channel", autonomy: "normal", repo, memory: "订单仓库在 ~/orders" },
  from: { handle: "acha", name: "Acha" }, requester: { handle: "zw", name: "张伟" }, channel: { name: "支付后端" },
  thread: [{ id: "m1", seq: 1, channel_id: "c", thread_id: null, author: { kind: "user", id: "u1" }, text: "@acha 查一下订单接口", mentions: [], created: 1 }],
  names: { u1: "张伟 (@zw)" },
});

test("the prompt: who asks, read-only, the thread and the question", () => {
  const p = askPrompt(askClaim(), { cwd: "/w/ask", writable: [] });
  expect(p).toContain("@acha (Acha), another agent working on a task for 张伟 (@zw)");
  expect(p).toContain("This is a read-only run, not a task");
  expect(p).toContain("- 张伟 (@zw): @acha 查一下订单接口");
  expect(p.endsWith("订单接口返回什么格式？")).toBe(true);
});

test("a question is answered in a throwaway worktree; what the run changed is thrown away and said", async () => {
  const W = mkdtempSync(join(tmpdir(), "teamask-")), repo = join(W, "orders");
  sh(W, "git", "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "api.md"), "orders: JSON\n");
  sh(repo, "git", "add", "."); sh(repo, "git", "commit", "-qm", "init");
  const calls: { path: string; body: any }[] = [], seen: RunOptions[] = [];
  const api = async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    return path.endsWith("/claim") ? askClaim(repo) : { state: "answered" };
  };
  const rt: Runtime = {
    name: "codex", available: () => true,
    start(o) {
      seen.push(o);
      writeFileSync(join(o.cwd, "api.md"), "changed\n"); // it should not have
      return { done: Promise.resolve({ session: "", text: "JSON：见 api.md", exitCode: 0, killed: false }), kill: () => {} };
    },
  };
  const w = createWorker({ api: api as any, maxParallel: 2, workRoot: join(W, "work"), runtimes: { codex: rt }, stepEveryMs: 0, log: () => {} });
  w.onAsk({ id: "ask_1", agent_id: "a2", state: "queued" }, () => true);
  await Bun.sleep(1);
  await w.idle();
  expect(seen[0]!.readOnly).toBe(true);
  expect(seen[0]!.cwd).not.toBe(repo);
  expect(seen[0]!.env?.REMI_TOKEN).toBeUndefined(); // no remi: it cannot ask, delegate or hand on
  const answer = calls.find((c) => c.path === "/api/v1/asks/ask_1/answer");
  expect(answer?.body).toEqual({ text: "JSON：见 api.md", discarded: true });
  expect(existsSync(seen[0]!.cwd)).toBe(false);
  expect(sh(repo, "git", "status", "--porcelain").out).toBe("");
  expect(sh(repo, "git", "worktree", "list").out.split("\n").length).toBe(1);

  // not this machine's agent, or not queued: left alone
  calls.length = 0;
  w.onAsk({ id: "ask_2", agent_id: "a9", state: "queued" }, (id) => id === "a2");
  w.onAsk({ id: "ask_3", agent_id: "a2", state: "answered" }, () => true);
  await w.idle();
  expect(calls.length).toBe(0);
  expect(readdirSync(join(W, "work")).filter((n) => n.startsWith("ask-"))).toEqual([]);
  rmSync(W, { recursive: true, force: true });
});
