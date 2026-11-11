// What each runtime says when it hits a limit, word for word, and what Remi makes of it: wait for the reset (quota),
// try again soon (rate_limited), or stop for a person (billing). Nobody here had an account at its limit, so the
// samples are the runtimes' own message templates, filled in the way their code fills them:
//   - Codex: codex-rs/protocol/src/error.rs (openai/codex main, read 2026-11-11): UsageLimitReachedError's Display,
//     retry_suffix / retry_suffix_after_or, format_retry_timestamp ("%-I:%M %p" today, "%b %-d{th}, %Y %-I:%M %p"
//     another day, in the machine's zone). `codex exec --json` prints it as {"type":"error"} and {"type":"turn.failed"}.
//   - Claude Code 2.1.322: strings of the shipped binary: `You've hit your ${limit}${" · resets " + time}`, the limits
//     {five_hour: "5-hour limit", seven_day: "weekly limit", seven_day_opus: "Opus limit", seven_day_sonnet: "Sonnet
//     limit"}, the time as toLocaleTimeString("en-US") with " PM" made "pm" plus " (zone)", and "Mon D, " before it
//     when the reset is more than 24 hours out. Older versions (before mid 2025) said "Claude AI usage limit
//     reached|<unix seconds>". Not seen live: whether `claude -p` puts it in the result event's text or only in the
//     assistant message (both reach classify, the result's text as its error).
//   - pi 0.73.1: @mariozechner/pi-ai dist/providers/openai-codex-responses.js parseErrorResponse (ChatGPT plan:
//     "You have hit your ChatGPT usage limit (plus plan). Try again in ~N min."). With an Anthropic or OpenAI key pi
//     passes the provider's own error on ("429 {json}", the Anthropic SDK's form); pi retries rate limits itself first.
import { expect, test } from "bun:test";
import { classify, planFor, resetAt } from "../src/runfail";
import { claudeEvent, codexEvent, piEvent } from "../src/runtimes";

const kind = (error: string) => classify({ error, exitCode: 1 });
// 2026-11-11 10:00 on this machine's clock (Codex prints the machine's own zone)
const NOW = new Date(2026, 10, 11, 10, 0).getTime();
const local = (mo: number, d: number, h: number, mi = 0) => new Date(2026, mo, d, h, mi).getTime();

test("Codex: a usage limit with a time waits until then; without one it waits too; credit and plan stop", () => {
  const plus = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 2:30 PM.";
  expect(kind(plus)).toBe("quota");
  expect(resetAt(plus, NOW)).toBe(local(10, 11, 14, 30));

  const free = "You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Nov 13th, 2026 9:05 AM.";
  expect(kind(free)).toBe("quota");
  expect(resetAt(free, NOW)).toBe(local(10, 13, 9, 5));

  const model = "You’ve hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at 4:15 PM.";
  expect(kind(model)).toBe("quota");
  expect(resetAt(model, NOW)).toBe(local(10, 11, 16, 15));

  const plain = "You’ve hit your usage limit. Try again at 11:00 PM.";
  expect(resetAt(plain, NOW)).toBe(local(10, 11, 23));
  // a time already past today is tomorrow's (the limit resets after midnight)
  expect(resetAt("You’ve hit your usage limit. Try again at 1:00 AM.", NOW)).toBe(local(10, 12, 1));

  const team = "You’ve hit your usage limit. To get more access now, send a request to your admin or try again later.";
  expect(kind(team)).toBe("quota");
  expect(resetAt(team, NOW)).toBeUndefined();

  for (const stop of [
    "Your workspace is out of credits. Add credits to continue.",
    "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
    "You hit your spend cap set in your workspace. Increase your spend cap to continue.",
    "You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.",
    "Quota exceeded. Check your plan and billing details.",
    "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
  ]) expect([stop, kind(stop)]).toEqual([stop, "billing"]);

  // its own retries ran out on a 429, or the API's per-minute limit
  expect(kind("exceeded retry limit, last status: 429 Too Many Requests")).toBe("rate_limited");
  const tpm = "rate limit exceeded: Rate limit reached for gpt-5 in organization org-x on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000. Please try again in 6m0s.";
  expect(kind(tpm)).toBe("rate_limited");
  expect(resetAt(tpm, NOW)).toBe(NOW + 6 * 60_000);

  // as `codex exec --json` prints it
  const ev = codexEvent(JSON.stringify({ type: "turn.failed", error: { message: plus } }));
  expect(ev).toEqual({ kind: "error", text: plus });
});

test("Claude Code: the 5-hour and weekly limits wait for the time it names, in the zone it names", () => {
  const five = "You've hit your 5-hour limit · resets 3pm (Asia/Shanghai)";
  expect(kind(five)).toBe("quota");
  const now = Date.UTC(2026, 10, 11, 2, 0); // 10:00 in Shanghai
  expect(resetAt(five, now)).toBe(Date.UTC(2026, 10, 11, 7, 0));
  expect(resetAt("You've hit your Opus limit · resets 3:30pm (America/Los_Angeles)", now)).toBe(Date.UTC(2026, 10, 11, 23, 30)); // 15:30 PST
  const weekly = "You've hit your weekly limit · resets Nov 14, 9am (Asia/Shanghai)";
  expect(kind(weekly)).toBe("quota");
  expect(resetAt(weekly, now)).toBe(Date.UTC(2026, 10, 14, 1, 0));
  expect(kind("You've hit your Sonnet limit · resets Nov 14, 9am")).toBe("quota");
  // before mid 2025
  expect(kind("Claude AI usage limit reached|1762858800")).toBe("quota");
  expect(resetAt("Claude AI usage limit reached|1762858800", 1762840000000)).toBe(1762858800000);

  for (const stop of [
    "You've hit your monthly spend limit.",
    "You've hit your team's shared budget. /model to switch models.",
    "Your org is out of usage · add funds to continue",
    "Credit balance is too low",
  ]) expect([stop, kind(stop)]).toEqual([stop, "billing"]);
  expect(kind("API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"This request would exceed your account's rate limit. Please try again later.\"}}")).toBe("rate_limited");

  const ev = claudeEvent(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: five, session_id: "s1" })) as any[];
  expect(ev).toContainEqual({ kind: "error", text: five });
});

test("pi: a ChatGPT plan's limit says how many minutes; a provider's 429 is a rate limit", () => {
  const plus = "You have hit your ChatGPT usage limit (plus plan). Try again in ~143 min.";
  expect(kind(plus)).toBe("quota");
  expect(resetAt(plus, NOW)).toBe(NOW + 143 * 60_000);
  expect(kind("You have hit your ChatGPT usage limit (pro plan).")).toBe("quota");
  expect(resetAt("You have hit your ChatGPT usage limit (pro plan).", NOW)).toBeUndefined();
  const anthropic = "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"This request would exceed your account's rate limit. Please try again later.\"}}";
  expect(kind(anthropic)).toBe("rate_limited");
  expect(resetAt(anthropic, NOW)).toBeUndefined();

  const ev = piEvent(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: plus } }));
  expect(ev).toEqual({ kind: "error", text: plus });
});

test("what each kind leads to", () => {
  expect(planFor("quota", "codex")).toEqual({ act: "quota" });
  expect(planFor("rate_limited", "codex")).toEqual({ act: "retry", afterMs: [60_000, 240_000] });
  expect(planFor("billing", "claude").act).toBe("block");
  // a time too far out or garbled is no time
  expect(resetAt("try again in 30 days", NOW)).toBeUndefined();
  expect(resetAt("resets Foo 3, 9am", NOW)).toBeUndefined();
  expect(resetAt("You've hit your 5-hour limit · resets 3pm (Not/AZone)", NOW)).toBe(local(10, 11, 15));
});
