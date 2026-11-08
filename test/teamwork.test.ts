import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexCommand, codexEvent, type RunOptions, type Runtime } from "../src/runtimes";
import { createWorker, followUpPrompt, gateEnv, parseTaskResult, prepareWorkdir, taskPrompt, type Claim } from "../src/teamwork";

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

test("the result block decides the state; without one the message is the summary", () => {
  expect(parseTaskResult('改好了\n```json\n{"status":"review","summary":"加了索引","pr_title":"orders: index"}\n```')).toMatchObject({ status: "review", summary: "加了索引", pr_title: "orders: index" });
  expect(parseTaskResult('```json\n{"status":"needs_decision","summary":"s","question":"现在上线吗？","options":["A","B"]}\n```')).toMatchObject({ status: "needs_decision", options: ["A", "B"] });
  expect(parseTaskResult('```json\n{"status":"needs_decision","summary":"s"}\n```').status).toBe("blocked"); // no question to ask
  expect(parseTaskResult("看了一下，没问题")).toEqual({ status: "review", summary: "看了一下，没问题" });
  expect(parseTaskResult("").status).toBe("failed");
});

const claim = (over: Partial<Claim["task"]> = {}, agent: Partial<Claim["agent"]> = {}): Claim => ({
  task: { id: "T-0001", channel_id: "c_1", thread_id: "msg_1", agent_id: "a_1", created_by: "u_1", title: "看下慢查询", body: "@acha 看下慢查询",
    state: "running", step: "", summary: "", decision: null, pr: null, branch: "agent/T-0001", session: "", claimed_by: "m_1", runs: 1, ...over },
  agent: { id: "a_1", handle: "acha", name: "阿查", owner_id: "u_2", machine_id: "m_1", runtime: "codex", dispatch: "confirm", autonomy: "assist", ...agent },
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
