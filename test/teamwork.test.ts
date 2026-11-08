import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCommand, claudeEvent, codexCommand, codexEvent, piCommand, piEvent, RUNTIMES, type RunOptions, type Runtime } from "../src/runtimes";
import { createWorker, fetchInputs, reactionOf, followUpPrompt, gateEnv, outFiles, parseCheck, parseTaskResult, prepareWorkdir, seconds, taskPrompt, uploadOut, type Claim, type FileApi } from "../src/teamwork";

const sh = (cwd: string, ...cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  return { ok: p.exitCode === 0, out: (p.stdout.toString() + p.stderr.toString()).trim() };
};

test("codex --json events become the card's steps, the session and the last message", () => {
  expect(codexEvent('{"type":"thread.started","thread_id":"thr_1"}')).toEqual({ kind: "session", id: "thr_1" });
  expect(codexEvent('{"type":"item.started","item":{"type":"command_execution","command":"bash -lc \'bun test\'"}}')).toEqual({ kind: "step", text: "运行 bash -lc 'bun test'" });
  expect(codexEvent('{"type":"item.completed","item":{"type":"command_execution","command":"x"}}')).toBe(null);
  expect(codexEvent('{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"/w/src/orders.ts","kind":"update"}]}}')).toEqual({ kind: "step", text: "改 src/orders.ts" });
  expect(codexEvent('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}')).toEqual({ kind: "message", text: "done" });
  expect(codexEvent('{"type":"turn.failed","error":{"message":"quota"}}')).toEqual({ kind: "error", text: "quota" });
  expect(codexEvent("not json")).toBe(null);
});

test("codex runs sandboxed in the work directory; a later turn resumes its session", () => {
  const first = codexCommand({ cwd: "/w/T-0001", writable: ["/r/.git"] });
  expect(first.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
  expect(first).toContain("workspace-write");
  expect(first.join(" ")).toContain("--cd /w/T-0001 --add-dir /r/.git");
  expect(first.at(-1)).toBe("-");
  expect(codexCommand({ cwd: "/w", resume: "thr_1" }).slice(-3)).toEqual(["resume", "thr_1", "-"]);
});

test("Claude Code: stream-json steps, its session, its result; edits accepted, gates denied, model and resume passed", () => {
  expect(claudeEvent('{"type":"system","subtype":"init","session_id":"s_1"}')).toEqual({ kind: "session", id: "s_1" });
  expect(claudeEvent('{"type":"assistant","message":{"content":[{"type":"text","text":"hm"},{"type":"tool_use","name":"Bash","input":{"command":"bun test"}}]}}'))
    .toEqual([{ kind: "message", text: "hm" }, { kind: "step", text: "运行 bun test" }]);
  expect(claudeEvent('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/w/src/orders.ts"}}]}}'))
    .toEqual([{ kind: "step", text: "改 src/orders.ts" }]);
  expect(claudeEvent('{"type":"assistant","parent_tool_use_id":"t1","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"x"}}]}}')).toBe(null);
  expect(claudeEvent('{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s_1"}'))
    .toEqual([{ kind: "session", id: "s_1" }, { kind: "message", text: "done" }]);
  expect(claudeEvent('{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"s_1"}'))
    .toEqual([{ kind: "session", id: "s_1" }, { kind: "error", text: "error_max_turns" }]);
  const cmd = claudeCommand({ writable: ["/r/.git"], model: "sonnet", resume: "s_1" });
  expect(cmd.slice(0, 5)).toEqual(["claude", "-p", "--output-format", "stream-json", "--verbose"]);
  expect(cmd.join(" ")).toContain("--permission-mode acceptEdits");
  expect(cmd).toContain("Bash(git push --force:*)");
  expect(cmd.join(" ")).toContain("--add-dir /r/.git --model sonnet --resume s_1");
  expect(claudeCommand({}).join(" ")).not.toContain("--model");
});

test("pi: json mode steps, session and last message; model and session passed", () => {
  expect(piEvent('{"type":"session","version":3,"id":"0199-ab","cwd":"/w"}')).toEqual({ kind: "session", id: "0199-ab" });
  expect(piEvent('{"type":"tool_execution_start","toolCallId":"1","toolName":"bash","args":{"command":"go test ./..."}}')).toEqual({ kind: "step", text: "运行 go test ./..." });
  expect(piEvent('{"type":"tool_execution_start","toolCallId":"2","toolName":"edit","args":{"path":"/w/a/b.go"}}')).toEqual({ kind: "step", text: "改 a/b.go" });
  expect(piEvent('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"好了"}],"stopReason":"stop"}}')).toEqual({ kind: "message", text: "好了" });
  expect(piEvent('{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"x"}]}}')).toBe(null);
  expect(piEvent('{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"No API key"}}')).toEqual({ kind: "error", text: "No API key" });
  expect(piCommand({ model: "anthropic/claude-sonnet-5-5", resume: "0199-ab" })).toEqual(["pi", "-p", "--mode", "json", "--model", "anthropic/claude-sonnet-5-5", "--session", "0199-ab"]);
  expect(Object.keys(RUNTIMES)).toEqual(["codex", "claude", "pi"]);
});

test("the result block decides the state; without one the message is the summary", () => {
  expect(parseTaskResult('改好了\n```json\n{"status":"review","summary":"加了索引","pr_title":"orders: index"}\n```')).toMatchObject({ status: "review", summary: "加了索引", pr_title: "orders: index" });
  expect(parseTaskResult('```json\n{"status":"needs_decision","summary":"s","question":"现在上线吗？","options":["A","B"]}\n```')).toMatchObject({ status: "needs_decision", options: ["A", "B"] });
  expect(parseTaskResult('```json\n{"status":"needs_decision","summary":"s"}\n```').status).toBe("blocked"); // no question to ask
  expect(parseTaskResult("看了一下，没问题")).toEqual({ status: "review", summary: "看了一下，没问题" });
  expect(parseTaskResult("").status).toBe("failed");
  expect(parseTaskResult("react: 🔍\n看了一下，没问题")).toEqual({ status: "review", summary: "看了一下，没问题" });
});

test("the agent's first word is an emoji for how it read the request; it goes to the server once", async () => {
  expect(reactionOf("react: 🔍")).toBe("🔍");
  expect(reactionOf("好的\nreact:🛠️\n开始")).toBe("🛠️");
  expect(reactionOf("react: ok")).toBe("");
  expect(reactionOf("react: 🔍 查一下")).toBe("");
  expect(reactionOf("没有")).toBe("");
  expect(taskPrompt(claim(), { cwd: "/w", writable: [] })).toContain("react: <one emoji>");
  expect(followUpPrompt(claim())).toContain("react: <one emoji>");

  const W = mkdtempSync(join(tmpdir(), "teamwork-"));
  const seen: RunOptions[] = [], calls: { path: string; body: any }[] = [];
  const rt: Runtime = {
    name: "codex", available: () => true,
    start(o) {
      seen.push(o);
      o.onEvent?.({ kind: "message", text: "react: 🔍" });
      o.onEvent?.({ kind: "message", text: "react: 🐛" });
      return { done: Promise.resolve({ session: "thr_9", text: '```json\n{"status":"review","summary":"7 个"}\n```', exitCode: 0, killed: false }), kill: () => {} };
    },
  };
  const w = createWorker({ api: fakeApi({ "T-0001": claim() }, calls), maxParallel: 1, workRoot: W, runtimes: { codex: rt }, stepEveryMs: 0, log: () => {} });
  w.onTask({ ...claim().task, state: "queued" } as any, () => true);
  await Bun.sleep(1);
  await w.idle();
  expect(calls.filter((c) => c.body?.reaction).map((c) => c.body.reaction)).toEqual(["🔍"]);
  rmSync(W, { recursive: true, force: true });
});

const claim = (over: Partial<Claim["task"]> = {}, agent: Partial<Claim["agent"]> = {}): Claim => ({
  task: { id: "T-0001", channel_id: "c_1", thread_id: "msg_1", agent_id: "a_1", created_by: "u_1", title: "看下慢查询", body: "@acha 看下慢查询",
    state: "running", step: "", summary: "", decision: null, pr: null, branch: "agent/T-0001", session: "", claimed_by: "m_1", runs: 1, ...over },
  agent: { id: "a_1", handle: "acha", name: "阿查", owner_id: "u_2", machine_id: "m_1", runtime: "codex", dispatch: "channel", autonomy: "assist", ...agent },
  channel: { id: "c_1", name: "支付后端", topic: "订单服务" },
  recent: [{ id: "msg_1", seq: 1, channel_id: "c_1", thread_id: null, author: { kind: "user", id: "u_1" }, text: "@acha 看下慢查询", mentions: [], created: 0 }],
  thread: [{ id: "msg_1", seq: 1, channel_id: "c_1", thread_id: null, author: { kind: "user", id: "u_1" }, text: "@acha 看下慢查询", mentions: [], created: 0 }],
  new: [{ id: "msg_3", seq: 3, channel_id: "c_1", thread_id: "msg_1", author: { kind: "user", id: "u_1" }, text: "顺便看 /refunds", mentions: [], created: 0 }],
  names: { u_1: "张伟 (@zhangwei)" }, creator: { name: "张伟", handle: "zhangwei" }, resumed: false,
});

test("prompts: the first turn has the channel, the task and the rules; a later one only what is new", () => {
  const p = taskPrompt(claim(), { cwd: "/w/T-0001", repo: "/r", branch: "agent/T-0001", writable: [] });
  expect(p).toContain("阿查 (@acha)");
  expect(p).toContain("# Channel #支付后端");
  expect(p).toContain("Purpose: 订单服务");
  expect(p).toContain("- 张伟 (@zhangwei): @acha 看下慢查询");
  expect(p).toContain("Never push");
  expect(p).toContain('"status": "review" | "needs_decision" | "blocked" | "failed"');
  expect(p).toContain("(none given: decide sensible criteria");
  const m = taskPrompt(claim({ acceptance: "P99 < 100ms", mandate: { by: "u_1", rule: "team", confirm: true, autonomy: "cautious", branch: "agent/T-0001", runtime: "codex" } }),
    { cwd: "/w/T-0001", writable: [] });
  expect(m).toContain("# Acceptance criteria\nP99 < 100ms");
  expect(m).toContain("Mandate: anyone in the team may hand you work; your owner confirmed this task. Autonomy cautious:");
  expect(parseTaskResult('```json\n{"status":"review","summary":"s","acceptance":"- 不锁表"}\n```').acceptance).toBe("- 不锁表");
  const mem = taskPrompt(claim({ repo: "github.com/acme/pay" }, { memory: "- orders 表很大" }), { cwd: "/w/T-0001", repo: "/r", branch: "agent/T-0001", writable: [] });
  expect(mem).toContain("# Your memory (memory.md)\n- orders 表很大");
  expect(mem).toContain("Repository: github.com/acme/pay");
  expect(p).toContain("# Your memory (memory.md)\n(empty)");
  expect(parseTaskResult('```json\n{"status":"review","summary":"s","memory":"- 新的"}\n```').memory).toBe("- 新的");
  const f = followUpPrompt(claim());
  expect(f).toContain("顺便看 /refunds");
  expect(f).not.toContain("# Channel");
});

test("a task gets its own worktree on agent/T-xxxx, and the agent's git cannot push", async () => {
  const W = realpathSync(mkdtempSync(join(tmpdir(), "teamwork-"))); // macOS: /var → /private/var, as git reports it
  try {
    const origin = join(W, "origin.git"), repo = join(W, "repo");
    sh(W, "git", "init", "-q", "--bare", "-b", "main", origin);
    sh(W, "git", "clone", "-q", origin, repo);
    writeFileSync(join(repo, "a.txt"), "a\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-qm", "init");
    sh(repo, "git", "push", "-q", "origin", "HEAD:main");
    sh(repo, "git", "remote", "set-head", "origin", "main");

    const wd = await prepareWorkdir(claim({}, { repo }), join(W, "work"));
    expect(wd.cwd).toBe(join(W, "work", "T-0001"));
    expect(wd.branch).toBe("agent/T-0001");
    expect(wd.base).toBe("origin/main");
    expect(sh(wd.cwd, "git", "rev-parse", "--abbrev-ref", "HEAD").out).toBe("agent/T-0001");
    expect(wd.writable[0]).toBe(join(repo, ".git"));
    expect((await prepareWorkdir(claim({}, { repo }), join(W, "work"))).cwd).toBe(wd.cwd); // the next turn: same place

    writeFileSync(join(wd.cwd, "b.txt"), "b\n");
    sh(wd.cwd, "git", "add", ".");
    sh(wd.cwd, "git", "commit", "-qm", "agent change");
    const env = gateEnv(wd);
    const blocked = Bun.spawnSync(["git", "push", "origin", "agent/T-0001"], { cwd: wd.cwd, env: { ...process.env, ...env } });
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.stderr.toString()).toContain("no-push");
    expect(sh(origin, "git", "branch", "--list").out).not.toContain("agent/T-0001");
    expect(sh(wd.cwd, "git", "push", "-q", "origin", "agent/T-0001").ok).toBe(true); // the daemon's own push

    await expect(prepareWorkdir(claim({}, { repo: join(W, "nope") }), join(W, "work2"))).rejects.toThrow("不存在");

    // the task's own repository comes first: the machine finds (or clones) it; the agent's path is only a fallback
    const asked: string[] = [];
    const own = await prepareWorkdir(claim({ id: "T-0002", branch: "agent/T-0002", repo: "github.com/acme/pay" }, { repo: join(W, "nope") }), join(W, "work"),
      async (remote) => { asked.push(remote); return repo; });
    expect(asked).toEqual(["github.com/acme/pay"]);
    expect(own.repo).toBe(repo);
    expect(own.branch).toBe("agent/T-0002");
    await expect(prepareWorkdir(claim({ id: "T-0003", repo: "github.com/acme/x" }), join(W, "work"), async () => { throw new Error("克隆也失败了"); }))
      .rejects.toThrow("克隆也失败了");
    const general = await prepareWorkdir(claim({ id: "T-0004" }), join(W, "work"));
    expect(general).toEqual({ cwd: join(W, "work", "T-0004"), writable: [], files: join(W, "work", "T-0004") });
    expect(own.files).toBe(join(W, "work", "T-0002.files"));
    expect(own.writable).toContain(own.files!);
  } finally {
    rmSync(W, { recursive: true, force: true });
  }
});

/** A runtime that plays a script: events, then a final message. */
function fakeRuntime(turns: { events?: string[]; text: string; hang?: boolean }[], seen: RunOptions[]): Runtime {
  return {
    name: "codex",
    available: () => true,
    start(o) {
      seen.push(o);
      const turn = turns[seen.length - 1] ?? turns.at(-1)!;
      let kill = () => {};
      const done = new Promise<any>((res) => {
        kill = () => res({ session: "thr_9", text: "", exitCode: 143, killed: true });
        if (turn.hang) return;
        setTimeout(() => {
          for (const line of turn.events ?? []) { const e = codexEvent(line); if (e) o.onEvent?.(e); }
          res({ session: o.resume || "thr_9", text: turn.text, exitCode: 0, killed: false });
        }, 5);
      });
      return { done, kill: () => kill() };
    },
  };
}

function fakeApi(claims: Record<string, Claim>, log: { path: string; body: any }[]) {
  return async (path: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    log.push({ path, body });
    const m = path.match(/^\/api\/v1\/tasks\/([^/]+)\/claim$/);
    if (m) { const c = claims[m[1]]; delete claims[m[1]]; return c ?? null; }
    if (path === "/api/v1/machine/tasks") return { tasks: [] };
    return {};
  };
}

test("the worker claims a queued task, shows its steps, and reports the result once", async () => {
  const W = mkdtempSync(join(tmpdir(), "teamwork-"));
  const seen: RunOptions[] = [], calls: { path: string; body: any }[] = [];
  const rt = fakeRuntime([{
    events: ['{"type":"thread.started","thread_id":"thr_9"}', '{"type":"item.started","item":{"type":"command_execution","command":"bun test"}}'],
    text: '```json\n{"status":"needs_decision","summary":"要锁表 30 秒","question":"现在上吗？","options":["A: 现在","B: 夜里"],"recommendation":"B"}\n```',
  }], seen);
  const w = createWorker({ api: fakeApi({ "T-0001": claim() }, calls), maxParallel: 2, workRoot: W, runtimes: { codex: rt }, stepEveryMs: 0, log: () => {} });
  w.onTask(claim().task as any, () => false);
  expect(calls.length).toBe(0); // not this machine's agent
  w.onTask({ ...claim().task, state: "queued" } as any, () => true);
  await Bun.sleep(1);
  await w.idle();
  expect(seen.length).toBe(1);
  expect(seen[0].cwd).toBe(join(W, "T-0001"));
  expect(seen[0].prompt).toContain("# Task T-0001: 看下慢查询");
  expect(seen[0].env?.GH_TOKEN).toBe("");
  const reports = calls.filter((c) => c.path === "/api/v1/tasks/T-0001/report").map((c) => c.body);
  expect(reports).toContainEqual({ session: "thr_9", branch: "" });
  expect(reports).toContainEqual({ step: "运行 bun test" });
  expect(reports.at(-1)).toEqual({ state: "needs_decision", summary: "要锁表 30 秒", session: "thr_9",
    decision: { question: "现在上吗？", options: ["A: 现在", "B: 夜里"], recommendation: "B" } });
  rmSync(W, { recursive: true, force: true });
});

test("the next turn resumes the session with what is new; a cancel stops a run; review runs afterRun", async () => {
  const W = mkdtempSync(join(tmpdir(), "teamwork-"));
  const seen: RunOptions[] = [], calls: { path: string; body: any }[] = [];
  const rt = fakeRuntime([{ text: '```json\n{"status":"review","summary":"/refunds 也好了"}\n```' }, { text: "", hang: true }], seen);
  const after: string[] = [];
  const w = createWorker({
    api: fakeApi({ "T-0001": claim({ session: "thr_9", runs: 2 }), "T-0002": claim({ id: "T-0002" }) }, calls), maxParallel: 2, workRoot: W,
    runtimes: { codex: rt }, log: () => {},
    afterRun: async (c, r) => { after.push(`${c.task.id}:${r.status}`); return { pr: { provider: "github", url: "https://github.com/a/b/pull/7", number: 7, state: "open", checks: "pending" } }; },
  });
  w.onTask({ ...claim().task, state: "queued" } as any, () => true);
  await Bun.sleep(1);
  await w.idle();
  expect(seen[0].resume).toBe("thr_9");
  expect(seen[0].prompt).toContain("顺便看 /refunds");
  expect(seen[0].prompt).not.toContain("# Channel");
  expect(after).toEqual(["T-0001:review"]);
  const last = calls.filter((c) => c.path === "/api/v1/tasks/T-0001/report").at(-1)!.body;
  expect(last.pr.number).toBe(7);
  expect(last.summary).toBe("/refunds 也好了\n\nPR：https://github.com/a/b/pull/7");

  w.onTask({ ...claim().task, id: "T-0002", state: "queued" } as any, () => true);
  await Bun.sleep(30);
  expect(w.running()).toEqual(["T-0002"]);
  w.onTask({ ...claim().task, id: "T-0002", state: "closed" } as any, () => true);
  await w.idle();
  expect(calls.filter((c) => c.path === "/api/v1/tasks/T-0002/report" && c.body.state)).toEqual([]); // cancelled: nothing to report
  rmSync(W, { recursive: true, force: true });
});

test("no runtime on this machine: the task is blocked with what to do", async () => {
  const calls: { path: string; body: any }[] = [];
  const w = createWorker({ api: fakeApi({ "T-0001": claim() }, calls), maxParallel: 1, runtimes: { codex: { name: "codex", available: () => false, start: () => { throw new Error("no"); } } }, log: () => {} });
  w.onTask({ ...claim().task, state: "queued" } as any, () => true);
  await Bun.sleep(1);
  await w.idle();
  expect(calls.at(-2)?.body.state).toBe("blocked");
  expect(calls.at(-2)?.body.summary).toContain("没有 codex");
});

test("the agent's runtime and model run the task; criteria the agent chose go back when people gave none", async () => {
  const W = mkdtempSync(join(tmpdir(), "teamwork-"));
  const seen: RunOptions[] = [], calls: { path: string; body: any }[] = [];
  const rt = fakeRuntime([{ text: '```json\n{"status":"review","summary":"好了","acceptance":"- P99 < 200ms"}\n```' }], seen);
  const w = createWorker({
    api: fakeApi({ "T-0001": claim({}, { runtime: "pi", model: "openai/gpt-5.5" }), "T-0002": claim({ id: "T-0002", acceptance: "人写的" }, { runtime: "pi" }) }, calls),
    maxParallel: 2, workRoot: W, runtimes: { pi: { ...rt, name: "pi" } }, stepEveryMs: 0, log: () => {},
  });
  w.onTask({ ...claim().task, state: "queued" } as any, () => true);
  w.onTask({ ...claim().task, id: "T-0002", state: "queued" } as any, () => true);
  await Bun.sleep(1);
  await w.idle();
  expect(seen.map((o) => o.model).sort()).toEqual([undefined, "openai/gpt-5.5"].sort() as any);
  const last = (id: string) => calls.filter((c) => c.path === `/api/v1/tasks/${id}/report`).at(-1)!.body;
  expect(last("T-0001").acceptance).toBe("- P99 < 200ms");
  expect(last("T-0002").acceptance).toBeUndefined();
  rmSync(W, { recursive: true, force: true });
});

test("a run that changed nothing is an answer: done without acceptance; files, PRs or an unconfirmed result still go to review", async () => {
  const W = mkdtempSync(join(tmpdir(), "teamwork-"));
  const seen: RunOptions[] = [], calls: { path: string; body: any }[] = [];
  const rt = fakeRuntime([
    { text: '```json\n{"status":"review","summary":"7 个开放 PR","result":"confirmed"}\n```' },
    { text: '```json\n{"status":"review","summary":"报告在 out/ 里"}\n```' },
    { text: '```json\n{"status":"review","summary":"已提交，结果明天出","result":"unconfirmed"}\n```' },
  ], seen);
  const ids = ["T-0001", "T-0002", "T-0003"];
  const w = createWorker({
    api: fakeApi(Object.fromEntries(ids.map((id) => [id, claim({ id })])), calls), maxParallel: 1, workRoot: W,
    runtimes: { codex: { ...rt, start(o) { if (o.cwd.endsWith("T-0002")) writeFileSync(join(o.cwd, "out", "report.md"), "# r"); return rt.start(o); } } },
    stepEveryMs: 0, log: () => {},
  });
  for (const id of ids) {
    w.onTask({ ...claim().task, id, state: "queued" } as any, () => true);
    await Bun.sleep(1);
    await w.idle();
  }
  const last = (id: string) => calls.filter((c) => c.path === `/api/v1/tasks/${id}/report` && c.body.state).at(-1)!.body;
  expect(last("T-0001").answer).toBe(true);
  expect(last("T-0002").answer).toBeUndefined();
  expect(last("T-0003").answer).toBeUndefined();
  rmSync(W, { recursive: true, force: true });
});

test("out/ goes to the thread (new or changed files only); the thread's attachments come into in/", async () => {
  const D = realpathSync(mkdtempSync(join(tmpdir(), "teamfiles-")));
  mkdirSync(join(D, "in"), { recursive: true });
  mkdirSync(join(D, "out", "data"), { recursive: true });
  writeFileSync(join(D, "out", "report.md"), "# v1");
  writeFileSync(join(D, "out", "data", "a.csv"), "a,b");
  writeFileSync(join(D, "out", ".draft"), "x");
  expect(outFiles(join(D, "out"))).toEqual(["data/a.csv", "report.md"]);
  const sent: string[] = [];
  const files: FileApi = {
    upload: async (_t, name, data) => { sent.push(`${name}=${new TextDecoder().decode(data)}`); return name !== "bad.txt"; },
    preview: async () => true,
    download: async (p) => (p === "/media/1-photo.png" ? new TextEncoder().encode("PNG") : null),
  };
  expect(await uploadOut(files, "T-0001", D)).toEqual([]);
  expect(sent).toEqual(["data/a.csv=a,b", "report.md=# v1"]);
  writeFileSync(join(D, "out", "report.md"), "# v2");
  writeFileSync(join(D, "out", "bad.txt"), "?");
  expect(await uploadOut(files, "T-0001", D)).toEqual(["bad.txt 上传失败"]);
  expect(sent.slice(2)).toEqual(["bad.txt=?", "report.md=# v2"]); // a.csv did not change

  const c = claim();
  c.thread[0]!.attachments = ["/media/1-photo.png", "/media/gone.png"];
  await fetchInputs(files, c, D);
  expect(readFileSync(join(D, "in", "1-photo.png"), "utf8")).toBe("PNG");
  rmSync(D, { recursive: true, force: true });
});

test("prompts tell where inputs are and where outputs go; external results come back in the result", () => {
  const p = taskPrompt(claim(), { cwd: "/w/T-0001", writable: [], files: "/w/T-0001" });
  expect(p).toContain("Files people attached to the thread are in /w/T-0001/in");
  expect(p).toContain("/w/T-0001/out: every file there is uploaded to the thread");
  const r = parseTaskResult('```json\n{"status":"review","summary":"s","outputs":[{"kind":"external","title":"底座模型","external_id":"job-1","status":"pending"}]}\n```');
  expect(r.outputs).toEqual([{ kind: "external", title: "底座模型", external_id: "job-1", status: "pending" }]);
});

test("waiting: the run ends with what wakes it; the machine runs the check; a cancel cancels the outside job; the woken turn is told why", async () => {
  const W = realpathSync(mkdtempSync(join(tmpdir(), "teamwait-")));
  const seen: RunOptions[] = [], calls: { path: string; body: any }[] = [];
  const rt = fakeRuntime([
    { text: '已提交\n```json\n{"status":"waiting","summary":"已提交云端建模","outputs":[{"kind":"external","title":"底座模型","external_id":"job-1","status":"pending"}],"wait":{"how":"poll","check":"echo \'{\\"state\\":\\"pending\\",\\"note\\":\\"排队第 2\\"}\'","every":"5m","deadline":"6h","cancel":"echo cancelled > cancelled.txt"}}\n```' },
    { text: '```json\n{"status":"review","summary":"模型好了","result":"confirmed"}\n```' },
  ], seen);
  const api = fakeApi({ "T-0001": { ...claim(), callback_url: "http://hub/api/v1/hooks/wait/abc" } }, calls);
  const w = createWorker({ api: async (p, i) => (p === "/api/v1/machine/tasks?waiting=1" ? { tasks: [{ ...claim().task, state: "waiting", wait: { next_at: 0 } }] } : api(p, i)), maxParallel: 1, workRoot: W, runtimes: { codex: rt }, log: () => {} });
  w.onTask({ ...claim().task, state: "queued" } as any, () => true);
  await Bun.sleep(1);
  await w.idle();
  expect(seen[0].prompt).toContain("Callback address for outside services (a POST there wakes you while you wait; it may not be reachable from the internet): http://hub/api/v1/hooks/wait/abc");
  const reports = calls.filter((c) => c.path === "/api/v1/tasks/T-0001/report" && (c.body.state || c.body.outputs)).map((c) => c.body);
  expect(reports[0]).toEqual({ outputs: [{ kind: "external", title: "底座模型", external_id: "job-1", status: "pending" }] });
  expect(reports[1]).toMatchObject({ state: "waiting", wait: { how: "poll", every: 300, expect: 0, deadline: 21600, what: "" } });

  await w.checkWaits();
  await Bun.sleep(100);
  expect(calls.filter((c) => c.path === "/api/v1/tasks/T-0001/wait").map((c) => c.body)).toEqual([{ state: "pending", note: "排队第 2" }]);

  // woken: the next turn says why
  const api2 = fakeApi({ "T-0001": { ...claim({ session: "thr_1" }), wake: { reason: "done", note: "模型好了", at: 1 } } }, calls);
  const w2 = createWorker({ api: api2, maxParallel: 1, workRoot: W, runtimes: { codex: rt }, log: () => {} });
  w2.onTask({ ...claim().task, state: "queued" } as any, () => true);
  await Bun.sleep(1);
  await w2.idle();
  expect(seen[1].prompt).toContain("you are woken because your check command says the outside job is done");
  expect(seen[1].prompt).toContain("Last note: 模型好了");
  expect(calls.filter((c) => c.path === "/api/v1/tasks/T-0001/report" && c.body.state).at(-1)!.body).toMatchObject({ state: "review", result: "confirmed" });

  // cancelled: the outside job too, once
  w.onTask({ ...claim().task, state: "closed" } as any, () => true);
  await Bun.sleep(200);
  expect(readFileSync(join(W, "T-0001", "cancelled.txt"), "utf8").trim()).toBe("cancelled");
  rmSync(W, { recursive: true, force: true });
});

test("waiting results: a wait with no way to wake is not a wait; durations; check output", () => {
  expect(parseTaskResult('```json\n{"status":"waiting","summary":"s"}\n```')).toMatchObject({ status: "review", result: "unconfirmed" });
  expect(parseTaskResult('```json\n{"status":"waiting","summary":"s","wait":{"how":"poll"}}\n```').wait!.how).toBe("timer"); // nothing to run
  expect([seconds("90s"), seconds("5m"), seconds("2h"), seconds("1d"), seconds(30), seconds("soon")]).toEqual([90, 300, 7200, 86400, 30, 0]);
  expect(parseCheck('working…\n{"state":"done","note":"ok"}')).toEqual({ state: "done", note: "ok" });
  expect(parseCheck("nothing")).toBe(null);
});
