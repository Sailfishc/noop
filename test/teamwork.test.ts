import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCommand, claudeEvent, claudeMcpServers, codexCommand, codexEvent, piCommand, piEvent, RUNTIMES, type RunOptions, type Runtime } from "../src/runtimes";
import { wakePrompt } from "../src/teamwork";
import { cliEnv, createWorker, fetchInputs, reactionOf, taskClaimOf, followUpPrompt, gateEnv, outFiles, parseCheck, parseTaskResult, prepareWorkdir, seconds, taskPrompt, uploadOut, type Claim, type FileApi } from "../src/teamwork";

const sh = (cwd: string, ...cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  return { ok: p.exitCode === 0, out: (p.stdout.toString() + p.stderr.toString()).trim() };
};

test("codex --json events become the card's steps, the session and the last message", () => {
  expect(codexEvent('{"type":"thread.started","thread_id":"thr_1"}')).toEqual({ kind: "session", id: "thr_1" });
  expect(codexEvent('{"type":"item.started","item":{"type":"command_execution","command":"bash -lc \'bun test\'"}}')).toEqual({ kind: "step", text: "运行 bash -lc 'bun test'" });
  expect(codexEvent('{"type":"item.completed","item":{"type":"command_execution","command":"x"}}')).toEqual({ kind: "idle" });
  expect(codexEvent('{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"/w/src/orders.ts","kind":"update"}]}}')).toEqual([{ kind: "step", text: "改 src/orders.ts" }, { kind: "idle" }]);
  expect(claudeEvent('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}')).toEqual({ kind: "idle" });
  expect(piEvent('{"type":"tool_execution_end","toolCallId":"1"}')).toEqual({ kind: "idle" });
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
  const allowed = (c: string[]) => c[c.indexOf("--allowedTools") + 1]!.split(",");
  expect(allowed(claudeCommand({}))).toContain("Skill");
  expect(allowed(claudeCommand({ mcp: ["mcp__github"] }))).toContain("mcp__github");
});

test("Claude Code: the machine's MCP servers are allowed by name (user, local to the folder or above it, the repository's)", () => {
  const home = mkdtempSync(join(tmpdir(), "remi-home-")), repo = join(home, "work", "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { github: {}, "plugin:x y": {} },
    projects: { [join(home, "work")]: { mcpServers: { jira: {} } }, [join(home, "other")]: { mcpServers: { nope: {} } } } }));
  writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { docs: {} } }));
  expect(claudeMcpServers(repo, home)).toEqual(["mcp__docs", "mcp__github", "mcp__jira", "mcp__plugin_x_y"]);
  expect(claudeMcpServers(join(home, "none"), join(home, "missing"))).toEqual([]);
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
  const withFile = claim();
  withFile.thread[0]!.attachments = ["/media/1730000000-ab12cd34-spec.pdf"];
  expect(taskPrompt(withFile, { cwd: "/w", writable: [] })).toContain("[attached, in your in/ folder: 1730000000-ab12cd34-spec.pdf]");

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

test("a request the agent has to act on: it claims it as a task with a \"task:\" line, once", async () => {
  expect(taskClaimOf("react: 🛠️\ntask: 给 orders 加索引")).toBe("给 orders 加索引");
  expect(taskClaimOf("react: 🔍")).toBe(null);
  expect(taskPrompt(claim(), { cwd: "/w", writable: [] })).toContain("task: <a short title");
  expect(parseTaskResult("react: 🛠️\ntask: 加索引\n加好了").summary).toBe("加好了");

  const W = mkdtempSync(join(tmpdir(), "teamwork-"));
  const calls: { path: string; body: any }[] = [];
  const rt: Runtime = {
    name: "codex", available: () => true,
    start(o) {
      o.onEvent?.({ kind: "message", text: "react: 🛠️\ntask: 加索引" });
      o.onEvent?.({ kind: "message", text: "task: 另一个" });
      return { done: Promise.resolve({ session: "thr_9", text: '```json\n{"status":"review","summary":"加好了"}\n```', exitCode: 0, killed: false }), kill: () => {} };
    },
  };
  const w = createWorker({ api: fakeApi({ "T-0001": claim() }, calls), maxParallel: 1, workRoot: W, runtimes: { codex: rt }, stepEveryMs: 0, log: () => {} });
  w.onTask({ ...claim().task, state: "queued" } as any, () => true);
  await Bun.sleep(1);
  await w.idle();
  expect(calls.filter((c) => c.body?.track).map((c) => c.body.title)).toEqual(["加索引"]);
  rmSync(W, { recursive: true, force: true });
});

test("the agent's remi command (also installed as teamagent) asks the server with the run's read token, words and flags encoded", async () => {
  const W = mkdtempSync(join(tmpdir(), "teamwork-"));
  const seen: { path: string; query: Record<string, string>; auth: string | null }[] = [];
  const srv = Bun.serve({ port: 0, fetch(r) {
    const u = new URL(r.url);
    seen.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), auth: r.headers.get("authorization") });
    return new Response("[#支付后端 msg=msg_1] ok\n");
  } });
  const env = { ...process.env, ...cliEnv(W, `http://127.0.0.1:${srv.port}/`, "rt_abc") };
  const run = async (...args: string[]) => {
    const p = Bun.spawn(["remi", ...args], { env, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  };
  expect(await run("search", "慢 查询", "--channel", "#支付 后端")).toContain("msg=msg_1");
  await run("read", "--thread", "msg_9", "--limit", "5");
  await run("task", "T-0003");
  srv.stop(true);
  expect(seen).toEqual([
    { path: "/api/v1/agent/search", query: { channel: "#支付 后端", q: "慢 查询" }, auth: "Bearer rt_abc" },
    { path: "/api/v1/agent/read", query: { thread: "msg_9", limit: "5" }, auth: "Bearer rt_abc" },
    { path: "/api/v1/agent/tasks/T-0003", query: {}, auth: "Bearer rt_abc" },
  ]);
  const help = Bun.spawn(["remi"], { env, stdout: "pipe" });
  expect(await new Response(help.stdout).text()).toContain("remi search WORDS");
  const old = Bun.spawn(["teamagent"], { env, stdout: "pipe" }); // its first name keeps working
  expect(await new Response(old.stdout).text()).toContain("remi search WORDS");
  expect(taskPrompt({ ...claim(), read_token: "rt_abc" }, { cwd: "/w", writable: [] })).toContain("remi read --thread MSG");
  const listed = taskPrompt({ ...claim(), read_token: "rt_abc", agents: "@bei (贝): 写测试 [can take work now; 0 running; no card; in this channel]\n" }, { cwd: "/w", writable: [] });
  expect(listed).toContain("# Other agents you may turn to\n@bei (贝)");
  expect(taskPrompt({ ...claim(), read_token: "rt_abc", agents: "" }, { cwd: "/w", writable: [] })).not.toContain("# Other agents you may turn to");
  expect(taskPrompt(claim(), { cwd: "/w", writable: [] })).not.toContain("# Looking things up");
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

test("ended tasks' folders go after a week, their branches stay", async () => {
  const W = realpathSync(mkdtempSync(join(tmpdir(), "teamwork-")));
  try {
    const repo = join(W, "repo"), work = join(W, "work");
    sh(W, "git", "init", "-q", "-b", "main", repo);
    writeFileSync(join(repo, "a.txt"), "a\n");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-qm", "init");
    const done = await prepareWorkdir(claim({ id: "T-0001" }, { repo }), work);
    writeFileSync(join(done.cwd, "b.txt"), "b\n");
    sh(done.cwd, "git", "add", ".");
    sh(done.cwd, "git", "commit", "-qm", "agent change");
    writeFileSync(join(done.cwd, "half.txt"), "not committed\n");
    const open = await prepareWorkdir(claim({ id: "T-0002", branch: "agent/T-0002" }, { repo }), work);
    const general = await prepareWorkdir(claim({ id: "T-0003" }), work);
    writeFileSync(join(general.cwd, "out", "r.md"), "r");

    const asked: string[] = [];
    const api = async (path: string) => {
      asked.push(path);
      return { tasks: [{ id: "T-0001" }, { id: "T-0003" }, { id: "T-0009" }] }; // T-0009: not on this machine
    };
    const w = createWorker({ api, maxParallel: 1, workRoot: work, runtimes: {}, log: () => {} });
    expect(await w.sweep()).toEqual(["T-0001", "T-0003"]);
    expect(asked).toEqual(["/api/v1/machine/tasks?ended=T-0001,T-0002,T-0003"]);
    expect(existsSync(done.cwd)).toBe(false);
    expect(existsSync(join(work, "T-0001.files"))).toBe(false);
    expect(existsSync(general.cwd)).toBe(false);
    expect(existsSync(open.cwd)).toBe(true);
    expect(sh(repo, "git", "worktree", "list").out).not.toContain("T-0001");
    expect(sh(repo, "git", "log", "-1", "--format=%s", "agent/T-0001").out).toBe("agent change");
    // picked up again: the worktree comes back on its branch
    const again = await prepareWorkdir(claim({ id: "T-0001", branch: "agent/T-0001" }, { repo }), work);
    expect(sh(again.cwd, "git", "log", "-1", "--format=%s").out).toBe("agent change");
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
          for (const line of turn.events ?? []) { const e = codexEvent(line); for (const x of e ? (Array.isArray(e) ? e : [e]) : []) o.onEvent?.(x); }
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
    path = path.replace(/[?&]moves=\d+$/, ""); // the run's fence (checkpoint.test.ts checks it)
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
  expect(seen[0].prompt).toContain("# Request T-0001: 看下慢查询");
  expect(seen[0].env?.GH_TOKEN).toBe("");
  const reports = calls.filter((c) => c.path === "/api/v1/tasks/T-0001/report").map((c) => c.body);
  expect(reports).toContainEqual({ session: "thr_9", branch: "" });
  expect(reports).toContainEqual({ step: "运行 bun test" });
  expect(reports.at(-1)).toEqual({ state: "needs_decision", summary: "要锁表 30 秒", session: "thr_9", run: 1,
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

test("news while it runs: the run stops after the tool call in flight and the same session goes on with it", async () => {
  const W = mkdtempSync(join(tmpdir(), "teamwork-"));
  const seen: RunOptions[] = [], calls: { path: string; body: any }[] = [];
  const kills: string[] = [];
  const rt: Runtime = {
    name: "codex", available: () => true,
    start(o) {
      seen.push(o);
      const n = seen.length;
      let kill = () => {};
      const done = new Promise<any>((res) => {
        kill = () => { kills.push(`turn ${n}`); res({ session: "thr_9", text: "", exitCode: 143, killed: true }); };
        if (n === 1) { // a tool call that takes a while, then the agent would go on (it hangs until stopped)
          o.onEvent?.({ kind: "session", id: "thr_9" });
          o.onEvent?.({ kind: "step", text: "运行 bun test" });
          setTimeout(() => o.onEvent?.({ kind: "idle" }), 40);
          return;
        }
        setTimeout(() => res({ session: "thr_9", text: '```json\n{"status":"review","summary":"按你说的没动索引"}\n```', exitCode: 0, killed: false }), 5);
      });
      return { done, kill: () => kill() };
    },
  };
  const claims = [claim(), claim({ news: false }, {})];
  claims[1]!.new = [{ id: "msg_4", seq: 4, channel_id: "c_1", thread_id: "msg_1", author: { kind: "user", id: "u_1" }, text: "先别动索引", mentions: [], created: 0 }];
  const api = async (path: string, init: RequestInit = {}) => {
    calls.push({ path: path.replace(/[?&]moves=\d+$/, ""), body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (path.endsWith("/claim")) return claims.shift() ?? null;
    return path === "/api/v1/machine/tasks" ? { tasks: [] } : {};
  };
  const w = createWorker({ api, maxParallel: 1, workRoot: W, runtimes: { codex: rt }, stepEveryMs: 0, log: () => {} });
  w.onTask({ ...claim().task, state: "queued" } as any, () => true);
  await Bun.sleep(10);
  w.onTask({ ...claim().task, state: "running", news: true } as any, () => true);
  await Bun.sleep(15);
  expect(kills).toEqual([]); // the tool call is still going
  await w.idle();
  expect(kills).toEqual(["turn 1"]);
  expect(seen.length).toBe(2);
  expect(seen[1]!.resume).toBe("thr_9");
  expect(seen[1]!.prompt).toContain("paused you between two steps");
  expect(seen[1]!.prompt).toContain("- 张伟 (@zhangwei): 先别动索引");
  expect(calls.filter((c) => c.path.endsWith("/claim")).length).toBe(2);
  const finals = calls.filter((c) => c.path === "/api/v1/tasks/T-0001/report" && c.body.state);
  expect(finals.map((c) => c.body.summary)).toEqual(["按你说的没动索引"]);
  rmSync(W, { recursive: true, force: true });
});

test("a repository the agent declared gets a worktree on the task branch; its commits get a PR", async () => {
  const W = mkdtempSync(join(tmpdir(), "teamwork-")), origin = join(W, "pay");
  mkdirSync(origin);
  sh(origin, "git", "init", "-q", "-b", "main");
  writeFileSync(join(origin, "a.txt"), "1");
  sh(origin, "git", "add", "."); sh(origin, "git", "commit", "-qm", "init");
  const seen: RunOptions[] = [], calls: { path: string; body: any }[] = [], after: string[] = [];
  const rt: Runtime = {
    name: "codex", available: () => true,
    start(o) {
      seen.push(o);
      const done = (async () => {
        const dir = join(W, "work", "T-0001.repos", "github.com_acme_pay");
        writeFileSync(join(dir, "b.txt"), "2");
        sh(dir, "git", "add", "."); sh(dir, "git", "commit", "-qm", "b");
        return { session: "thr_9", text: '```json\n{"status":"review","summary":"加了 b.txt"}\n```', exitCode: 0, killed: false };
      })();
      return { done, kill: () => {} };
    },
  };
  const c = claim({ repos: ["github.com/acme/pay"] });
  const w = createWorker({
    api: fakeApi({ "T-0001": c }, calls), maxParallel: 1, workRoot: join(W, "work"), runtimes: { codex: rt }, log: () => {},
    resolveRepo: async () => origin,
    afterRun: async (_c, _r, wd) => { after.push(wd.cwd); return wd.repo ? { pr: { provider: "github", url: "https://github.com/acme/pay/pull/1", number: 1, state: "open", checks: "none" } } : null; },
  });
  w.onTask({ ...c.task, state: "queued" } as any, () => true);
  await Bun.sleep(1);
  await w.idle();
  expect(seen[0]!.cwd).toBe(join(W, "work", "T-0001"));
  expect(seen[0]!.prompt).toContain(`github.com/acme/pay is checked out at ${join(W, "work", "T-0001.repos", "github.com_acme_pay")}`);
  expect(seen[0]!.writable).toContain(join(W, "work", "T-0001.repos", "github.com_acme_pay"));
  expect(sh(origin, "git", "log", "--oneline", "agent/T-0001").out).toContain("b");
  expect(after).toEqual([join(W, "work", "T-0001"), join(W, "work", "T-0001.repos", "github.com_acme_pay")]);
  const last = calls.filter((x) => x.path === "/api/v1/tasks/T-0001/report").at(-1)!.body;
  expect(last.pr.url).toBe("https://github.com/acme/pay/pull/1");
  expect(last.answer).toBeUndefined();
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

test("the person's preferences come after the conventions; a private channel's task leaves the memory alone", async () => {
  const p = taskPrompt({ ...claim(), channel: { id: "c_1", name: "支付后端", topic: "", conventions: "发布前在 #ops 说一声" }, requester_preferences: " 回复用中文 " },
    { cwd: "/w", writable: [] }, { instructions: "PR 标题用中文", mcp: {} });
  const prefs = p.indexOf("# 张伟's preferences (they asked for this task; where they differ from the conventions above, the conventions win)\n回复用中文\n");
  expect(prefs).toBeGreaterThan(p.indexOf("# How #支付后端 works"));
  expect(prefs).toBeGreaterThan(p.indexOf("# Team conventions"));
  expect(taskPrompt(claim(), { cwd: "/w", writable: [] })).not.toContain("preferences (they asked");
  expect(taskPrompt(claim(), { cwd: "/w", writable: [] })).not.toContain("Do not update your memory");
  expect(taskPrompt({ ...claim(), memory_writable: false }, { cwd: "/w", writable: [] })).toContain("Do not update your memory on this task");

  for (const writable of [true, false]) {
    const W = mkdtempSync(join(tmpdir(), "teamwork-"));
    const calls: { path: string; body: any }[] = [];
    const rt = fakeRuntime([{ text: '```json\n{"status":"review","summary":"好了","memory":"- 张伟爱吃辣"}\n```' }], []);
    const w = createWorker({ api: fakeApi({ "T-0001": { ...claim(), memory_writable: writable } }, calls), maxParallel: 1, workRoot: W, runtimes: { codex: rt }, stepEveryMs: 0, log: () => {} });
    w.onTask({ ...claim().task, state: "queued" } as any, () => true);
    await Bun.sleep(1);
    await w.idle();
    const report = calls.find((c) => c.body?.state === "review")!.body;
    expect(report.memory).toBe(writable ? "- 张伟爱吃辣" : undefined);
    rmSync(W, { recursive: true, force: true });
  }
});

test("align: the first turn says when to align, only for a person's own request with no criteria, once per task", () => {
  const wd = { cwd: "/w", writable: [] };
  expect(taskPrompt(claim(), wd)).toContain("# Align first, when the request is larger");
  expect(taskPrompt(claim({ acceptance: "P99 < 200ms" }), wd)).not.toContain("# Align first");
  expect(taskPrompt(claim({ body: "@acha 直接做：把超时调到 5 秒" }), wd)).not.toContain("# Align first");
  expect(taskPrompt(claim({ aligned: true }), wd)).not.toContain("# Align first");
  const m = { by: "u_1", rule: "channel", confirm: false, autonomy: "assist", branch: "agent/T-0001", runtime: "codex" };
  expect(taskPrompt(claim({ mandate: { ...m, trigger: "trg_1" } }), wd)).not.toContain("# Align first");
  expect(taskPrompt(claim({ mandate: { ...m, via: ["a_2"], parent: "T-0009" } }), wd)).not.toContain("# Align first");
  const r = parseTaskResult('看完了\n```json\n{"status":"align","summary":"先对一下","acceptance":["对账一致","10 分钟内"],"approach":"按天分批"}\n```');
  expect(r.status).toBe("align");
  expect(r.acceptance).toEqual(["对账一致", "10 分钟内"]);
});

test("align: the run reports its criteria and whether it changed files; a second alignment is told to go on in the same session", async () => {
  const W = mkdtempSync(join(tmpdir(), "teamwork-"));
  const seen: RunOptions[] = [], calls: { path: string; body: any }[] = [];
  const align = '```json\n{"status":"align","summary":"先对一下","acceptance":["对账一致","10 分钟内"],"not_doing":["不改导出"],"approach":"按天分批"}\n```';
  const rt = fakeRuntime([{ text: align }, { text: align }, { text: '```json\n{"status":"review","summary":"好了"}\n```' }], seen);
  const w = createWorker({
    api: fakeApi({ "T-0001": claim(), "T-0002": claim({ id: "T-0002", aligned: true }) }, calls),
    maxParallel: 1, workRoot: W, runtimes: { codex: rt }, stepEveryMs: 0, log: () => {},
  });
  w.onTask({ ...claim().task, state: "queued" } as any, () => true);
  await Bun.sleep(1);
  await w.idle();
  const last = (id: string) => calls.filter((c) => c.path === `/api/v1/tasks/${id}/report`).at(-1)!.body;
  expect(last("T-0001")).toMatchObject({ state: "align", summary: "先对一下", align: { acceptance: ["对账一致", "10 分钟内"], not_doing: ["不改导出"], approach: "按天分批", dirty: false } });
  w.onTask({ ...claim().task, id: "T-0002", state: "queued" } as any, () => true);
  await Bun.sleep(1);
  await w.idle();
  expect(seen.length).toBe(3);
  expect(seen[2]!.resume).toBe("thr_9");
  expect(seen[2]!.prompt).toContain("already been aligned once");
  expect(last("T-0002").state).toBe("review");
  rmSync(W, { recursive: true, force: true });
});

test("evidence: the review result carries how each criterion was checked; the prompt asks for it", async () => {
  expect(taskPrompt(claim({ acceptance: "P99 < 200ms" }), { cwd: "/w", writable: [] })).toContain('"evidence"');
  const W = mkdtempSync(join(tmpdir(), "teamwork-"));
  const seen: RunOptions[] = [], calls: { path: string; body: any }[] = [];
  const rt = fakeRuntime([{ text: '```json\n{"status":"review","summary":"好了","evidence":[{"criterion":1,"how":"ran","proof":"p99 180ms","file":"out/a.png"},{"criterion":"x","how":"saw"}]}\n```' }], seen);
  const w = createWorker({ api: fakeApi({ "T-0001": claim({ acceptance: "P99 < 200ms" }) }, calls), maxParallel: 1, workRoot: W, runtimes: { codex: rt }, stepEveryMs: 0, log: () => {} });
  w.onTask({ ...claim().task, state: "queued" } as any, () => true);
  await Bun.sleep(1);
  await w.idle();
  const body = calls.filter((c) => c.path === "/api/v1/tasks/T-0001/report").at(-1)!.body;
  expect(body.evidence).toEqual([{ criterion: 1, how: "ran", proof: "p99 180ms", file: "out/a.png" }]);
  rmSync(W, { recursive: true, force: true });
});

test("woken with the receipt of what it delegated: what came back, and how to check, send back or deliver", () => {
  const p = wakePrompt({ ...claim(), wake: { reason: "delegates", payload: "## T-0002 @bei: delivered\nSummary: 文档写好了\n", at: 1 } } as any);
  expect(p).toContain("## T-0002 @bei: delivered");
  expect(p).toContain("remi delegate @AGENT WHAT TO CHANGE");
  expect(p).toContain("A person accepts only your result.");
  expect(parseTaskResult('```json\n{"status": "waiting", "summary": "等", "wait": {"how": "delegates"}}\n```').status).toBe("waiting");
});
