// Why a runtime run went wrong, and what to do about it. One pure function over what the run left behind (the error
// it reported, the tail of its stderr, its exit code, whether the watchdog stopped it), so it can be tested on recorded
// output. The categories follow Raft's runtime error diagnostics, narrowed to what changes our next step.

/** Tokens a run used, split the way providers bill them. A field a runtime does not report stays undefined. */
export type Usage = { input?: number; cacheRead?: number; cacheWrite?: number; output?: number };

export const addUsage = (a: Usage | undefined, b: Usage): Usage => {
  const out: Usage = { ...a };
  for (const k of ["input", "cacheRead", "cacheWrite", "output"] as const) {
    if (typeof b[k] === "number" && Number.isFinite(b[k])) out[k] = (out[k] ?? 0) + b[k]!;
  }
  return out;
};

export type Failure =
  | "not_installed" // the runtime is not on this machine
  | "auth" // not logged in, a bad key
  | "billing" // out of credit, a spend cap, or the plan lacks the model: waiting does not help, a person must act
  | "quota" // a usage limit that resets (a subscription's 5-hour or weekly limit): wait for the reset, then go on
  | "rate_limited" // 429, overloaded: try again later
  | "provider" // the provider failed (5xx, connection, stream cut): try again later
  | "input_too_large" // the context does not fit: start a fresh session
  | "session_lost" // the session to resume is gone: start a fresh one
  | "stalled" // no output for too long (the watchdog stopped it)
  | "timeout" // the run limit (the watchdog stopped it)
  | "unknown";

export type RunOutcome = { error?: string; stderr?: string; exitCode: number; stopped?: "stall" | "timeout"; resumed?: boolean; text?: string };

// The exact words come from the runtimes themselves (test/runfail-samples.test.ts lists where each sample is from).
// Order matters: a limit a person must lift (credit, spend cap, plan) before one that resets on its own.
const RULES: [Failure, RegExp][] = [
  ["not_installed", /\bENOENT\b|command not found|executable not found|no such file or directory.*(codex|claude|pi)\b/i],
  ["billing", /\b402\b|billing_error|credit balance|no credits remaining|out of credits|add (credits|funds) to continue|insufficient[_ ](credit|balance|quota|funds)|insufficient_quota|quota exceeded|exceeded your current quota|spend (limit|cap)|shared budget|out of usage\b|usage allocation|seat type doesn't include|upgrade to plus: |usage_not_included|plan (does not|doesn't) include|not available on your plan|usage balance/i],
  ["quota", /(you['’]ve|you have) hit your [^.·\n]*limit|usage limit reached|usage_limit_reached|out of extra usage|(session|weekly) limit reached/i],
  ["auth", /\b401\b|\b403\b|unauthori[sz]ed|not logged in|please (log ?in|run .*login)|invalid (api[ _-]?key|x-api-key|token|credentials)|authentication (failed|error)|login required|oauth token (has )?expired|credentials? (expired|missing|not found)/i],
  ["input_too_large", /context (length|window)|prompt is too long|too many tokens|input (is )?too (long|large)|maximum context|context_length_exceeded|request too large|\b413\b/i],
  ["rate_limited", /\b429\b|rate[ _-]?limit|too many requests|overloaded|\b529\b|server is busy|try again later/i],
  ["provider", /\b50[0-4]\b|internal server error|bad gateway|service unavailable|gateway timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network error|connection (error|reset|closed|refused)|stream (error|ended|disconnected)|fetch failed|upstream/i],
  ["session_lost", /no (conversation|session|thread|rollout) found|session .*not found|could not (find|resume) (session|thread|conversation)|unknown session|invalid session/i],
];

/** What a failed run said: its error and the end of its stderr. */
export const failureText = (r: Pick<RunOutcome, "error" | "stderr">) => `${r.error ?? ""}\n${(r.stderr ?? "").slice(-4000)}`;

/** What kind of failure a run ended in; null when it did not fail. */
export function classify(r: RunOutcome): Failure | null {
  if (r.stopped === "stall") return "stalled";
  if (r.stopped === "timeout") return "timeout";
  if (!r.error && r.exitCode === 0) return null;
  const text = failureText(r);
  for (const [kind, re] of RULES) if (re.test(text)) return kind;
  if (r.resumed && !r.text) return "session_lost";
  return "unknown";
}

/** What the worker does next about a failure. */
export type Plan =
  | { act: "retry"; afterMs: number[] } // run again in the same session, waiting these long before each try
  | { act: "fresh" } // once more in a new session
  | { act: "continue" } // once more in the same session, telling the agent what happened
  | { act: "block"; why: string } // hand to a person: nothing on this side will fix it by trying again
  | { act: "quota" } // wait for the limit to reset (the server wakes the task), then go on in the same session
  | { act: "fail" };

const MIN = 60_000;

export function planFor(f: Failure, runtime: string): Plan {
  switch (f) {
    case "not_installed": return { act: "block", why: `这台机器上没有 ${runtime}：装好并登录后，在线程里回复一句即可重试` };
    case "auth": return { act: "block", why: `${runtime} 没有登录或凭据失效：在这台机器上重新登录 ${runtime} 后，在线程里回复一句即可重试` };
    case "billing": return { act: "block", why: `${runtime} 余额不足、到了花费上限，或当前套餐不含这个模型：充值、调高上限或换模型后，在线程里回复一句即可重试` };
    case "quota": return { act: "quota" };
    // a short limit: twice in the run; still limited after that, the task waits like for a usage limit
    case "rate_limited": return { act: "retry", afterMs: [1 * MIN, 4 * MIN] };
    case "provider": return { act: "retry", afterMs: [1 * MIN, 5 * MIN, 15 * MIN] };
    case "input_too_large": case "session_lost": return { act: "fresh" };
    case "stalled": case "timeout": return { act: "continue" };
    default: return { act: "fail" };
  }
}

/** One line for people: what went wrong, in their words. */
export const FAILURE_TEXT: Record<Failure, string> = {
  not_installed: "runtime 没有安装",
  auth: "runtime 没有登录",
  billing: "余额不足",
  quota: "额度用完",
  rate_limited: "被限流",
  provider: "模型服务出错",
  input_too_large: "上下文太长",
  session_lost: "会话丢失",
  stalled: "长时间没有输出",
  timeout: "超过单次运行时长",
  unknown: "运行失败",
};

// ---------------------------------------------------------------- when a limit resets

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY = 86_400_000;

/** The parts of the wall clock in `tz` (undefined: this machine's zone) at `ms`. */
function wall(ms: number, tz?: string): { y: number; mo: number; d: number; h: number; mi: number } {
  const p: Record<string, number> = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(new Date(ms))) {
    if (x.type !== "literal") p[x.type] = Number(x.value);
  }
  return { y: p.year!, mo: p.month! - 1, d: p.day!, h: p.hour! % 24, mi: p.minute! };
}

/** The moment a wall-clock time in `tz` stands for. */
function zoned(y: number, mo: number, d: number, h: number, mi: number, tz?: string): number {
  const want = Date.UTC(y, mo, d, h, mi);
  let ms = want;
  for (let i = 0; i < 2; i++) { // the zone's offset at that moment, found by looking at what the clock says there
    const w = wall(ms, tz);
    ms += want - Date.UTC(w.y, w.mo, w.d, w.h, w.mi);
  }
  return ms;
}

const validZone = (tz?: string) => { if (!tz) return undefined; try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return undefined; } };

/** When the limit a runtime hit resets, as far as its words say (ms), or undefined when they give no time. A time of
 * day without a date is the next time the clock shows it. Runtimes print it in the machine's zone unless they name one,
 * and this runs on that machine. */
export function resetAt(text: string, now = Date.now()): number | undefined {
  const ok = (ms: number) => (Number.isFinite(ms) && ms > now - 60_000 && ms < now + 8 * DAY ? Math.max(ms, now) : undefined);
  // Claude Code before 1.0.5x: "Claude AI usage limit reached|1762700400" (unix seconds)
  let m = text.match(/limit reached\|(\d{10})\b/i);
  if (m) return ok(Number(m[1]) * 1000);
  // relative: "Try again in ~143 min." (pi, ChatGPT plan), "Please try again in 6m0s" / "in 20s" (OpenAI API), "in 2 hours"
  m = text.match(/(?:try again|retry|retrying|resets?) in ~?\s*((?:\d+(?:\.\d+)?\s*(?:h|hours?|hrs?|m|mins?|minutes?|s|secs?|seconds?)\s*)+)/i);
  if (m) {
    let ms = 0;
    for (const [, n, u] of m[1]!.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) ms += Number(n) * (/^h/i.test(u!) ? 3_600_000 : /^m/i.test(u!) ? 60_000 : 1000);
    return ok(now + ms);
  }
  // Codex: "try again at 2:30 PM." / "Try again at Nov 12th, 2026 2:30 PM." (this machine's zone)
  // Claude Code: "resets 3pm (Asia/Shanghai)" / "resets 3:30pm" / "resets Nov 12, 3pm (Asia/Shanghai)" / "resets at 9am"
  m = text.match(/(?:try again at|resets(?: at)?)\s+(?:([a-z]{3})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?,? (?:(\d{4}),? )?(?:at )?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?:\s*\(([^)]+)\))?/i);
  if (!m) return undefined;
  const [, mon, day, year, hh, mm, ap, zone] = m;
  const tz = validZone(zone?.trim());
  const h = (Number(hh) % 12) + (ap!.toLowerCase() === "p" ? 12 : 0), mi = Number(mm ?? 0);
  const today = wall(now, tz);
  if (mon) {
    const mo = MONTHS.indexOf(mon.toLowerCase());
    if (mo < 0) return undefined;
    let y = year ? Number(year) : today.y;
    let at = zoned(y, mo, Number(day), h, mi, tz);
    if (!year && at < now - DAY) at = zoned(++y, mo, Number(day), h, mi, tz); // "Jan 2" said on Dec 30
    return ok(at);
  }
  let at = zoned(today.y, today.mo, today.d, h, mi, tz);
  if (at < now - 5 * 60_000) at = zoned(today.y, today.mo, today.d + 1, h, mi, tz); // past today: tomorrow's
  return ok(at);
}
