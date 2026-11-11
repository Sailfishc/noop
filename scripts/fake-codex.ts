#!/usr/bin/env bun
// A stand-in for `codex exec --json … [resume ID] -`, so the whole flow (an @mention, a task, a run, a report, a
// PR branch) runs without Codex or a model. scripts/dev.sh puts it on the dev machine's PATH as `codex`.
//
// What it does, by a tag in the request (tags, so the run prompt's own words don't trigger them):
//   (none)      in a repository: commits a small file, reports review; elsewhere: writes out/notes.md, reports review;
//               either way with evidence for the first criteria (fewer than there are, so the rest show as unstated)
//   [decide]    asks a question with two options (needs_decision)
//   [align]     first stops to align (what "done" means, status align); resumed, it does the work
//   [block]     reports blocked
//   [fail]      reports failed
//   [slow]      takes ten times as long (to look at a running task)
//   [nothing]   a read-only patrol (a trigger's run) that finds nothing: status nothing, so nothing is posted
//   [say]       says a word in the thread first (remi say), then goes on as it would
//   [quota]     first hits Codex's usage limit, "try again at" FAKE_CODEX_QUOTA_MIN minutes from now (default 10; at 5
//               or less the daemon waits inside the run); woken after the reset (or 现在就试), it does the work
//   [quota?]    the same, but the limit names no time (the server tries again after 5 minutes, 15, an hour, …)
//   [handoff:x] first runs `remi who`, then `remi handoff @x …` (to another agent), then reports review with what
//               the server said (no @ in the tag: a person's @x would call that agent itself)
//   [delegate:x,y] runs `remi delegate @x …` for each, then waits for them (wait how "delegates"); woken with the
//               receipt, it reports review with how many came back
//   [ask:x]     runs `remi ask @x …` (another agent) and waits for the answer (wait how "answer"); the answer wakes it
//               and it does the work. [ask!:x]: the same, and x's read-only run writes a file anyway (it is thrown away)
//   Asked by another agent (its prompt says "read-only run"), it answers in one plain message.
// FAKE_CODEX_DELAY_MS: the pause between its steps (default 1200).
// FAKE_AS=claude: it is this machine's `claude` instead (scripts/dev.sh installs both): Claude Code's flags and its
// stream-json, the same work; it never hits a limit (to try 换引擎继续 with [quota]).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const a = process.argv.slice(2);
const claude = process.env.FAKE_AS === "claude";
if (claude && a[0] === "--version") { console.log("2.1.0 (Claude Code, fake)"); process.exit(0); }
if (claude && a[0] === "auth") { console.log('{"loggedIn": true}'); process.exit(0); }
// what the daemon asks to see which runtimes this machine has (teamagent.ts detectRuntimes)
if (a[0] === "--version") { console.log("codex-cli 0.0.0 (fake-codex)"); process.exit(0); }
if (a[0] === "login") { console.log("Logged in (fake-codex)"); process.exit(0); }
const cwd = a.includes("--cd") ? a[a.indexOf("--cd") + 1]! : process.cwd();
const resume = claude ? (a.includes("--resume") ? a[a.indexOf("--resume") + 1]! : "") : a.includes("resume") ? a[a.indexOf("resume") + 1]! : "";
const prompt = await new Response(Bun.stdin.stream()).text();
// only the request and its thread count: the prompt also quotes the channel's latest messages
const request = prompt.match(/\n# Request [\s\S]*?(?=\n# Acceptance criteria|$)/)?.[0] ?? prompt;
const has = (tag: string) => request.includes(`[${tag}]`);
const delay = (Number(process.env.FAKE_CODEX_DELAY_MS) || 1200) * (has("slow") ? 10 : 1);
let said = "";
// Codex's --json events, or the same in Claude Code's stream-json
const out = (o: any) => {
  if (!claude) return console.log(JSON.stringify(o));
  const line = (x: unknown) => console.log(JSON.stringify(x));
  if (o.type === "thread.started") line({ type: "system", subtype: "init", session_id: o.thread_id });
  else if (o.type === "item.started") line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: o.item.command } }] } });
  else if (o.type === "item.completed") said = o.item.text.replaceAll("假 Codex", "假 Claude Code");
  else if (o.type === "turn.completed") line({ type: "result", subtype: "success", session_id: session, result: said,
    usage: { input_tokens: o.usage.input_tokens, cache_read_input_tokens: o.usage.cached_input_tokens, output_tokens: o.usage.output_tokens } });
};
const step = async (command: string) => {
  out({ type: "item.started", item: { type: "command_execution", command } });
  await Bun.sleep(delay);
};
const finish = (report: Record<string, unknown>, text = "好了。") => {
  out({ type: "item.completed", item: { type: "agent_message", text: `${text}\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`` } });
  out({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 150 } });
};

const session = resume || (claude ? crypto.randomUUID() : `thr_fake_${Date.now().toString(36)}`);
out({ type: "thread.started", thread_id: session });
await step("rg -n TODO .");

if ((has("quota") || has("quota?")) && !resume && !claude) {
  // Codex's own words (codex-rs/protocol/src/error.rs; test/runfail-samples.test.ts)
  const at = new Date(Date.now() + (Number(process.env.FAKE_CODEX_QUOTA_MIN) || 10) * 60_000), h = at.getHours();
  const msg = has("quota?") ? "You\u2019ve hit your usage limit. To get more access now, send a request to your admin or try again later."
    : `You\u2019ve hit your usage limit. Try again at ${h % 12 || 12}:${String(at.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}.`;
  out({ type: "error", message: msg });
  out({ type: "turn.failed", error: { message: msg } });
  process.exit(1);
}

// a tag names other agents: the one it names (handed or delegated to, it reads the same thread) just does the work
const me = prompt.match(/^You are .* \(@([a-z0-9_-]+)\)/m)?.[1] ?? "";
const named = (xs: string[]) => xs.includes(me) ? [] : xs;
const handoff = named([request.match(/\[handoff:([a-z][a-z0-9_-]*)\]/)?.[1] ?? ""].filter(Boolean))[0];
const remi = (...args: string[]) => {
  const r = Bun.spawnSync(["remi", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return (r.stdout.toString() + r.stderr.toString()).trim();
};

if (prompt.includes("This is a read-only run, not a task")) { // another agent's question
  const q = prompt.slice(prompt.lastIndexOf("# The question") + 15).trim();
  if (/\[ask!:/.test(prompt)) writeFileSync(join(cwd, "fake-codex-scribble.md"), "a read-only run should not write this\n");
  out({ type: "item.completed", item: { type: "agent_message", text: `（假 Codex，只读）关于「${q.slice(0, 60)}」：订单接口返回 JSON，字段 id、amount、state，见 api/orders.md。` } });
  out({ type: "turn.completed", usage: { input_tokens: 600, cached_input_tokens: 0, output_tokens: 60 } });
  process.exit(0);
}
const asked = named([request.match(/\[ask!?:([a-z][a-z0-9_-]*)\]/)?.[1] ?? ""].filter(Boolean))[0];
const delegates = named(request.match(/\[delegate:([a-z0-9_,-]+)\]/)?.[1]?.split(",").filter(Boolean) ?? []);
const receipt = prompt.includes("all of them are back. What came back:");

if (has("say") && !resume) { await step("remi say"); remi("say", "（假 Codex）看了一眼，先说一声：在查"); }

if (receipt) {
  const back = (prompt.match(/^## T-\d+ @\S+: \w+/gm) ?? []).join("；");
  finish({ status: "review", summary: `（假 Codex）委派的都交回了，汇总好了：${back}` });
} else if (asked && !resume) {
  await step(`remi ask @${asked}`);
  const said = remi("ask", `@${asked}`, "（假 Codex）订单接口返回什么格式？");
  finish({ status: "waiting", summary: `（假 Codex）问了 @${asked}，等它回答：${said.split("\n")[0]}`, wait: { how: "answer", what: `@${asked} 的回答` } });
} else if (delegates.length && !resume) {
  const said: string[] = [];
  for (const d of delegates) {
    await step(`remi delegate @${d}`);
    said.push(`@${d}：${remi("delegate", `@${d}`, `（假 Codex）这一块交给你：整理 ${d} 的部分`).split("\n")[0]}`);
  }
  finish({ status: "waiting", summary: `（假 Codex）分出去了，等它们交回。${said.join("；")}`, wait: { how: "delegates", what: "委派出去的部分" } });
} else if (handoff && !resume) {
  await step("remi who");
  const who = remi("who");
  await step(`remi handoff @${handoff}`);
  const said = remi("handoff", `@${handoff}`, "（假 Codex）后面这部分交给你");
  finish({ status: "review", summary: `（假 Codex）交给 @${handoff}：${said.split("\n")[0]}\n可以找的 Agent：\n${who}` });
} else if (has("nothing") && prompt.includes("# This run is a read-only patrol")) {
  finish({ status: "nothing", summary: "（假 Codex）看过了，没有需要人知道的事。" });
} else if (has("fail")) finish({ status: "failed", summary: "（假 Codex）按要求失败了：[fail]。" });
else if (has("block")) finish({ status: "blocked", summary: "（假 Codex）缺数据库只读账号，拿到之前做不下去。" });
else if (has("align") && !resume) {
  finish({
    status: "align", summary: "（假 Codex）读过相关代码了，开工前先对一下做完意味着什么。",
    acceptance: ["慢查询的 P99 降到 200ms 以内", "加索引不锁表", "有一份压测前后的对比"], not_doing: ["不改查询接口的参数"], approach: "先加 created_at 索引，再压测对比。",
  });
} else if (has("decide") && !resume) {
  finish({
    status: "needs_decision", summary: "（假 Codex）两种做法都准备好了，需要你选一个。",
    question: "索引加在哪一列？", options: ["A: created_at — 最常用的查询能用上", "B: user_id — 只帮到退款页"], recommendation: "A",
  });
} else {
  await step("bun test");
  const turn = resume ? "第二轮" : "第一轮";
  const git = existsSync(join(cwd, ".git"));
  if (git) {
    const env = { ...process.env, GIT_AUTHOR_NAME: "fake-codex", GIT_AUTHOR_EMAIL: "fake-codex@localhost", GIT_COMMITTER_NAME: "fake-codex", GIT_COMMITTER_EMAIL: "fake-codex@localhost" };
    writeFileSync(join(cwd, `fake-codex-${Date.now().toString(36)}.md`), `${turn}：假 Codex 的改动\n`);
    Bun.spawnSync(["git", "add", "."], { cwd, env });
    Bun.spawnSync(["git", "commit", "-qm", `fake-codex: ${turn}`], { cwd, env });
    finish({ status: "review", summary: `（假 Codex）${turn}：加了一个文件并提交在任务分支上。`, pr_title: "fake-codex: a small change", pr_body: "Made by scripts/fake-codex.ts.",
      evidence: [{ criterion: 1, how: "ran", proof: "bun test\n12 pass, 0 fail" }, { criterion: 2, how: "not_verified", proof: "要在预发环境压测才知道，请在预发跑一次压测脚本" }] });
  } else {
    const dir = join(cwd, "out");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.md"), `# ${turn}\n\n假 Codex 写的笔记。\n`);
    finish({ status: "review", summary: `（假 Codex）${turn}：整理好了，见 notes.md。`,
      evidence: [{ criterion: 1, how: "saw", proof: "通读了一遍 out/notes.md", file: "notes.md" }] });
  }
}
