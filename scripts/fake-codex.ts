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
//   [quota]     first hits Codex's usage limit, "try again at" FAKE_CODEX_QUOTA_MIN minutes from now (default 10; at 5
//               or less the daemon waits inside the run); woken after the reset (or 现在就试), it does the work
//   [quota?]    the same, but the limit names no time (the server tries again after 5 minutes, 15, an hour, …)
//   [handoff:x] first runs `remi who`, then `remi handoff @x …` (to another agent), then reports review with what
//               the server said (no @ in the tag: a person's @x would call that agent itself)
//   [delegate:x,y] runs `remi delegate @x …` for each, then waits for them (wait how "delegates"); woken with the
//               receipt, it reports review with how many came back
// FAKE_CODEX_DELAY_MS: the pause between its steps (default 1200).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const a = process.argv.slice(2);
// what the daemon asks to see which runtimes this machine has (teamagent.ts detectRuntimes)
if (a[0] === "--version") { console.log("codex-cli 0.0.0 (fake-codex)"); process.exit(0); }
if (a[0] === "login") { console.log("Logged in (fake-codex)"); process.exit(0); }
const cwd = a.includes("--cd") ? a[a.indexOf("--cd") + 1]! : process.cwd();
const resume = a.includes("resume") ? a[a.indexOf("resume") + 1]! : "";
const prompt = await new Response(Bun.stdin.stream()).text();
// only the request and its thread count: the prompt also quotes the channel's latest messages
const request = prompt.match(/\n# Request [\s\S]*?(?=\n# Acceptance criteria|$)/)?.[0] ?? prompt;
const has = (tag: string) => request.includes(`[${tag}]`);
const delay = (Number(process.env.FAKE_CODEX_DELAY_MS) || 1200) * (has("slow") ? 10 : 1);
const out = (o: unknown) => console.log(JSON.stringify(o));
const step = async (command: string) => {
  out({ type: "item.started", item: { type: "command_execution", command } });
  await Bun.sleep(delay);
};
const finish = (report: Record<string, unknown>, text = "好了。") => {
  out({ type: "item.completed", item: { type: "agent_message", text: `${text}\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`` } });
  out({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 150 } });
};

const session = resume || `thr_fake_${Date.now().toString(36)}`;
out({ type: "thread.started", thread_id: session });
await step("rg -n TODO .");

if ((has("quota") || has("quota?")) && !resume) {
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

const delegates = named(request.match(/\[delegate:([a-z0-9_,-]+)\]/)?.[1]?.split(",").filter(Boolean) ?? []);
const receipt = prompt.includes("all of them are back. What came back:");

if (receipt) {
  const back = (prompt.match(/^## T-\d+ @\S+: \w+/gm) ?? []).join("；");
  finish({ status: "review", summary: `（假 Codex）委派的都交回了，汇总好了：${back}` });
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
