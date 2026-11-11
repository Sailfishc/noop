// End-to-end for M2/M3: @agent → a task → the owner confirms → the daemon (src/teamagent.ts) claims it, runs "codex"
// in a worktree of the agent's repository, and the result reaches the thread; the branch is pushed by the daemon (the
// agent's own push is refused); a reply in the thread resumes the same session. A fake codex stands in for the real one.
//   bun server/test/e2e-dispatch.ts http://127.0.0.1:18082 <invite code for the first admin>
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTeamAgent } from "../../src/teamagent";

const BASE = (process.argv[2] ?? "http://127.0.0.1:18082").replace(/\/$/, "");
const INVITE = process.argv[3] ?? "";
let fails = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`); if (!ok) fails++; };
async function api(method: string, path: string, token = "", body?: unknown) {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
}
const until = async (what: string, f: () => boolean | Promise<boolean>, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await f()) return true; await Bun.sleep(100); }
  check(what, false, "timed out");
  return false;
};
const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).stdout.toString().trim();

const W = mkdtempSync(join(tmpdir(), "teamagent-dispatch-"));
// the agent's repository and its origin
const origin = join(W, "origin.git"), repo = join(W, "repo");
sh(W, "git", "init", "-q", "--bare", "-b", "main", origin);
sh(W, "git", "clone", "-q", origin, repo);
writeFileSync(join(repo, "README.md"), "orders\n");
sh(repo, "git", "add", ".");
sh(repo, "git", "commit", "-qm", "init");
sh(repo, "git", "push", "-q", "origin", "HEAD:main");
sh(repo, "git", "remote", "set-head", "origin", "main");

// a fake codex: follows `codex exec --json … [resume ID] -`, commits a file, tries to push (must be refused), answers
const bin = join(W, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "codex"), `#!/usr/bin/env bun
const a = process.argv.slice(2);
const cwd = a[a.indexOf("--cd") + 1];
const resume = a.includes("resume") ? a[a.indexOf("resume") + 1] : "";
const prompt = await new Response(Bun.stdin.stream()).text();
const out = (o) => console.log(JSON.stringify(o));
out({ type: "thread.started", thread_id: resume || "thr_fake_1" });
const done = (summary, evidence) => { out({ type: "item.completed", item: { type: "agent_message", text: "\\n\`\`\`json\\n" + JSON.stringify({ status: "review", summary, evidence }) + "\\n\`\`\`" } }); out({ type: "turn.completed" }); process.exit(0); };
if (/# Request .*QUOTA-TEST/.test(prompt) && !resume) { // Codex's words at a usage limit, two hours out, on its own request (not the channel lines the prompt quotes)
  const at = new Date(Date.now() + 2 * 3600000), h = at.getHours();
  const msg = "You\u2019ve hit your usage limit. Try again at " + (h % 12 || 12) + ":" + String(at.getMinutes()).padStart(2, "0") + (h < 12 ? " AM." : " PM.");
  out({ type: "error", message: msg });
  out({ type: "turn.failed", error: { message: msg } });
  process.exit(1);
}
if (resume && prompt.includes("usage limit of your runtime; it has reset now")) done("额度恢复后接着做完了");
if (prompt.includes("paused you between two steps")) done("插话后：" + (prompt.includes("改主意") ? "按新的要求做了" : "没收到新要求"));
if (prompt.includes("ALIGN-TEST") && !resume && prompt.includes("# Align first")) { // aligns before it works
  out({ type: "item.completed", item: { type: "agent_message", text: "\\n\`\`\`json\\n" + JSON.stringify({ status: "align", summary: "先对一下", acceptance: ["对账一致", "10 分钟内跑完"], approach: "按天分批" }) + "\\n\`\`\`" } });
  out({ type: "turn.completed" });
  process.exit(0);
}
if (resume && (prompt.includes("按这个做") || prompt.includes("回滚"))) done("对齐后开工：" + (prompt.includes("5 分钟内跑完") ? "按改过的标准" : prompt.includes("回滚") ? "按回复改了标准" : "?"), [{ criterion: 1, how: "ran", proof: "diff 对账结果：0 行不同" }]);
if (prompt.includes("STEER-TEST")) { // a long tool call, then it would go on for a long time
  out({ type: "item.started", item: { type: "command_execution", command: "sleep 1" } });
  await Bun.sleep(1500);
  out({ type: "item.completed", item: { type: "command_execution", command: "sleep 1" } });
  await Bun.sleep(30000);
  done("没被打断");
}
out({ type: "item.started", item: { type: "command_execution", command: "git commit" } });
const env = { ...process.env, GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@a", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@a" };
const turn = resume ? "2" : "1";
await Bun.write(cwd + "/turn" + turn + ".txt", prompt);
Bun.spawnSync(["git", "add", "."], { cwd, env });
Bun.spawnSync(["git", "commit", "-qm", "turn " + turn], { cwd, env });
const push = Bun.spawnSync(["git", "push", "origin", "HEAD:refs/heads/main"], { cwd, env });
await Bun.sleep(300);
const summary = (resume ? "第二轮：" : "第一轮：") + (prompt.includes("/refunds") ? "也看了 /refunds" : "加了索引") + (push.exitCode ? "（推送被拦下）" : "（推送成功?!）");
out({ type: "item.completed", item: { type: "agent_message", text: "完成\\n\`\`\`json\\n" + JSON.stringify({ status: "review", summary, pr_title: "orders: index" }) + "\\n\`\`\`" } });
out({ type: "turn.completed" });
`);
chmodSync(join(bin, "codex"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

async function accept(code: string, handle: string) {
  const r2 = await api("POST", `/api/v1/invites/${code}/accept`, "", { name: handle, handle });
  return r2.json as { session: string; user: { id: string } };
}
const zw = await accept(INVITE, "zhangwei");
const wl = await accept((await api("POST", "/api/v1/invites", zw.session, { email: "wang@corp.com" })).json.code, "wanglei");
const mach = await api("POST", "/api/v1/machines", wl.session, { name: "王磊的 Mac" });
const agent = await api("POST", "/api/v1/agents", wl.session, { handle: "acha", name: "阿查", machine_id: mach.json.machine.id, repo });
const ch = await api("POST", "/api/v1/channels", zw.session, { name: "支付后端", members: [{ kind: "user", id: wl.user.id }, { kind: "agent", id: agent.json.id }] });

const ta = startTeamAgent({ cloud: { url: BASE }, server: { token: mach.json.token }, host: { max_parallel: 2 } }, {
  stateFile: join(W, "state.json"), log: () => {}, worker: { workRoot: join(W, "work"), logDir: join(W, "logs"), stepEveryMs: 0 },
})!;
await until("daemon knows its agent", () => ta.agents().some((a) => a.handle === "acha"));

const ask = await api("POST", `/api/v1/channels/${ch.json.id}/messages`, zw.session, { text: "@acha 给 orders 加个索引" });
const task = async () => (await api("GET", "/api/v1/tasks/T-0001", zw.session)).json;
check("the @ is a task waiting for the owner", (await task()).state === "pending");
await Bun.sleep(300);
check("nothing runs before the owner confirms", ta.worker.running().length === 0);
await api("POST", "/api/v1/tasks/T-0001/confirm", wl.session);
await until("the machine runs it and it comes back for review", async () => (await task()).state === "review");
let t = await task();
check("its session is kept for the next turn", t.session === "thr_fake_1", t.session);
const replies = async () => (await api("GET", `/api/v1/messages/${ask.json.id}/thread`, zw.session)).json.replies as any[];
let rs = await replies();
check("the agent answers in the thread", rs.some((m) => m.author.kind === "agent" && m.text.startsWith("第一轮：加了索引（推送被拦下）")), rs.map((m) => m.text).join(" | "));
check("the daemon pushed the task branch", sh(origin, "git", "branch", "--list", "agent/*").includes("agent/T-0001"));
check("the agent's own push did not reach main", sh(origin, "git", "log", "--oneline", "main").split("\n").length === 1);
check("the summary says the branch was pushed (no PR platform here)", t.summary.includes("已推送分支 agent/T-0001"), t.summary);

// a reply in the thread: the same session continues with only what is new
await api("POST", `/api/v1/channels/${ch.json.id}/messages`, zw.session, { text: "顺便看下 /refunds", thread_id: ask.json.id });
await until("the reply reopens it and it runs again", async () => (await task()).runs === 2 && (await task()).state === "review");
rs = await replies();
check("the second turn resumed the session", rs.some((m) => m.text.startsWith("第二轮：也看了 /refunds")), rs.map((m) => m.text).join(" | "));
t = await task();
check("the second commit is on the branch", sh(origin, "git", "log", "--oneline", "agent/T-0001").split("\n").length === 3);

// said while it runs: the run stops after the tool call in flight and the same session goes on with it
await api("POST", `/api/v1/channels/${ch.json.id}/messages`, zw.session, { text: "STEER-TEST 慢慢做", thread_id: ask.json.id });
await until("it runs a third turn", async () => (await task()).runs === 3 && (await task()).step === "运行 sleep 1");
await api("POST", `/api/v1/channels/${ch.json.id}/messages`, wl.session, { text: "改主意了：只改注释", thread_id: ask.json.id });
await until("the news reaches it mid-run and it finishes with it", async () => (await replies()).some((m) => m.text.startsWith("插话后：按新的要求做了")), 10000);
t = await task();
check("in the same run (no new turn), back for review", t.runs === 3 && t.state === "review", `${t.runs} ${t.state}`);

// the creator accepts it
check("accepted", (await api("POST", "/api/v1/tasks/T-0001/accept", zw.session)).json.state === "done");

// align: a larger request with no criteria stops once for "what done means"; 按这个做 (edited) writes the criteria and
// the same session goes on; a reply instead of the button goes on too, with no second alignment
const alignAsk = async (text: string, id: string) => {
  const m = await api("POST", `/api/v1/channels/${ch.json.id}/messages`, zw.session, { text });
  await api("POST", `/api/v1/tasks/${id}/confirm`, wl.session);
  return m.json.id as string;
};
const get = async (id: string) => (await api("GET", `/api/v1/tasks/${id}`, zw.session)).json;
await alignAsk("@acha ALIGN-TEST 重写对账", "T-0002");
await until("it stops to align", async () => (await get("T-0002")).state === "needs_decision");
let a = await get("T-0002");
check("an align card with its criteria, waiting for the creator", a.decision?.kind === "align" && a.decision.acceptance.length === 2 && a.holder?.why === "align", JSON.stringify(a.decision));
await api("POST", "/api/v1/tasks/T-0002/decide", zw.session, { acceptance: "对账一致\n5 分钟内跑完" });
await until("按这个做: it goes on in the same session and delivers", async () => ["review", "done"].includes((await get("T-0002")).state)); // it changed nothing: done as an answer
a = await get("T-0002");
check("with the criteria as edited", a.acceptance === "对账一致\n5 分钟内跑完" && a.summary.startsWith("对齐后开工：按改过的标准"), a.summary);
check("evidence for the first criterion; the second, never mentioned, is unstated", a.evidence?.length === 2 && a.evidence[0].how === "ran" && a.evidence[1].how === "unstated", JSON.stringify(a.evidence));
const root3 = await alignAsk("@acha ALIGN-TEST 整理发布流程", "T-0003");
await until("the second one stops to align", async () => (await get("T-0003")).state === "needs_decision");
await api("POST", `/api/v1/channels/${ch.json.id}/messages`, zw.session, { text: "再加一条：要有回滚步骤", thread_id: root3 });
await until("a reply instead: it goes on and delivers, no second card", async () => ["review", "done"].includes((await get("T-0003")).state));
a = await get("T-0003");
check("it followed the reply", a.summary.startsWith("对齐后开工：按回复改了标准") && a.aligned === true, a.summary);

// a usage limit: the task waits for the reset in its session, nobody is called, the machine says why; 现在就试 goes on
await alignAsk("@acha QUOTA-TEST 导出订单", "T-0004");
await until("it hits the limit and waits", async () => (await get("T-0004")).state === "waiting");
let q = await get("T-0004");
const back = q.wait?.expect - Date.now();
check("for the time Codex named", q.wait?.how === "quota" && back > 115 * 60_000 && back < 121 * 60_000, JSON.stringify(q.wait));
check("not a failure, nobody's inbox", q.failures === 0 && !(await api("GET", "/api/v1/inbox", zw.session)).json.tasks.some((x: any) => x.id === "T-0004"));
const machines = async () => (await api("GET", "/api/v1/machines", wl.session)).json.machines as any[];
check("the machine says codex waits for its quota", (await machines())[0].runtime_status?.codex?.state === "quota");
await alignAsk("@acha 另一件小事 直接做", "T-0005");
await Bun.sleep(1500);
check("the runtime's other task waits too, untried", (await get("T-0005")).state === "queued" && (await get("T-0005")).runs === 0);
check("现在就试", (await api("POST", "/api/v1/tasks/T-0004/retry", zw.session)).status === 200);
await until("it goes on in the same session and delivers", async () => ["review", "done"].includes((await get("T-0004")).state));
q = await get("T-0004");
check("told the limit reset, in the session it had", q.summary.startsWith("额度恢复后接着做完了") && q.session === "thr_fake_1", q.summary);
if (!await until("the runtime takes work again and the other task runs", async () => !(await machines())[0].runtime_status?.codex && (await get("T-0005")).runs === 1)) {
  console.log(JSON.stringify((await machines())[0].runtime_status), JSON.stringify(await get("T-0005")).slice(0, 400));
}

ta.stop();
rmSync(W, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
