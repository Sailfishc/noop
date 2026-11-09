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
  | "billing" // out of credit or quota, or the plan lacks the model
  | "rate_limited" // 429, overloaded: try again later
  | "provider" // the provider failed (5xx, connection, stream cut): try again later
  | "input_too_large" // the context does not fit: start a fresh session
  | "session_lost" // the session to resume is gone: start a fresh one
  | "stalled" // no output for too long (the watchdog stopped it)
  | "timeout" // the run limit (the watchdog stopped it)
  | "unknown";

export type RunOutcome = { error?: string; stderr?: string; exitCode: number; stopped?: "stall" | "timeout"; resumed?: boolean; text?: string };

const RULES: [Failure, RegExp][] = [
  ["not_installed", /\bENOENT\b|command not found|executable not found|no such file or directory.*(codex|claude|pi)\b/i],
  ["billing", /\b402\b|credit balance|insufficient (credit|balance|quota|funds)|billing|usage balance|quota (exceeded|exhausted)|exceeded your current quota|usage limit|plan (does not|doesn't) include|upgrade your plan|not available on your plan/i],
  ["auth", /\b401\b|\b403\b|unauthori[sz]ed|not logged in|please (log ?in|run .*login)|invalid (api[ _-]?key|x-api-key|token|credentials)|authentication (failed|error)|login required|oauth token (has )?expired|credentials? (expired|missing|not found)/i],
  ["input_too_large", /context (length|window)|prompt is too long|too many tokens|input (is )?too (long|large)|maximum context|context_length_exceeded|request too large|\b413\b/i],
  ["rate_limited", /\b429\b|rate[ _-]?limit|too many requests|overloaded|\b529\b|server is busy|try again later/i],
  ["provider", /\b50[0-4]\b|internal server error|bad gateway|service unavailable|gateway timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network error|connection (error|reset|closed|refused)|stream (error|ended|disconnected)|fetch failed|upstream/i],
  ["session_lost", /no (conversation|session|thread|rollout) found|session .*not found|could not (find|resume) (session|thread|conversation)|unknown session|invalid session/i],
];

/** What kind of failure a run ended in; null when it did not fail. */
export function classify(r: RunOutcome): Failure | null {
  if (r.stopped === "stall") return "stalled";
  if (r.stopped === "timeout") return "timeout";
  if (!r.error && r.exitCode === 0) return null;
  const text = `${r.error ?? ""}\n${(r.stderr ?? "").slice(-4000)}`;
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
  | { act: "fail" };

const MIN = 60_000;

export function planFor(f: Failure, runtime: string): Plan {
  switch (f) {
    case "not_installed": return { act: "block", why: `这台机器上没有 ${runtime}：装好并登录后，在线程里回复一句即可重试` };
    case "auth": return { act: "block", why: `${runtime} 没有登录或凭据失效：在这台机器上重新登录 ${runtime} 后，在线程里回复一句即可重试` };
    case "billing": return { act: "block", why: `${runtime} 的额度用完了，或当前套餐不含这个模型：充值、换模型或换 runtime 后，在线程里回复一句即可重试` };
    case "rate_limited": return { act: "retry", afterMs: [2 * MIN, 8 * MIN, 30 * MIN] };
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
  billing: "额度不足",
  rate_limited: "被限流",
  provider: "模型服务出错",
  input_too_large: "上下文太长",
  session_lost: "会话丢失",
  stalled: "长时间没有输出",
  timeout: "超过单次运行时长",
  unknown: "运行失败",
};
