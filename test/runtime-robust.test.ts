// How runs that go wrong are handled: failure categories on recorded runtime output, token usage, the watchdog and
// process-group stop of a real child process, and the worker's retry / fresh session / continue / block decisions.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, planFor } from "../src/runfail";
import { claudeEvent, codexEvent, jsonlRun, piEvent, type RunOptions, type RunResult, type Runtime } from "../src/runtimes";
import { createWorker, RESULT_ONLY, type Claim } from "../src/teamwork";

test("failures are told apart by what the runtime said", () => {
  const f = (error: string, stderr = "", exitCode = 1) => classify({ error, stderr, exitCode });
  // recorded from the runtimes (shortened)
  expect(f("Not logged in · Please run /login")).toBe("auth");
  expect(f("", "Error: 401 Unauthorized: invalid x-api-key")).toBe("auth");
  expect(f("stream error: 429 Too Many Requests; rate limit exceeded, retrying in 20s")).toBe("rate_limited");
  expect(f("API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}")).toBe("rate_limited");
  expect(f("You exceeded your current quota, please check your plan and billing details.")).toBe("billing");
  expect(f("Claude AI usage limit reached|1762700400")).toBe("billing");
  expect(f("Prompt is too long")).toBe("input_too_large");
  expect(f("context_length_exceeded: Your input exceeds the context window of this model.")).toBe("input_too_large");
  expect(f("", "Error: 502 Bad Gateway")).toBe("provider");
  expect(f("", "TypeError: fetch failed\n  cause: ECONNRESET")).toBe("provider");
  expect(f("", "Error: No conversation found with session ID: 0199")).toBe("session_lost");
  expect(f("", "spawn codex ENOENT")).toBe("not_installed");
  expect(f("something else")).toBe("unknown");
  expect(classify({ exitCode: 1, resumed: true, text: "" })).toBe("session_lost");
  expect(classify({ exitCode: 0 })).toBe(null);
  expect(classify({ exitCode: 143, stopped: "stall" })).toBe("stalled");
  expect(classify({ exitCode: 143, stopped: "timeout" })).toBe("timeout");
  expect(planFor("rate_limited", "codex")).toEqual({ act: "retry", afterMs: [120_000, 480_000, 1_800_000] });
  expect(planFor("auth", "claude").act).toBe("block");
  expect(planFor("unknown", "pi").act).toBe("fail");
});

test("token usage from each runtime, cached input split out", () => {
  expect(codexEvent('{"type":"turn.completed","usage":{"input_tokens":12000,"cached_input_tokens":9000,"output_tokens":800}}'))
    .toEqual({ kind: "usage", usage: { input: 3000, cacheRead: 9000, output: 800 } });
  const c = claudeEvent('{"type":"result","subtype":"success","is_error":false,"result":"好了","session_id":"s1","usage":{"input_tokens":20,"cache_creation_input_tokens":3000,"cache_read_input_tokens":15000,"output_tokens":600}}') as any[];
  expect(c).toContainEqual({ kind: "usage", usage: { input: 20, cacheRead: 15000, cacheWrite: 3000, output: 600 } });
  expect(c).toContainEqual({ kind: "message", text: "好了" });
  const p = piEvent('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop","usage":{"input":100,"output":50,"cacheRead":900,"cacheWrite":0}}}') as any[];
  expect(p).toEqual([{ kind: "usage", usage: { input: 100, cacheRead: 900, cacheWrite: 0, output: 50 } }, { kind: "message", text: "ok" }]);
});

const alive = (marker: string) => Bun.spawnSync(["sh", "-c", `ps -eo args | grep -v grep | grep -c '${marker}'`]).stdout.toString().trim() !== "0";

test("the watchdog stops a quiet run, and with it everything the run started", async () => {
  const W = mkdtempSync(join(tmpdir(), "robust-"));
  // the "runtime" starts a background child, says one thing, then goes quiet
  const script = `sleep 301 & echo '{"type":"thread.started","thread_id":"thr_q"}'; sleep 302`;
  const h = jsonlRun("fake", () => ["sh", "-c", script], codexEvent, { cwd: W, prompt: "", stallMs: 300 });
  await Bun.sleep(150);
  expect(alive("sleep 301")).toBe(true);
  const r = await h.done;
  expect(r.stopped).toBe("stall");
  expect(r.session).toBe("thr_q");
  expect(r.error).toBeUndefined();
  await Bun.sleep(100);
  expect(alive("sleep 301")).toBe(false);
  expect(alive("sleep 302")).toBe(false);
  rmSync(W, { recursive: true, force: true });
});

test("the run limit stops a run that keeps talking; a kill stops the group too", async () => {
  const W = mkdtempSync(join(tmpdir(), "robust-"));
  const chatty = `while true; do echo '{"type":"item.started","item":{"type":"command_execution","command":"x"}}'; sleep 0.05; done`;
  const r = await jsonlRun("fake", () => ["sh", "-c", chatty], codexEvent, { cwd: W, prompt: "", stallMs: 10_000, timeoutMs: 300 }).done;
  expect(r.stopped).toBe("timeout");
  expect(r.steps).toBeGreaterThan(1);
  const h = jsonlRun("fake", () => ["sh", "-c", "sleep 303 & sleep 304"], codexEvent, { cwd: W, prompt: "" });
  await Bun.sleep(100);
  h.kill();
  const k = await h.done;
  expect(k.killed).toBe(true);
  expect(k.error).toBeUndefined();
  await Bun.sleep(100);
  expect(alive("sleep 303")).toBe(false);
  rmSync(W, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------------- the worker

type Turn = Partial<RunResult> & { hang?: boolean };
/** A runtime that plays one result per run. */
function scripted(turns: Turn[], seen: RunOptions[]): Runtime {
  return {
    name: "codex",
    available: () => true,
    start(o) {
      seen.push(o);
      const t = turns[seen.length - 1] ?? turns.at(-1)!;
      let kill = () => {};
      const done = new Promise<RunResult>((res) => {
        kill = () => res({ session: o.resume ?? "", text: "", exitCode: 143, killed: true });
        if (t.hang) return;
        setTimeout(() => res({ session: o.resume || "thr_1", text: "", exitCode: 0, killed: false, ...t }), 2);
      });
      return { done, kill: () => kill() };
    },
  };
}

const claim = (): Claim => ({
  task: { id: "T-0001", channel_id: "c_1", thread_id: "msg_1", agent_id: "a_1", created_by: "u_1", title: "修登录", body: "@acha 修登录",
    state: "running", step: "", summary: "", decision: null, pr: null, branch: "", session: "", claimed_by: "m_1", runs: 1 },
  agent: { id: "a_1", handle: "acha", name: "阿查", owner_id: "u_2", machine_id: "m_1", runtime: "codex", dispatch: "channel", autonomy: "assist" },
  channel: { id: "c_1", name: "后端", topic: "" }, recent: [], new: [],
  thread: [{ id: "msg_1", seq: 1, channel_id: "c_1", thread_id: null, author: { kind: "user", id: "u_1" }, text: "@acha 修登录", mentions: [], created: 0 }],
  names: {}, creator: { name: "张伟", handle: "zhangwei" }, resumed: false,
});

const DONE = '```json\n{"status":"review","summary":"修好了"}\n```';

async function work(turns: Turn[], extra: Record<string, unknown> = {}) {
  const W = mkdtempSync(join(tmpdir(), "robust-"));
  const seen: RunOptions[] = [], calls: { path: string; body: any }[] = [];
  let claims: Claim | null = claim();
  const api = async (path: string, init: RequestInit = {}) => {
    calls.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (path.endsWith("/claim")) { const c = claims; claims = null; return c; }
    if (path === "/api/v1/machine/tasks") return { tasks: [] };
    return {};
  };
  const w = createWorker({ api, maxParallel: 1, workRoot: W, runtimes: { codex: scripted(turns, seen) }, stepEveryMs: 0, log: () => {}, pauseMs: () => 5, ...extra });
  w.onTask({ ...claim().task, state: "queued" } as any, () => true);
  await Bun.sleep(1);
  const reports = () => calls.filter((c) => c.path === "/api/v1/tasks/T-0001/report").map((c) => c.body);
  return { w, seen, reports, done: async () => { await w.idle(); rmSync(W, { recursive: true, force: true }); } };
}

test("a busy provider is tried again in the same session, and the tokens of every try add up", async () => {
  const run = await work([
    { session: "thr_1", exitCode: 1, error: "429 Too Many Requests", usage: { input: 10, output: 1 } },
    { session: "thr_1", exitCode: 1, error: "502 Bad Gateway" },
    { text: DONE, steps: 2, usage: { input: 5, output: 7 } },
  ]);
  await run.done();
  expect(run.seen.length).toBe(3);
  expect(run.seen[1].resume).toBe("thr_1");
  expect(run.seen[1].prompt).toContain("cut off by an error from the model service (429 Too Many Requests)");
  expect(run.seen[0].stallMs).toBe(20 * 60_000);
  expect(run.reports()).toContainEqual({ step: "被限流，2 分钟后重试（第 1 次）" });
  expect(run.reports().at(-1)).toMatchObject({ state: "review", summary: "修好了", usage: { input: 15, output: 8 } });
});

test("retries stop after the last pause, and the task fails with the reason", async () => {
  const run = await work([{ session: "thr_1", exitCode: 1, error: "503 Service Unavailable" }]);
  await run.done();
  expect(run.seen.length).toBe(4); // the first run and three retries
  expect(run.reports().at(-1)).toMatchObject({ state: "failed", failure: "provider" });
  expect(run.reports().at(-1).summary).toContain("模型服务出错");
});

test("not logged in: blocked with what to do, and no retry", async () => {
  const run = await work([{ exitCode: 1, error: "Not logged in · Please run /login" }]);
  await run.done();
  expect(run.seen.length).toBe(1);
  expect(run.reports().at(-1)).toMatchObject({ state: "blocked", failure: "auth" });
  expect(run.reports().at(-1).summary).toContain("重新登录 codex");
});

test("a runtime the machine knows is logged out is not started at all", async () => {
  const run = await work([{ text: DONE }], { runtimeReady: async () => "codex 在这台机器上没有登录" });
  await run.done();
  expect(run.seen.length).toBe(0);
  expect(run.reports().at(-1)).toEqual({ state: "blocked", summary: "codex 在这台机器上没有登录", failure: "auth", run: 1 });
});

test("a stalled run goes on once in its session, told why", async () => {
  const run = await work([{ session: "thr_1", exitCode: 143, stopped: "stall", steps: 3 }, { text: DONE, steps: 1 }]);
  await run.done();
  expect(run.seen.length).toBe(2);
  expect(run.seen[1].resume).toBe("thr_1");
  expect(run.seen[1].prompt).toContain("it printed nothing for 20 minutes");
  expect(run.reports().at(-1)).toMatchObject({ state: "review", summary: "修好了" });
});

test("too much context: once more in a fresh session with the whole task", async () => {
  const run = await work([{ session: "thr_1", exitCode: 1, error: "Prompt is too long" }, { session: "thr_2", text: DONE }]);
  await run.done();
  expect(run.seen[1].resume).toBeUndefined();
  expect(run.seen[1].prompt).toContain("# Request T-0001: 修登录");
  expect(run.reports().at(-1)).toMatchObject({ state: "review", session: "thr_2" });
});

test("work without a result block: the block alone is asked for once; a plain answer is left as it is", async () => {
  const run = await work([{ text: "我改了 login.ts，测试过了。", steps: 4 }, { text: DONE }]);
  await run.done();
  expect(run.seen.length).toBe(2);
  expect(run.seen[1].prompt).toBe(RESULT_ONLY);
  expect(run.reports().at(-1)).toMatchObject({ state: "review", summary: "修好了" });

  const chat = await work([{ text: "登录用的是 OAuth。" }]);
  await chat.done();
  expect(chat.seen.length).toBe(1);
  expect(chat.reports().at(-1)).toMatchObject({ state: "review", summary: "登录用的是 OAuth。" });
});

test("an empty completion is run once more; a task cancelled while it pauses reports nothing", async () => {
  const empty = await work([{ text: "" }, { text: DONE }]);
  await empty.done();
  expect(empty.seen.length).toBe(2);
  expect(empty.reports().at(-1)).toMatchObject({ state: "review" });

  const run = await work([{ session: "thr_1", exitCode: 1, error: "429" }], { pauseMs: () => 60_000 });
  await Bun.sleep(20);
  run.w.onTask({ ...claim().task, state: "closed" } as any, () => true);
  await run.done();
  expect(run.seen.length).toBe(1);
  expect(run.reports().some((b) => b.state)).toBe(false);
});

test("a result the server did not take waits in the outbox; it is sent first, and the task is not run again", async () => {
  const W = mkdtempSync(join(tmpdir(), "robust-"));
  const seen: RunOptions[] = [], sent: any[] = [];
  let up = false, claims: Claim | null = claim();
  const running = { ...claim().task, state: "running" };
  const api = async (path: string) => {
    if (path.endsWith("/claim")) { const c = claims; claims = null; return c; }
    if (path === "/api/v1/machine/tasks") return { tasks: [running] }; // the server still thinks it runs
    return {};
  };
  const send = async (_path: string, body: any) => { if (!up) return "retry" as const; sent.push(body); return "ok" as const; };
  const w = createWorker({ api, send, maxParallel: 1, workRoot: W, runtimes: { codex: scripted([{ text: DONE }], seen) }, stepEveryMs: 0, log: () => {} });
  w.onTask({ ...claim().task, state: "queued" } as any, () => true);
  await Bun.sleep(1);
  await w.idle();
  expect(sent.length).toBe(0); // the server was away

  // a restarted daemon (a new worker on the same directory) sends it before it looks at the tasks
  claims = claim();
  const w2 = createWorker({ api, send, maxParallel: 1, workRoot: W, runtimes: { codex: scripted([{ text: DONE }], seen) }, stepEveryMs: 0, log: () => {} });
  await w2.poll(); // still away: the task is not claimed again
  await w2.idle();
  expect(seen.length).toBe(1);
  up = true;
  running.state = "review";
  await w2.poll();
  await w2.idle();
  expect(sent).toEqual([{ state: "review", summary: "修好了", session: "thr_1", run: 1, answer: true }]);
  expect(seen.length).toBe(1);
  await w2.flush();
  expect(sent.length).toBe(1); // once
  rmSync(W, { recursive: true, force: true });
});

test("a report refused for good (a stale run) is dropped, not sent forever", async () => {
  const W = mkdtempSync(join(tmpdir(), "robust-"));
  let tries = 0;
  const api = async (path: string) => (path.endsWith("/claim") ? claim() : path === "/api/v1/machine/tasks" ? { tasks: [] } : {});
  const w = createWorker({ api, send: async () => { tries++; return "drop"; }, maxParallel: 1, workRoot: W, runtimes: { codex: scripted([{ text: DONE }], []) }, stepEveryMs: 0, log: () => {} });
  w.onTask({ ...claim().task, state: "queued" } as any, () => true);
  await Bun.sleep(1);
  await w.idle();
  await w.flush();
  expect(tries).toBe(1);
  rmSync(W, { recursive: true, force: true });
});
