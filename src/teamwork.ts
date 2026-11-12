// TeamAgent tasks on this machine: claim the tasks of this machine's agents, run each in its own work directory (a git
// worktree of the agent's repository on branch agent/T-xxxx) with the agent's runtime, keep the task card's step up
// to date, and report the result. The next turn of a task (people replied in its thread, or answered its decision)
// resumes the same runtime session with only what is new.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { RUNTIMES, type RunEvent, type Runtime, type RunResult } from "./runtimes";
import { CHECKPOINT_EVERY, dropCheckpoint, keptCheckpoints, saveCheckpoint } from "./checkpoint";
import { RUNTIME_NAMES } from "./gitflow";
import { addUsage, classify, FAILURE_TEXT, type Failure, failureText, planFor, resetAt, type Usage } from "./runfail";
import type { TeamAgent, TeamMessage } from "./teamagent";
import type { TeamContext } from "./teamconfig";

export type Decision = { question: string; options: string[]; recommendation?: string; answer?: string };
export type PR = { provider: string; url: string; number: number; title?: string; state: string; checks: string; repo?: string };
/** A result kept by an outside service the agent called (its id there, a link, how it stands). */
export type ExternalOutput = { kind?: "external"; title: string; service?: string; external_id?: string; url?: string; status?: "pending" | "ready" | "failed"; note?: string;
  /** A small picture of it the agent made, a path under its work directory: shown in the thread. */
  preview?: string };
export type TeamTask = {
  id: string; channel_id: string; thread_id: string; agent_id: string; created_by: string; title: string; body: string;
  state: string; step: string; summary: string; decision: Decision | null; pr: PR | null; branch: string; session: string;
  claimed_by: string | null; runs: number; acceptance?: string; mandate?: Mandate | null;
  /** A task people track; false: a request the agent may simply answer (it claims it with a "task:" line). */
  tracked?: boolean;
  /** Its title was given (by the agent or a person), not cut from the request: the agent leaves it as it is. */
  titled?: boolean;
  /** The repository it runs in, host/owner/name ("" or missing: a general task, or the agent's own repo path). */
  repo?: string;
  /** Repositories the agent declared while it worked (`remi repo`): each gets a worktree beside the task's directory. */
  repos?: string[];
  /** Something new for its running agent (people's words, a repository it asked for): the run is resumed with it. */
  news?: boolean;
  /** Its agent already aligned with people once (status align): it may not again. */
  aligned?: boolean;
  /** Times it moved to another computer (server teammove.go): a run claimed with another count is void. */
  moves?: number;
  /** The runtime this task runs with when its owner switched it from the agent's (换引擎继续); the claim's agent already
   * says so. engine: the card, from which runtime. */
  runtime?: string;
  engine?: { from: string; to: string; reason: string; state: string } | null;
  /** Where it got to, kept off its computer (checkpoint.ts): what a computer it moved to restores. */
  checkpoint?: TaskCheckpoint | null;
  /** A read-only run, a patrol a trigger started (server teamduties.go): it changes nothing (what it changes in a
   * repository is thrown away), opens no PR, and may end with "nothing" when nobody needs to hear of it. */
  readonly?: boolean;
};
export type TaskCheckpoint = { at: number; checked?: number; machine?: string; repos: { repo: string; branch: string; commit?: string; head?: string; error?: string }[]; files?: { id: string; size: number } | null; error?: string };
/** On whose word the agent works and how far it may go (fixed when the task was made). */
export type Mandate = { by: string; rule: string; confirm: boolean; joined?: boolean; autonomy: string; branch: string; runtime: string; model?: string;
  /** It came from another agent (a handoff) or a trigger, not from a person's own words. */
  via?: string[] | null; parent?: string; trigger?: string;
  /** The agent of the parent task delegated a part to it (remi delegate): its result goes back to that agent. */
  delegated?: boolean; redos?: number };
export type Claim = {
  task: TeamTask; agent: TeamAgent & { repo?: string; memory?: string };
  /** repo: the channel's usual repository, a hint (the agent declares a repository itself with `remi repo`). */
  /** conventions: how the channel works, written by its members. */
  channel: { id: string; name: string; topic: string; repo?: string; conventions?: string };
  recent: TeamMessage[]; thread: TeamMessage[]; new: TeamMessage[]; names: Record<string, string>;
  creator: { name: string; handle: string }; resumed: boolean;
  /** Why a waiting task woke (and what a callback posted). */
  wake?: Wake | null;
  /** Where an outside service can post to wake this task. */
  callback_url?: string;
  /** What the run's `remi` command reads the chat with (only while this task runs). */
  read_token?: string;
  /** 「我的偏好」 of the person who asked: below the channel's and the team's conventions. */
  requester_preferences?: string;
  /** false: the agent may not change its memory on this task (a private channel where that would leak); the server
   * drops it anyway, this only spares the agent the effort. Missing (an older server): it may. */
  memory_writable?: boolean;
  /** The other agents it may turn to, a line each (\`remi who\`); "" or missing: none. */
  agents?: string;
  /** This machine may keep a general task's directory on the server as its checkpoint (its owner's switch). */
  checkpoint_files?: boolean;
};
export type Wake = { reason: "callback" | "done" | "failed" | "errors" | "timer" | "deadline" | "message" | "quota" | "delegates"; note?: string; payload?: string; at: number };
/** What wakes a waiting task: a call to its callback address, a check command this machine runs, or a time. */
export type WaitSpec = { how: "callback" | "poll" | "timer" | "answer" | "delegates"; check?: string; cancel?: string; every?: string | number; expect?: string | number; deadline?: string | number; what?: string };
export type TaskResult = {
  status: "review" | "needs_decision" | "blocked" | "failed" | "waiting" | "align" | "nothing";
  summary: string; question?: string; options?: string[]; recommendation?: string; pr_title?: string; pr_body?: string;
  /** The criteria the agent worked to, when people gave none (align: the criteria it proposes, one per item). */
  acceptance?: string | string[];
  /** align: what it will leave alone, and how it will go about it. */
  not_doing?: string[]; approach?: string;
  /** The agent's memory.md as it wants it now, when it learned something lasting. */
  memory?: string;
  /** Results kept by outside services it called. */
  outputs?: ExternalOutput[];
  /** status waiting: what wakes it. */
  wait?: WaitSpec;
  /** Whether it saw the outcome it worked for. */
  result?: "confirmed" | "unconfirmed";
  /** review: how each acceptance criterion was verified. */
  evidence?: Evidence[];
};
/** How one acceptance criterion (from 1) was verified: ran a command, looked at something, or could not. */
export type Evidence = { criterion: number; how: "ran" | "saw" | "not_verified"; proof?: string; file?: string };

/** Where a task runs. `repo` is the checkout this worktree belongs to. `files`: in/ (what people attached) and out/
 * (what goes back to the thread), inside cwd for a general task, beside the worktree for a repository task.
 * `extra`: worktrees of the repositories the agent declared while it worked (remote → its worktree). */
/** setup: what came of the repository's .remi/setup.sh when the worktree was made ("" when it has none). */
/** restored: it moved here from another computer and came back from its checkpoint, from the task branch pushed
 * there, or not at all ("none": it starts over). */
export type Workdir = { cwd: string; repo?: string; base?: string; branch?: string; writable: string[]; files?: string; extra?: Record<string, Workdir>; setup?: string; restored?: "checkpoint" | "branch" | "none" };

/** What happens after a run: push the branch and open or update the PR (M3: gitflow.ts). */
export type AfterRun = (c: Claim, r: TaskResult, wd: Workdir) => Promise<{ pr?: PR; note?: string } | null>;

const REACT_LINE = /^\s*(react|task):[^\n]*\n?/gim;

/** The title of the agent's "task: …" line, if a message has one: it claims the request as a task. */
export function taskClaimOf(text: string): string | null {
  const m = text.match(/^\s*task:\s*(.*)$/im);
  return m ? m[1].trim().slice(0, 60) : null;
}

/** The emoji of the agent's "react: …" line, if a message has one (one emoji, nothing else). */
export function reactionOf(text: string): string {
  const m = text.match(/^\s*react:\s*(\S+)\s*$/im);
  const e = m?.[1] ?? "";
  return e.length <= 16 && /^\p{Extended_Pictographic}/u.test(e) && !/[\p{L}\p{N}]/u.test(e) ? e : "";
}

const STATUSES = new Set(["review", "needs_decision", "blocked", "failed", "waiting", "align", "nothing"]);

/** The result block at the end of the agent's last message. Without one, the message itself is the summary. */
export function parseTaskResult(text: string): TaskResult {
  const blocks = [...text.matchAll(/```json\s*(\{[\s\S]*?\})\s*```/g)].map((m) => m[1]).reverse();
  for (const b of blocks) {
    try {
      const r = JSON.parse(b);
      if (STATUSES.has(r.status)) {
        const options = Array.isArray(r.options) ? r.options.map(String).filter(Boolean) : undefined;
        if (r.status === "needs_decision" && !String(r.question ?? "").trim()) return { ...r, status: "blocked", summary: String(r.summary ?? "") };
        if (r.status === "waiting" && !["callback", "poll", "timer", "answer", "delegates"].includes(r.wait?.how)) return { ...r, status: "review", result: "unconfirmed", summary: String(r.summary ?? "") };
        if (r.status === "waiting" && r.wait.how === "poll" && !String(r.wait.check ?? "").trim()) return { ...r, wait: { ...r.wait, how: "timer" }, summary: String(r.summary ?? "") };
        return { ...r, summary: String(r.summary ?? ""), options };
      }
    } catch {}
  }
  const prose = text.replace(/```json[\s\S]*?```/g, "").replace(REACT_LINE, "").trim();
  return prose ? { status: "review", summary: prose.slice(0, 4000) } : { status: "failed", summary: "Agent 没有给出结果" };
}

const who = (c: Claim, m: TeamMessage) => c.names[m.author.id] ?? (m.author.kind === "agent" ? "an agent" : "someone");
/** The file name an attachment gets in in/ ("/media/<time>-<id>-<name>" → its id and name). */
export const inName = (a: string) => basename(decodeURIComponent(a)).replace(/[^\w.\-\u4e00-\u9fff]+/g, "_").slice(-120);
const attached = (m: TeamMessage) => (m.attachments ?? []).filter((a) => a.startsWith("/media/")).map(inName);
const quote = (c: Claim, ms: TeamMessage[]) => ms.map((m) => {
  const files = attached(m);
  return `- ${who(c, m)}: ${m.text.replace(/\n/g, "\n  ")}${files.length ? `\n  [attached, in your in/ folder: ${files.join(", ")}]` : ""}`;
}).join("\n");

const RESULT_SPEC = `When you stop, end your final message with EXACTLY one fenced \`\`\`json block:
{
  "status": "review" | "needs_decision" | "blocked" | "failed" | "waiting",
  "result": "review only, when the work depends on an outcome outside your work directory: confirmed (you saw it) | unconfirmed (you could not; say in the summary where and when it will appear)",
  "wait": {"how": "poll" | "callback" | "timer" | "answer" | "delegates", "check": "poll: a shell command run in your work directory that prints one JSON line {\"state\": \"pending\" | \"done\" | \"failed\", \"note\": \"progress\"}", "every": "5m", "expect": "2h", "deadline": "6h", "cancel": "optional: a command that cancels the outside job", "what": "what you wait for"},
  "summary": "1-3 sentences for the thread: what you did or found, with file paths, commands and links",
  "question": "needs_decision only: one short question",
  "options": ["A: <recommended> — consequence", "B: ... — consequence"],
  "recommendation": "A",
  "pr_title": "review with commits only: the pull request title",
  "pr_body": "review with commits only: what changed and how it was verified",
  "acceptance": "only when the task came without acceptance criteria: the criteria you worked to, one per line",
  "evidence": [{"criterion": 1, "how": "ran" | "saw" | "not_verified", "proof": "ran: the command and the last lines of its output; saw: what you looked at; not_verified: why, and how a person can check it", "file": "optional: a file you saved in out/ that shows it (a screenshot)"}],
  "memory": "only when you learned something that will matter in later tasks (how the team works, a repo's quirks, people's preferences): your whole memory.md as it should be now, short bullet points, under 4000 characters",
  "outputs": [{"kind": "external", "title": "what it is", "service": "which service keeps it", "external_id": "its id there", "url": "https link to it", "status": "pending" | "ready" | "failed", "preview": "optional: path of a small picture of it you saved"}]
}
waiting = you started something outside (a cloud job, a render, a deployment) whose result decides whether the task is
done, and you found a way to see the result (a status API to poll, the callback address below, or where it will appear
at a known time): you stop now and are woken when it is time, in the same session. waiting with how "answer" = you
asked someone with \`remi ask\` and nothing else is left to do before their answer: their reply wakes you (or after a
day you are woken to decide). waiting with how "delegates" = you delegated parts with \`remi delegate\` and have
nothing else to do before they are back: you are woken once, with the receipt, when all of them are. Do not wait in place for more than
about 10 minutes. If the person's goal does not depend on the result, or you cannot find any way to see it, do not wait:
report review with result unconfirmed. At most 3 submissions to outside services per task: run \`remi submit WHAT\` right
before each one (the server counts them; failures and timeouts count too). When it refuses, do not submit: stop with
needs_decision (try again / another way / cancel). Before submitting again after no result, cancel the earlier
job if you can. review = the work is ready for a person to look at; needs_decision = you need a person to choose before going on (do all the
preparation that does not depend on the answer first); blocked = you cannot go on without something you do not have;
failed = it cannot be done. With review, give one "evidence" entry per acceptance
criterion (numbered from 1, in order; your own criteria when none were given): ran = you ran something and saw it pass,
saw = you looked at the result, not_verified = you could not check it (say how a person can). Say honestly which you
did not verify; a missing entry shows as "not stated". Keep the summary to what you did; the evidence says how it was checked. Write summary, question and options in the language the people in the thread use (Simplified
Chinese unless they write otherwise), plain text, no emoji.`;

const FILES = (wd: Workdir) => wd.files
  ? `\n- Files people attached to the thread are in ${join(wd.files, "in")}. Put what people should get that is not a code change (a report, a table, a picture) in ${join(wd.files, "out")}: every file there is uploaded to the thread when you stop. Keep drafts elsewhere.
- When you start work in an outside service (a cloud job, a render, a deployment), list it in "outputs" with its id there, and say plainly whether you saw its result.`
  : "";

/** The repositories the agent declared, ready as worktrees. */
const EXTRA = (wd: Workdir) => Object.entries(wd.extra ?? {}).map(([remote, x]) =>
  `\n- ${remote} is checked out at ${x.cwd}, a git worktree on branch ${x.branch}: change it there and commit on that branch.${SETUP(x)}`).join("");

/** What came of the repository's setup script in a fresh worktree. */
export const SETUP = (x: Workdir) => !x.setup ? "" : x.setup === "ok"
  ? ` Its ${SETUP_SCRIPT} already ran there (dependencies are installed).`
  : ` Its ${SETUP_SCRIPT} ${x.setup}: fix or work around that first, and say so in the summary.`;

/** How to get a repository when the work turns out to need one. Reading counts: a task about a repository's code or
 * commits ("what changed this week", "how does X work") stalled when the prompt said to declare only before changes. */
const DECLARE = (c?: Claim) => `\n- If the request needs a repository's files or commit history, to read them or to change them, first declare it with \`remi repo owner/name\` (or its address)${c?.channel.repo ? `; this channel usually works in ${c.channel.repo}` : ""}: your machine checks it out on your task branch and resumes you with its path. Do not clone repositories yourself. A pull request's or CI run's status needs no checkout: read it with gh or glab (below).`;

/** The read-only gh and glab (gateEnv): what agents may look at on the Git platforms without a checkout. */
const GIT_READ = (c?: Claim) => `\n- \`gh\` (GitHub) and \`glab\` (GitLab, including the company's GitLab-based platform) work here read-only, with this machine's login: pull and merge requests, CI runs, issues, commits, and GET requests (\`gh api\`, \`glab api\`). Name the repository with \`-R owner/name\`${c?.channel.repo ? ` (this channel's usual one is ${c.channel.repo})` : ""}. Anything that changes something is refused: the machine pushes and opens pull requests, people merge.`;

// The machine is shared with its owner and other agents: an agent that cleaned up with `pkill -f "headless=new"`
// stopped everyone's headless Chrome (upstream noop #145).
const PROCESSES = `\n- Stop only processes you started, by the PID you noted when you started them. Never stop processes by name or command line (pkill -f, killall, taskkill /IM): this machine is shared with its owner and other agents.`;

const RULES = (wd: Workdir, c?: Claim) => c?.task.readonly
  ? `# Rules
- Work in ${wd.cwd}${wd.repo ? `, a git worktree of ${wd.repo}: read it, do not change it` : " (this task's own directory)"}.${FILES(wd)}${GIT_READ(c)}
- Never push, merge, or publish anything.${PROCESSES}`
  : wd.repo
  ? `# Rules (enforced: breaking them fails)
- Work in ${wd.cwd}, a git worktree of ${wd.repo} on branch ${wd.branch}. Commit your changes on this branch with clear messages.${SETUP(wd)}${EXTRA(wd)}
- Never push, force-push, merge, delete branches, or change other branches: the machine pushes ${wd.branch} and opens the pull request after you stop.${GIT_READ(c)}
- Run the project's tests or checks for what you changed before you stop, and say in the summary what you ran.${PROCESSES}${FILES(wd)}`
  : `# Rules
- Work in ${wd.cwd} (this task's own directory).${EXTRA(wd) || DECLARE(c)}${GIT_READ(c)}${FILES(wd)}
- Never push to remote repositories, merge, or publish anything: the machine pushes your task branches and opens pull requests after you stop.${PROCESSES}${EXTRA(wd) ? "\n- Run the project's tests or checks for what you changed before you stop, and say in the summary what you ran." : ""}`;

const AUTONOMY: Record<string, string> = {
  cautious: "cautious: before any change beyond reading and investigating, stop with needs_decision and propose what you would do",
  assist: "assist: do the work on your branch; stop with needs_decision before anything hard to undo or outside the request",
  auto: "auto: carry the task through on your branch without stopping for routine choices; still stop before anything irreversible",
};

/** Who handed the task over, under which rule, and how far the agent may go. */
function mandateLine(c: Claim): string {
  const m = c.task.mandate;
  if (!m) return "";
  const rule = m.rule === "owner" ? "only your owner hands you work" : m.rule === "team" ? "anyone in the team may hand you work" : "members of your channels may hand you work";
  return `\nMandate: ${rule}${m.confirm ? "; your owner confirmed this task" : ""}. Autonomy ${AUTONOMY[m.autonomy] ?? m.autonomy}.`;
}

/** Should the agent align before it works (design 「对齐」)? Only for a person's own request with no acceptance
 * criteria written, that did not say "直接做", and only once per task. Whether the request is big enough is the
 * agent's call, by the rule in ALIGN. */
export function mayAlign(t: TeamTask): boolean {
  const m = t.mandate;
  return !t.aligned && !t.acceptance?.trim() && !m?.trigger && !m?.parent && !m?.via?.length && !/直接做|just do it/i.test(t.body ?? "");
}

const ALIGN = `# Align first, when the request is larger
Before changing anything, decide whether to align with the person who asked. Align when ALL of these hold:
1. no acceptance criteria were written (true here);
2. it is not a question or lookup you can answer in one reply;
3. at least one of: it changes more than one file, it will take more than about ten minutes, or the request can
   reasonably be read more than one way.
What the person or the channel wrote above may say otherwise ("小改动不用跟我对齐", "一律先对齐"): follow them.
To align: only read (code, docs, the thread) and change nothing, then stop with this result block instead of the usual one:
\`\`\`json
{"status": "align", "summary": "one sentence: what you read and why you are checking", "acceptance": ["1 to 5 checkable outcomes, each a result, not an action"], "not_doing": ["optional: one or two things you will leave alone"], "approach": "one sentence: how you will do it"}
\`\`\`
The person answers with "按这个做" (the criteria, maybe edited, become the task's acceptance criteria) or a reply that
changes them: then start work at once and do not align again. You align at most once per task.`;

/** The run aligned again although it already had: what it is told instead, in the same session. */
export const ALIGNED_AGAIN = `This task has already been aligned once and may not align again. Do not stop to align: carry on with the
work to the acceptance criteria you have (or the person's latest words in the thread), and end with the usual result block.

${RESULT_SPEC}`;

/** A read-only run a trigger started (a patrol): what it may do, and how to end when there is nothing to tell. */
export const PATROL = `# This run is a read-only patrol
A trigger of your team started this run to look at something regularly. Look and report; do not act:
- Read, search and run commands that only look (status, logs, tests that write nothing outside your directory).
- Do not change, commit or delete files in any repository: whatever you change there is thrown away when you stop,
  and nothing is pushed. You may write a report into out/ (it is handed over) and say things in the thread.
- You cannot open pull requests, hand work on (remi handoff) or delegate (remi delegate). When something should be
  done, propose it: \`remi propose --key SHORT-WORD TITLE --why WHAT-YOU-SAW --plan WHAT-DONE-LOOKS-LIKE\`, always
  with --key (the same word each time you see the same thing), --urgent only when waiting until tomorrow does harm
  today. A person decides; after proposing you may end with "nothing" (the proposal is what they will see).
- Do not add a "task:" line to your first message.
When nothing you found is worth a person's attention (all is as it should be), end with exactly:
\`\`\`json
{"status": "nothing", "summary": "one sentence: what you checked"}
\`\`\`
Then nothing is posted: no message, nobody is told; the summary only goes into the trigger's history. Otherwise end
with the usual result block (review when you have something to tell).`;

/** The first turn: who the agent is, what it remembers, where it works, the channel, the task and its thread. */
export function taskPrompt(c: Claim, wd: Workdir, team?: TeamContext | null): string {
  const a = c.agent, t = c.task;
  const conventions = [
    team?.instructions ? `# Team conventions (the team's AGENTS.md; they hold in every channel)\n${team.instructions}\n\n` : "",
    c.channel.conventions ? `# How #${c.channel.name} works (its members wrote this; it comes before the team's conventions)\n${c.channel.conventions}\n\n` : "",
    c.requester_preferences?.trim() ? `# ${c.creator.name}'s preferences (they asked for this task; where they differ from the conventions above, the conventions win)\n${c.requester_preferences.trim()}\n\n` : "",
  ].join("");
  return `You are ${a.name} (@${a.handle}), an AI teammate in a Remi workspace, running headless on your owner's machine.
${a.description ? `Your role: ${a.description}\n` : ""}People @-mention you in a channel with requests; this is one of them. Many are questions: just answer them.

# Your memory (memory.md)
${a.memory?.trim() || "(empty)"}
${c.memory_writable === false ? "Do not update your memory on this task (leave \"memory\" out of your result): it is in a private channel, and what you keep would reach people outside it.\n" : ""}
${RULES(wd, c)}${t.repo ? `\nRepository: ${t.repo}` : ""}

${conventions}# Channel #${c.channel.name}
${c.channel.topic ? `Purpose: ${c.channel.topic}\n` : ""}Latest messages (oldest first, cut to 600 characters; \`remi read\` for more):
${quote(c, c.recent) || "(none)"}

# Request ${t.id}: ${t.title}${t.tracked ? " (tracked as a task)" : ""}
Asked by ${c.creator.name} (@${c.creator.handle}).${mandateLine(c)}
The request and its thread:
${quote(c, c.thread)}

# Acceptance criteria
${t.acceptance?.trim() || "(none given: decide sensible criteria for this request, work to them, and return them in \"acceptance\")"}
${t.readonly ? `\n${PATROL}\n` : mayAlign(t) ? `\n${ALIGN}\n` : ""}${c.read_token ? `\n${LOOKUP}\n` : ""}${c.agents?.trim() ? `\n${AGENTS(c.agents)}\n` : ""}${c.callback_url ? `\nCallback address for outside services (a POST there wakes you while you wait; it may not be reachable from the internet): ${c.callback_url}\n` : ""}
${REACT}

${RESULT_SPEC}`;
}

const HELD: Record<string, string> = { quota: "hit its usage limit", billing: "ran out of credit", auth: "was logged out", not_installed: "is not installed" };

/** A fresh session after the task's owner switched it to another runtime (换引擎继续): what happened, where things are. */
export function switchedPrompt(c: Claim): string {
  const e = c.task.engine;
  if (!e || e.state !== "switched" || !c.task.runtime || c.task.runtime !== c.agent.runtime) return "";
  const from = RUNTIME_NAMES[e.from] ?? e.from;
  return `

# Going on with another runtime
This task ran with ${from} on this computer until ${from} ${HELD[e.reason] ?? "stopped taking work"}; your owner switched
this task to you (${RUNTIME_NAMES[c.agent.runtime] ?? c.agent.runtime}). This is a fresh session: ${from}'s session is not
available, so the request and its thread above are the record of what happened (\`remi read --thread\` for all of it).
The work directory is as ${from} left it: look at the commits on the task branch and the files not yet committed
(\`git log\`, \`git status\`), then go on from there rather than starting over. Before redoing anything that acts
outside (a submission, a deployment, a message), check whether it already happened.`;
}

/** The first run on the computer a task moved to: where it got to, as far as the checkpoint says. */
export async function movedPrompt(c: Claim, wd: Workdir): Promise<string> {
  const all = [wd, ...Object.values(wd.extra ?? {})];
  const how = all.some((x) => x.restored === "checkpoint") ? "checkpoint" : all.some((x) => x.restored === "branch") ? "branch" : "none";
  const at = c.task.checkpoint?.at ? new Date(c.task.checkpoint.at).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "";
  const state: string[] = [];
  for (const x of all.filter((x) => x.repo)) {
    const log = x.base ? (await git(x.cwd, "log", "--oneline", "-20", `${x.base}..HEAD`)).out : "";
    const dirty = (await git(x.cwd, "status", "--porcelain")).out.split("\n").filter(Boolean).slice(0, 30).join("\n");
    state.push(`${x.cwd}:\nCommits on ${x.branch}: ${log ? `\n${log}` : "(none)"}\nChanged, not committed: ${dirty ? `\n${dirty}` : "(none)"}`);
  }
  return `

# Going on from another computer
This task started on another of your owner's computers, which went away; your owner moved it to this one. This is a
fresh session: the request and its thread above are the record of what happened (\`remi read --thread\` for all of it).
${how === "checkpoint" ? `Your work directory was restored from the checkpoint${at ? ` of ${at}` : ""}: the commits and the files not yet committed are as they were then. Work done after it was lost (about 10 minutes at most): find what is missing and redo it.`
  : how === "branch" ? "There was no checkpoint, only the task branch as it was last pushed: your branch starts from it; changes not committed then were lost."
  : "There was no checkpoint: your work directory is fresh. Start over, taking the thread into account."}
${state.length ? `\n${state.join("\n\n")}\n` : ""}Before redoing anything that acts outside (a submission, a deployment, a message), check whether it already happened.`;
}

/** The other agents it may turn to (the server's \`remi who\` list), and when to. */
const AGENTS = (list: string) => `# Other agents you may turn to
${list.trim()}
Do the work yourself unless another agent is clearly the right one for a part (its repository or computer, its
speciality). Two ways, both in this thread:
- \`remi delegate @AGENT WHAT\`: it does a part and its result comes back to you; the task stays yours. Write WHAT as
  results it can check. Delegate several parts if they are independent, then end with status waiting, wait
  {"how": "delegates"}: you are woken once with all their results, check them, and deliver the whole yourself.
- \`remi handoff @AGENT WHAT\`: the work is theirs from then on and its result goes to a person, not to you.
"no card": it starts at once; "needs a card": its owner says yes first.
To only find something out (how its repository does a thing, a fact on its computer), \`remi ask @AGENT QUESTION\`:
it answers in one read-only run, not a task, and the answer reaches you in this session; go on meanwhile. Only "no card"
agents, at most 3 questions per task.`;

/** The first thing the agent says: one emoji on the request, showing how it read it (the way a teammate reacts in chat). */
const REACT = `Before anything else (before any tool call), send one short message whose first line is exactly
react: <one emoji>
choosing the emoji from how you read this request, the way a teammate reacts in chat: e.g. 🔍 a lookup or question, 🐛 a
bug to fix, 🛠️ a change to make, 📝 writing, 📊 numbers or a report, 🎨 design, 🤔 unclear (say what is unclear when you
report), 🙌 a quick yes. Pick what fits; it goes on the person's message in the channel.
If fulfilling the request needs you to act beyond replying (change files, run commands that change something, open a
pull request, submit to an outside service, produce a file), claim it as a task in that same message with a second line
task: <a short title, under 30 characters, in the people's language, saying what the work is>
so the team can track it. Only answering a question or talking needs no claim. When the request is already tracked as a
task, still give that line: it names the task on the team's board (people may rename it later).`;

const WAKE: Record<Wake["reason"], string> = {
  callback: "the outside service called your callback address",
  done: "your check command says the outside job is done",
  failed: "your check command says the outside job failed",
  errors: "your check command failed three times in a row",
  timer: "the time you set has come",
  deadline: "the deadline of your wait passed without a result: check once more; if you still cannot confirm it, report review with result unconfirmed (or blocked if it clearly went wrong)",
  message: "a person said something in the thread",
  quota: "the usage limit of your runtime that stopped your last turn has reset",
  delegates: "everything you delegated is back",
};

/** A woken turn: why it woke, what was posted, what people said meanwhile. */
export function wakePrompt(c: Claim): string {
  const w = c.wake!;
  if (w.reason === "delegates") return `You were waiting for the parts you delegated; all of them are back. What came back:

${(w.payload ?? "").slice(0, 20000)}
${c.new.length ? `\nPeople in the task's thread said meanwhile:\n${quote(c, c.new)}\n` : ""}
Check each against what you asked (look at their branches, PRs and outputs; run what you can). If one is not right, send
it back with \`remi delegate @AGENT WHAT TO CHANGE\` (each at most twice) and end with status waiting, wait
{"how": "delegates"}. A part that failed: do it yourself, delegate it to another agent, or stop with needs_decision.
When the whole is right, put it together and report review: your summary and evidence may cite their PRs and outputs.
A person accepts only your result.

${RESULT_SPEC}`;
  if (w.reason === "quota") return `Your last turn was cut off by the usage limit of your runtime; it has reset now. Continue from where you got to; do not redo steps that already took effect.
${c.new.length ? `\nPeople in the task's thread said meanwhile:\n${quote(c, c.new)}\n` : ""}
${RESULT_SPEC}`;
  return `You were waiting; you are woken because ${WAKE[w.reason] ?? w.reason}.${w.note ? `\nLast note: ${w.note}` : ""}${w.payload ? `\nWhat was posted to your callback address:\n${w.payload.slice(0, 20000)}` : ""}
${c.new.length ? `\nPeople in the task's thread said meanwhile:\n${quote(c, c.new)}\n` : ""}
Look at the result, check it against the acceptance criteria, save what people should see in out/ (a preview picture of
an outside result too), and report; wait again only if it is still running.

${RESULT_SPEC}`;
}

/** A later turn of the same session: only what people said since, and the decision answer if there is one. */
export function followUpPrompt(c: Claim): string {
  return `People in the task's thread said more since your last turn:
${quote(c, c.new)}

Continue the task with this in mind (same rules as before).

${REACT}

${RESULT_SPEC}`;
}

/** Resuming a run that was stopped between two tool calls because news came: what people said, the repositories
 * that are ready now. The agent goes on with the same task in the same session. */
export function steerPrompt(c: Claim, ready: Record<string, Workdir>, problem = ""): string {
  const repos = Object.entries(ready).map(([remote, x]) => `- ${remote} is ready at ${x.cwd}, a git worktree on branch ${x.branch}: change it there and commit on that branch (the machine pushes it and opens the pull request after you stop).${SETUP(x)}`);
  if (problem) repos.push(`- The machine could not check out a repository you declared: ${problem}`);
  return `The machine paused you between two steps because something new came in while you worked.
${c.new.length ? `\nPeople in the task's thread said:\n${quote(c, c.new)}\n` : ""}${repos.length ? `\nRepositories you declared:\n${repos.join("\n")}\n` : ""}
Take this into account and continue the task from where you were (same rules as before). Do not redo steps that
already took effect. If people changed what they want, follow the latest word.

${RESULT_SPEC}`;
}

export type Api = (path: string, init?: RequestInit) => Promise<any>;

/** "90s", "5m", "2h", "1d" or a number of seconds → seconds (0 when it is none of these). */
export function seconds(v: string | number | undefined): number {
  if (typeof v === "number") return Math.max(0, Math.round(v));
  const m = String(v ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|min|h|d)?$/i);
  if (!m) return 0;
  const n = Number(m[1]), unit = (m[2] ?? "s").toLowerCase();
  return Math.round(n * (unit === "d" ? 86400 : unit === "h" ? 3600 : unit.startsWith("m") ? 60 : 1));
}

const waitFile = (root: string, id: string) => join(root, `${id}.wait.json`);

/** The check command's answer: its last JSON line. */
export function parseCheck(out: string): { state: "pending" | "done" | "failed"; note?: string } | null {
  for (const line of out.trim().split("\n").reverse()) {
    try {
      const j = JSON.parse(line.trim());
      if (["pending", "done", "failed"].includes(j?.state)) return { state: j.state, note: j.note ? String(j.note).slice(0, 300) : undefined };
    } catch {}
  }
  return null;
}

async function sh(cmd: string, cwd: string, env: Record<string, string>, timeoutMs = 60_000): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["sh", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out: code === 0 ? out : (err || out).trim().split("\n").slice(-3).join(" ") };
}

export type WorkerOptions = {
  api: Api;
  /** The team server's address: the agent's `remi` command reads the chat there. */
  server?: string;
  maxParallel: number;
  workRoot?: string;
  runtimes?: Record<string, Runtime>;
  afterRun?: AfterRun;
  /** Prepares a task's work directory (default: prepareWorkdir with resolveRepo). */
  workdir?: (c: Claim, root: string) => Promise<Workdir>;
  /** This machine's checkout of a task's repository (repos.ts). */
  resolveRepo?: (remote: string) => Promise<string>;
  /** Files to and from the server (outputs, previews, attachments). */
  files?: FileApi;
  /** Extra environment for the runtime (default: gateEnv, which stops git pushes and gh/glab writes). */
  env?: (wd: Workdir) => Record<string, string>;
  log?: (s: string) => void;
  logDir?: string;
  /** How often a step reaches the card, at most (ms). */
  stepEveryMs?: number;
  /** Stop a run that printed nothing for this long (ms; default 20 minutes), or ran this long in all (default 60). */
  stallMs?: number;
  timeoutMs?: number;
  /** Why a runtime cannot run here right now (not logged in), as far as the machine knows; null: it can. */
  runtimeReady?: (name: string) => string | null | Promise<string | null>;
  /** Sends a final report: "ok" (taken), "drop" (refused for good: a stale run) or "retry" (could not reach the
   * server). Default: through api, where no answer means retry. */
  send?: (path: string, body: Record<string, unknown>) => Promise<"ok" | "drop" | "retry">;
  /** How long a pause before a retry really is (tests shorten it). */
  pauseMs?: (ms: number) => number;
  /** When news comes during a tool call, how long to let the call finish before stopping the run anyway (ms; default 3 minutes). */
  steerWaitMs?: number;
  /** What the team config repository gives the runs (teamconfig.ts): conventions, MCP servers. */
  team?: () => TeamContext | null;
  /** Save checkpoints of the tasks' directories (checkpoint.ts): when a run stops, and this often while it runs (ms). */
  checkpoints?: boolean;
  checkpointEveryMs?: number;
};

const expand = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : resolve(p));

async function git(cwd: string, ...args: string[]): Promise<{ ok: boolean; out: string }> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { ok: code === 0, out: (code === 0 ? out : err).trim() };
}

/** The task's own worktree of its repository on its branch (made once, kept for its later turns), or an empty
 * directory for a general task. The repository is the task's own (found or cloned on this machine by `resolve`), or,
 * when the task names none, the agent's repo path. */
export async function prepareWorkdir(c: Claim, root: string, resolve?: (remote: string) => Promise<string>, fetchCheckpoint?: (taskId: string) => Promise<Uint8Array | null>): Promise<Workdir> {
  const dir = join(root, c.task.id);
  let repoPath = c.agent.repo ? expand(c.agent.repo) : "";
  if (c.task.repo) {
    if (!resolve) throw new Error(`这台机器不知道去哪找 ${c.task.repo}`);
    repoPath = await resolve(c.task.repo);
  }
  if (!repoPath) {
    let restored: Workdir["restored"];
    if (!existsSync(dir) && c.task.checkpoint?.files && fetchCheckpoint) { // it moved here: its directory as it was
      restored = "none";
      const data = await fetchCheckpoint(c.task.id).catch(() => null);
      if (data) {
        mkdirSync(dir, { recursive: true });
        const tgz = join(root, `.${c.task.id}.restore.tgz`);
        writeFileSync(tgz, data);
        const x = Bun.spawnSync(["tar", "-xzf", tgz, "-C", dir]);
        rmSync(tgz, { force: true });
        if (x.exitCode === 0) restored = "checkpoint";
      }
    }
    mkdirSync(join(dir, "in"), { recursive: true });
    mkdirSync(join(dir, "out"), { recursive: true });
    return { cwd: dir, writable: [], files: dir, ...(restored ? { restored } : {}) };
  }
  if (!existsSync(repoPath) || (!existsSync(join(repoPath, ".git")) && !(await git(repoPath, "rev-parse", "--git-dir")).ok)) {
    throw new Error(`@${c.agent.handle} 的仓库 ${c.agent.repo} 在这台机器上不存在或不是 git 仓库`);
  }
  const branch = c.task.branch || `agent/${c.task.id}`;
  const declared = new Set(c.task.repos ?? []);
  const point = c.task.moves ? c.task.checkpoint?.repos.find((r) => !declared.has(r.repo)) : undefined;
  const { base, common, setup, restored } = await worktree(repoPath, dir, branch, c.task.moves ? point ?? {} : undefined);
  const files = join(root, `${c.task.id}.files`);
  mkdirSync(join(files, "in"), { recursive: true });
  mkdirSync(join(files, "out"), { recursive: true });
  return { cwd: dir, repo: repoPath, base, branch, writable: [common, files], files, ...(setup ? { setup } : {}), ...(restored ? { restored } : {}) };
}

/** A worktree of the checkout at `repoPath` in `dir` on `branch` (made from the default branch the first time, kept
 * after), and the checkout's git directory (the run must be able to write it to commit). `point`: the task moved here
 * from another computer: a fresh worktree starts from its checkpoint (the branch at its first parent, the rest put
 * back as changes not committed), or else from the task branch that computer pushed. */
async function worktree(repoPath: string, dir: string, branch: string, point?: { commit?: string }): Promise<{ base: string; common: string; setup: string; restored?: Workdir["restored"] }> {
  const common = (await git(repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir")).out;
  await git(repoPath, "fetch", "--quiet", "origin").catch(() => null);
  let base = (await git(repoPath, "rev-parse", "--abbrev-ref", "origin/HEAD")).out;
  if (!base || base === "origin/HEAD" || base.includes("fatal")) base = (await git(repoPath, "rev-parse", "--abbrev-ref", "HEAD")).out;
  if (!existsSync(dir)) {
    mkdirSync(dirname(dir), { recursive: true });
    const exists = (await git(repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).ok;
    let start = base, wip = "", restored: Workdir["restored"];
    if (!exists && point) {
      restored = "none";
      if (point.commit) {
        const got = await git(repoPath, "fetch", "--quiet", "origin", `+refs/heads/${branch}-wip:refs/remi/moved/${branch}-wip`);
        if ((await git(repoPath, "cat-file", "-e", `${point.commit}^{commit}`)).ok) wip = point.commit;
        else if (got.ok) wip = (await git(repoPath, "rev-parse", `refs/remi/moved/${branch}-wip`)).out;
      }
      if (wip) { start = `${wip}^1`; restored = "checkpoint"; }
      else if ((await git(repoPath, "fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remi/moved/${branch}`)).ok) { start = `refs/remi/moved/${branch}`; restored = "branch"; }
    }
    const r = exists ? await git(repoPath, "worktree", "add", dir, branch) : await git(repoPath, "worktree", "add", "-b", branch, dir, start);
    if (!r.ok) throw new Error(`开 worktree 失败：${r.out}`);
    if (wip) { // what was not committed there comes back as changes not committed here
      const back = await git(dir, "restore", `--source=${wip}`, "--worktree", "--", ".");
      if (!back.ok) restored = "none";
    }
    await git(repoPath, "for-each-ref", "--format=%(refname)", "refs/remi/moved/").then(async (x) => {
      for (const ref of x.out.split("\n").filter(Boolean)) await git(repoPath, "update-ref", "-d", ref);
    });
    return { base, common, setup: await runSetup(dir), ...(restored ? { restored } : {}) };
  }
  return { base, common, setup: "" };
}

/** The repository's own preparation of a fresh worktree (install dependencies, generate code): .remi/setup.sh, run
 * once when the worktree is made, with the agents' git limits, at most 10 minutes. What came of it goes in the prompt. */
export const SETUP_SCRIPT = ".remi/setup.sh";
async function runSetup(dir: string): Promise<string> {
  if (!existsSync(join(dir, SETUP_SCRIPT))) return "";
  const r = await sh(`sh ${SETUP_SCRIPT}`, dir, { ...gateEnv({ cwd: dir, writable: [] }), REMI_WORKTREE: dir }, 10 * 60_000);
  return r.code === 0 ? "ok" : `failed (exit ${r.code}): ${r.out.slice(0, 300)}`;
}

/** Worktrees of the repositories the agent declared (`remi repo`), beside the task's directory in <id>.repos/, on
 * the task's branch; `wd` gets them (and may write them). Returns the ones made now. */
export async function prepareDeclared(c: Claim, root: string, wd: Workdir, resolve?: (remote: string) => Promise<string>): Promise<Record<string, Workdir>> {
  const made: Record<string, Workdir> = {};
  for (const remote of c.task.repos ?? []) {
    if (wd.extra?.[remote]) continue;
    if (!resolve) throw new Error(`这台机器不知道去哪找 ${remote}`);
    const repoPath = await resolve(remote);
    const dir = join(root, `${c.task.id}.repos`, remote.replace(/[^\w.-]+/g, "_"));
    const branch = c.task.branch || `agent/${c.task.id}`;
    const point = c.task.moves ? c.task.checkpoint?.repos.find((r) => r.repo === remote) ?? {} : undefined;
    const { base, common, setup, restored } = await worktree(repoPath, dir, branch, point);
    const x: Workdir = { cwd: dir, repo: repoPath, base, branch, writable: [], ...(setup ? { setup } : {}), ...(restored ? { restored } : {}) };
    wd.extra = { ...wd.extra, [remote]: x };
    wd.writable.push(dir, common);
    made[remote] = x;
  }
  return made;
}

/** Removes a task's folders: its worktree (the branch stays in the repository, so a task picked up again gets its
 * work back) or its general-task directory, and the in/ and out/ beside it. */
export async function removeWorkdir(root: string, id: string): Promise<void> {
  const dir = join(root, id);
  if (existsSync(dir)) {
    const common = (await git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir")).out;
    const inRepo = existsSync(join(dir, ".git")) && !!common && existsSync(common);
    if (inRepo) await git(dir, `--git-dir=${common}`, "worktree", "remove", "--force", dir);
    rmSync(dir, { recursive: true, force: true });
    if (inRepo) await git(root, `--git-dir=${common}`, "worktree", "prune");
  }
  rmSync(join(root, `${id}.files`), { recursive: true, force: true });
  const declared = join(root, `${id}.repos`);
  let names: string[] = [];
  try { names = readdirSync(declared); } catch {}
  for (const n of names) {
    const d = join(declared, n);
    const common = (await git(d, "rev-parse", "--path-format=absolute", "--git-common-dir")).out;
    if (common && existsSync(common)) { await git(d, `--git-dir=${common}`, "worktree", "remove", "--force", d); await git(root, `--git-dir=${common}`, "worktree", "prune"); }
  }
  rmSync(declared, { recursive: true, force: true });
}

/** Whether the run left anything in the task's worktrees: edits, or commits on its branch. */
async function touched(wd: Workdir): Promise<boolean> {
  for (const x of Object.values(wd.extra ?? {})) if (await touched(x)) return true;
  if (!wd.repo) return false;
  if ((await git(wd.cwd, "status", "--porcelain")).out) return true;
  return wd.base ? Number((await git(wd.cwd, "rev-list", "--count", `${wd.base}..HEAD`)).out) > 0 : false;
}

/** A patrol's changes to its worktrees go: back to where they started, files not committed removed. Says whether
 * there was anything to throw away. */
export async function discard(wd: Workdir): Promise<boolean> {
  let any = false;
  for (const x of [wd, ...Object.values(wd.extra ?? {})]) {
    if (!x.repo || !(await touched({ ...x, extra: {} }))) continue;
    any = true;
    if (x.base) await git(x.cwd, "reset", "--hard", "--quiet", x.base);
    else await git(x.cwd, "reset", "--hard", "--quiet");
    await git(x.cwd, "clean", "-fdq");
  }
  return any;
}

/** The files under out/ (relative paths), at most `max`, skipping hidden ones. */
export function outFiles(out: string, max = 50): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    let names: string[] = [];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      if (found.length >= max || n.startsWith(".")) continue;
      const p = join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) found.push(relative(out, p));
    }
  };
  walk(out);
  return found;
}

export type FileApi = {
  /** A file of out/ to the task's outputs. */
  upload(taskId: string, name: string, data: Uint8Array): Promise<boolean>;
  /** A preview picture of an output. */
  preview(taskId: string, query: string, data: Uint8Array): Promise<boolean>;
  /** A thread attachment ("/media/…"). */
  download(path: string): Promise<Uint8Array | null>;
  /** A general task's packed directory, its checkpoint (checkpoint.ts): its id on the server. */
  checkpoint?(taskId: string, data: Uint8Array): Promise<{ id: string; size: number } | null>;
  /** The packed directory back, on the computer the task moved to. */
  restore?(taskId: string): Promise<Uint8Array | null>;
};

const MAX_OUT_FILE = 50 << 20;

/** Upload what is new or changed in out/ since the last time (by content), and say what could not go. */
export async function uploadOut(files: FileApi, taskId: string, dir: string): Promise<string[]> {
  const out = join(dir, "out"), seenFile = join(dir, ".uploaded.json");
  let seen: Record<string, string> = {};
  try { seen = JSON.parse(readFileSync(seenFile, "utf8")); } catch {}
  const notes: string[] = [];
  for (const name of outFiles(out)) {
    const data = readFileSync(join(out, name));
    if (data.length > MAX_OUT_FILE) { notes.push(`${name} 超过 50 MB，没有上传`); continue; }
    const hash = new Bun.CryptoHasher("sha256").update(data).digest("hex");
    if (seen[name] === hash) continue;
    if (await files.upload(taskId, name, data)) seen[name] = hash;
    else notes.push(`${name} 上传失败`);
  }
  try { writeFileSync(seenFile, JSON.stringify(seen)); } catch {}
  return notes;
}

/** The thread's attachments into in/ (once each). */
export async function fetchInputs(files: FileApi, c: Claim, dir: string) {
  const inDir = join(dir, "in");
  for (const m of [...c.thread, ...c.new]) {
    for (const a of m.attachments ?? []) {
      if (!a.startsWith("/media/")) continue;
      const p = join(inDir, inName(a));
      if (existsSync(p)) continue;
      const data = await files.download(a);
      if (data) writeFileSync(p, data);
    }
  }
}

/** Git configuration for the agent's process only: every push goes to an address that refuses it, and gh/glab see
 * no credentials of their own. The daemon pushes the task branch itself, with its normal environment. First on the
 * PATH are read-only gh and glab (readOnlyGitTools): agents can look at PRs, CI and commits with the machine's own
 * login, and nothing else. */
export function gateEnv(wd: Workdir): Record<string, string> {
  const prefixes = ["https://", "http://", "ssh://", "git@", "git://", "file://", "/"];
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(prefixes.length) };
  prefixes.forEach((p, i) => {
    env[`GIT_CONFIG_KEY_${i}`] = "url.no-push://teamagent-agents-may-not-push/.pushInsteadOf";
    env[`GIT_CONFIG_VALUE_${i}`] = p;
  });
  const empty = join(wd.cwd, "..", ".no-credentials");
  mkdirSync(empty, { recursive: true });
  readOnlyGitTools();
  return { ...env, GH_CONFIG_DIR: empty, GLAB_CONFIG_DIR: empty, GH_TOKEN: "", GITHUB_TOKEN: "", GITLAB_TOKEN: "",
    PATH: `${gateBin()}:${process.env.PATH ?? "/usr/bin:/bin"}` };
}

/** The machine's own Git platform logins, for the read-only gh and glab (startTeamAgent sets them from the config;
 * gh's and glab's own stored logins work without). `dir`: where the two commands are written (tests). */
type GateCreds = { github?: string; gitlab?: { host: string; token: string }[]; dir?: string };
let gateCreds: GateCreds = {};
export function setGateCredentials(c: GateCreds) { gateCreds = c; }
const gateBin = () => gateCreds.dir ?? join(process.env.NOOP_HOME || join(homedir(), ".noop"), "teamagent", "gate-bin");

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const DENY = "推分支和开 PR 由机器做，合并由人做";

/** `gh api` / `glab api`: GET only (a request with fields and no method is a POST); a GraphQL query, not a mutation.
 * A GraphQL query must be written in the arguments: one read from a file or stdin (a field value starting with @,
 * --input) could hide a mutation. */
const API_CHECK = `api)
    method=""; body=""; graphql=""; fromfile=""; prev=""
    for a in "$@"; do
      case "$prev" in -X|--method) method=$a ;; esac
      case "$a" in
        -X?*) method=\${a#-X} ;;
        --method=*) method=\${a#--method=} ;;
        -f|-F|--field|--raw-field|--input|-f?*|-F?*|--field=*|--raw-field=*|--input=*) body=1 ;;
        graphql) graphql=1 ;;
      esac
      case "$a" in --input|--input=*|*=@*) fromfile=1 ;; esac
      case "$prev" in --input) fromfile=1 ;; esac
      case "$a" in *mutation*) no "api（GraphQL mutation）" ;; esac
      prev=$a
    done
    [ -n "$graphql" ] && [ -n "$fromfile" ] && no "api graphql（查询从文件或标准输入读）：把查询直接写在参数里"
    method=$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')
    if [ -n "$method" ]; then [ "$method" = GET ] || [ "$method" = HEAD ] || { [ -n "$graphql" ] && [ "$method" = POST ]; } || no "api -X $method"
    elif [ -n "$body" ] && [ -z "$graphql" ]; then no "api（带字段就是 POST，读用 -X GET）"; fi ;;`;

/** The read-only gh and glab, written where gateEnv puts them first on the agents' PATH. Each lets through what only
 * reads (PRs / MRs, CI runs, issues, releases, the repository, GET requests) and runs the real command with the
 * machine's own login; anything else is refused with a line that says who does it. A guardrail, as the push gate is:
 * the Computer is the permission boundary. */
export function readOnlyGitTools(): void {
  const dir = gateBin();
  mkdirSync(dir, { recursive: true });
  const real = (bin: string) => {
    const path = (process.env.PATH ?? "").split(":").filter((p) => p && resolve(p) !== resolve(dir)).join(":");
    return Bun.which(bin, { PATH: path });
  };
  const write = (name: string, text: string | null) => {
    const p = join(dir, name);
    if (text === null) { rmSync(p, { force: true }); return; }
    if (!existsSync(p) || readFileSync(p, "utf8") !== text) writeFileSync(p, text, { mode: 0o700 });
  };
  const gh = real("gh");
  const ghConfig = process.env.GH_CONFIG_DIR;
  write("gh", gh && `#!/bin/sh
# gh for agents (Remi), read-only: pull requests, CI runs, issues, releases and the repository, with this machine's
# own login. ${DENY}.
no() { echo "remi: 这里的 gh 只读（看 PR、CI、issue、提交），不能 gh $1。${DENY}。" >&2; exit 1; }
case "$1" in
  ""|help|--help|-h|version|--version|status|search) ;;
  pr) case "$2" in list|view|checks|diff|status) ;; *) no "pr $2" ;; esac ;;
  issue) case "$2" in list|view|status) ;; *) no "issue $2" ;; esac ;;
  run) case "$2" in list|view|watch) ;; *) no "run $2" ;; esac ;;
  workflow|release) case "$2" in list|view) ;; *) no "$1 $2" ;; esac ;;
  repo) case "$2" in view|list) ;; *) no "repo $2" ;; esac ;;
  ${API_CHECK}
  *) no "$1" ;;
esac
${ghConfig ? `export GH_CONFIG_DIR=${sq(ghConfig)}` : "unset GH_CONFIG_DIR"}
${gateCreds.github ? `export GH_TOKEN=${sq(gateCreds.github)}` : "unset GH_TOKEN GITHUB_TOKEN"}
export GH_NO_UPDATE_NOTIFIER=1 GH_PROMPT_DISABLED=1
exec ${sq(gh)} "$@"
`);
  const glab = real("glab");
  const glabConfig = process.env.GLAB_CONFIG_DIR;
  const gl = (gateCreds.gitlab ?? []).filter((g) => g.host && g.token);
  write("glab", glab && `#!/bin/sh
# glab for agents (Remi), read-only: merge requests, CI pipelines, issues, releases and the repository, with this
# machine's own login. ${DENY}.
no() { echo "remi: 这里的 glab 只读（看 MR、CI、issue、提交），不能 glab $1。${DENY}。" >&2; exit 1; }
case "$1" in
  ""|help|--help|-h|version|--version) ;;
  mr) case "$2" in list|view|diff) ;; *) no "mr $2" ;; esac ;;
  ci|pipeline) case "$2" in list|status|get|trace) ;; *) no "$1 $2" ;; esac ;;
  issue|release) case "$2" in list|view) ;; *) no "$1 $2" ;; esac ;;
  repo) case "$2" in view|list) ;; *) no "repo $2" ;; esac ;;
  ${API_CHECK}
  *) no "$1" ;;
esac
${glabConfig ? `export GLAB_CONFIG_DIR=${sq(glabConfig)}` : "unset GLAB_CONFIG_DIR"}
${gl.length === 1 ? `export GITLAB_TOKEN=${sq(gl[0].token)} GITLAB_HOST=${sq(gl[0].host)}` : "unset GITLAB_TOKEN"}
exec ${sq(glab)} "$@"
`);
}

/** The agent's own read-only command for the team chat (as in Raft, where agents read and search with a CLI): it
 * asks the server with the run's read token, which works only while the task runs and only in the agent's channels. */
export const REMI_CLI = `#!/bin/sh
# remi (also installed as teamagent): the team chat, from inside your task.
#   remi read [--channel NAME] [--limit N] [--before SEQ]   a channel's latest messages (default: this task's)
#   remi read --thread MSG                                 a whole thread
#   remi search WORDS [--channel NAME]                     messages with all the words, newest first
#   remi tasks [--status todo|in_progress|in_review|done|closed] [--channel NAME]
#   remi task T-0001                                       one task: acceptance, summary, PR
#   remi channel [NAME]                                    what a channel is for, who is in it
#   remi who [@HANDLE]                                     who someone is; alone: the agents you may turn to
#   remi file /media/... > FILE                            a file attached to a message (as remi read shows it)
#   remi memory                                            your memory.md as it is now
#   remi say TEXT                                          a word on how it goes, in this task's thread (every 5 min at most)
#   remi upload FILE                                       hand over a file now (the rest of out/ goes when you stop)
#   remi ask @WHO QUESTION                                 ask a person or an agent in the thread and go on; the answer reaches you
#   remi repo OWNER/NAME                                   you will read or change this repository: it is checked out for you
#   remi handoff @WHO WHAT                                 pass the ball: to a person now; to an agent now or once its owner agrees
#   remi delegate @AGENT WHAT                              have another agent do a part; its result comes back to you
#   remi submit WHAT                                       count a submission to an outside service (at most 3 per task)
#   remi propose [--key KEY] [--urgent] TITLE --why WHY --plan PLAN
#                                                          propose work for a person to say yes to (it is not done now)
#   remi remind [daily|weekdays|weekly|every 30m] [WHEN] [@WHO] TEXT    remind @WHO (default: you, in this thread)
#                                                          at WHEN: 20m, 2h, 9:30, tomorrow 9:00, fri 15:00, 2026-12-01 10:00
#   remi reminders                                         the reminders you set or that bring you back (id, next, until)
#   remi remind cancel ID... | --here                      stop them (--here: the ones for you in this thread)
api="$REMI_URL/api/v1/agent"
auth="Authorization: Bearer $REMI_TOKEN"
usage() { sed -n '2,24p' "$0" | sed 's/^# \\{0,1\\}//'; exit 2; }
case "$1" in
  read|search|tasks) path=$1 ;;
  task) [ -n "$2" ] || usage; path="tasks/$2"; shift ;;
  channel) [ -n "$2" ] && set -- "$1" --channel "$2"; path=channel ;;
  who) exec curl -sS -G "$api/who" -H "$auth" --data-urlencode "handle=$2" ;;
  file) [ -n "$2" ] || usage; exec curl -sS -f -G "$api/file" -H "$auth" --data-urlencode "path=$2" ;;
  memory) exec curl -sS "$api/memory" -H "$auth" ;;
  say) shift; [ -n "$*" ] || usage; printf '%s' "$*" | curl -sS "$api/say" -H "$auth" -H "content-type: text/plain; charset=utf-8" --data-binary @-; exit $? ;;
  reminders) exec curl -sS "$api/reminders" -H "$auth" ;;
  remind) shift; [ -n "$*" ] || usage
    if [ "$1" = cancel ]; then
      shift; [ -n "$*" ] || usage
      printf '%s' "$*" | curl -sS "$api/remind/cancel" -H "$auth" -H "content-type: text/plain; charset=utf-8" --data-binary @-; exit $?
    fi
    printf '%s' "$*" | curl -sS "$api/remind" -H "$auth" -H "content-type: text/plain; charset=utf-8" --data-binary @-; exit $? ;;
  ask) shift; [ -n "$*" ] || usage; printf '%s' "$*" | curl -sS "$api/ask" -H "$auth" -H "content-type: text/plain; charset=utf-8" --data-binary @-; exit $? ;;
  handoff) shift; [ -n "$*" ] || usage; printf '%s' "$*" | curl -sS "$api/handoff" -H "$auth" -H "content-type: text/plain; charset=utf-8" --data-binary @-; exit $? ;;
  delegate) shift; [ -n "$*" ] || usage; printf '%s' "$*" | curl -sS "$api/delegate" -H "$auth" -H "content-type: text/plain; charset=utf-8" --data-binary @-; exit $? ;;
  submit) shift; [ -n "$*" ] || usage; printf '%s' "$*" | curl -sS "$api/submit" -H "$auth" -H "content-type: text/plain; charset=utf-8" --data-binary @-; exit $? ;;
  propose) shift; key=""; urgent=""; why=""; plan=""; title=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --key) key=$2; shift 2 ;;
        --why) why=$2; shift 2 ;;
        --plan) plan=$2; shift 2 ;;
        --urgent) urgent=1; shift ;;
        *) title="\${title:+$title }$1"; shift ;;
      esac
    done
    [ -n "$title" ] && [ -n "$plan" ] || usage
    exec curl -sS "$api/propose" -H "$auth" --data-urlencode "title=$title" --data-urlencode "why=$why" --data-urlencode "plan=$plan" --data-urlencode "key=$key" --data-urlencode "urgent=$urgent" ;;
  repo) [ -n "$2" ] || usage; exec curl -sS "$api/repo" -H "$auth" -H "content-type: text/plain; charset=utf-8" --data-binary "$2" ;;
  upload) [ -f "$2" ] || usage; exec curl -sS "$api/upload" -H "$auth" -H "content-type:" --url-query "name=$(basename "$2")" --data-binary @"$2" ;;
  *) usage ;;
esac
shift
q=""
n=$#
while [ "$n" -gt 0 ]; do
  a=$1; shift; n=$((n-1))
  case "$a" in
    --channel|--thread|--limit|--before|--status)
      v=$1; shift; n=$((n-1))
      set -- "$@" --data-urlencode "\${a#--}=$v" ;;
    *) q="\${q:+$q }$a" ;;
  esac
done
[ -n "$q" ] && set -- "$@" --data-urlencode "q=$q"
exec curl -sS -G "$api/$path" -H "$auth" "$@"
`;

/** The command on the runtime's PATH, and what it needs. */
export function cliEnv(root: string, server: string, token: string): Record<string, string> {
  const bin = join(root, ".bin");
  mkdirSync(bin, { recursive: true });
  // "teamagent" is the command's first name: agents and notes written before the rename still use it
  for (const name of ["remi", "teamagent"]) {
    const p = join(bin, name);
    if (!existsSync(p) || readFileSync(p, "utf8") !== REMI_CLI) writeFileSync(p, REMI_CLI, { mode: 0o755 });
  }
  // the read-only gh and glab (gateEnv) stay right after it
  return { REMI_URL: server.replace(/\/$/, ""), REMI_TOKEN: token, PATH: `${bin}:${gateBin()}:${process.env.PATH ?? "/usr/bin:/bin"}` };
}

const LOOKUP = `# The remi command
You see only the request, its thread and a few recent messages here. When you need more of the team's context, look it
up with the \`remi\` command in your shell (\`remi\` alone lists everything):
- remi read                      this channel's latest messages (--channel NAME for another, --before SEQ for older)
- remi read --thread MSG         a whole thread (the msg=… of a message)
- remi search WORDS              messages with all the words, newest first
- remi tasks [--status in_progress]   the team's tasks;  remi task T-0001   one of them
- remi channel / remi who @HANDLE     what a channel is for and who is in it; who someone is
- remi who                       the other agents you may turn to (as in the list below, when there is one)
- remi file /media/…  > FILE     a file someone attached (remi read shows them)
Look up only what the request needs. When you need someone's answer to go on (a choice only they can make, a fact
only they know), ask with \`remi ask @WHO QUESTION\` and keep working on what does not depend on it: their reply
reaches you in this session. Ask only what you cannot find out yourself. When the work needs a repository's files or
commit history you do not have here, to read or to change them, declare it with \`remi repo owner/name\` first; the
status of a pull request or CI run needs no checkout (\`gh pr view N -R owner/name\`, \`glab mr list -R group/name\`). When part of the work is someone else's to do (a
person must do or check something; another agent is the right one for the next step), pass it on with
\`remi handoff @WHO WHAT\`: a person gets the ball at once; another agent gets it at once where the person who asked
may use it directly ("no card" in \`remi who\`), else only once its owner agrees on a card. Do not @-mention agents to
make them work. On a long task you may also tell the thread how it goes with \`remi say TEXT\` (at
most every 5 minutes, only when people would want to know), and hand over a file before you stop with
\`remi upload FILE\`. When someone wants to be reminded, or wants something done later or again and again ("remind me in
2 minutes", "remind me on Friday…", "every morning…"), always set it with
\`remi remind [daily|weekdays|weekly] WHEN [@WHO] TEXT\` (WHEN: 2m, 1h, 3d, 9:30, tomorrow 9:00, fri 17:00), then finish
at once. For "every N minutes / hours" (report on a merge request every 10 minutes), \`remi remind every 10m TEXT\` (at
least 10m) brings you back to this thread each time: look, say what changed in your result, and finish. It is skipped
while you are still on it and stops by itself after a day; a person who wants it longer sets it themselves. When the
person says to stop, pause or that it is no longer needed, run \`remi remind cancel --here\` (or
\`remi remind cancel ID\` with an id from \`remi reminders\`) and say in the thread that it has stopped; never say a
reminder can't be cancelled. Never wait or sleep to reply later yourself: a reply in the thread reaches nobody, while a reminder goes to the
person's "Waiting for you" and their system notifications. When you notice work worth doing beyond what you were asked
(a failing check, an outdated dependency), do not do it: propose it with
\`remi propose --key SHORT-WORD TITLE --why WHAT-YOU-SAW --plan WHAT-DONE-LOOKS-LIKE\`. It reaches the person this task
is for with their next batch of proposals; if they say yes, it becomes a task with your plan as its acceptance. Use the
same --key for the same thing every time (a newer one replaces the older); add --urgent only when leaving it until
tomorrow does harm today. Your result still goes in the result block at the end.`;

/** The run went quiet or hit its limit and was stopped: the same session goes on once, told so. */
export function stoppedPrompt(why: "stall" | "timeout", minutes: number): string {
  return `The machine stopped your last turn: ${why === "stall" ? `it printed nothing for ${minutes} minutes` : `it ran for ${minutes} minutes, the limit of one turn`}.
Continue from where you got to. Run anything slow (a long build, a test suite, a deployment) in the background and
return "waiting" with a way to check it, instead of waiting in place.

${RESULT_SPEC}`;
}

/** The provider failed or was busy; the same session goes on after a pause. */
export function retryPrompt(error: string): string {
  return `Your last turn was cut off by an error from the model service (${error.slice(0, 200)}). Continue from where you got to; do not redo steps that already took effect.

${RESULT_SPEC}`;
}

/** The agent worked but ended without the result block: it is asked for the block alone, once. */
export const RESULT_ONLY = `Your last message did not end with the result block. Do not redo or change anything: reply with only the
\`\`\`json result block for the work you already did, in the format below.

${RESULT_SPEC}`;

/** A limit that resets within this long is waited for inside the run; a later one by the server. */
const SHORT_WAIT = 5 * 60_000;

const hasResultBlock = (text: string) => /```json\s*\{[\s\S]*?"status"[\s\S]*?\}\s*```/.test(text);

/** Another agent's question this machine's agent answers (server teamask.go): a read-only run, not a task. */
export type AskClaim = {
  ask: { id: string; question: string; task: string; repo?: string };
  agent: TeamAgent & { repo?: string; memory?: string };
  from: { handle: string; name: string };
  requester: { handle: string; name: string };
  channel: { name: string; topic?: string };
  thread: TeamMessage[];
  names: Record<string, string>;
};

/** The prompt of a run answering another agent's question. */
export function askPrompt(c: AskClaim, wd: Workdir): string {
  const a = c.agent;
  const thread = c.thread.map((m) => `- ${c.names[m.author.id] ?? (m.author.kind === "agent" ? "an agent" : "someone")}: ${m.text.replace(/\n/g, "\n  ")}`).join("\n");
  return `You are ${a.name} (@${a.handle}), an AI teammate in a Remi workspace, running headless on your owner's machine.
${a.description ? `Your role: ${a.description}\n` : ""}
@${c.from.handle} (${c.from.name}), another agent working on a task for ${c.requester.name} (@${c.requester.handle}), asks you a
question in a thread of #${c.channel.name}. Answer it from what you can read: files on this computer${wd.repo ? `, and the
repository checked out (read-only) in ${wd.cwd}` : ""}.

This is a read-only run, not a task: do not create, change or delete any file, do not run anything that changes
something, and do not push, post or send anything. Whatever you change is thrown away. You cannot ask anyone else,
delegate or hand anything on: answer with what you can find.

Reply with the answer only, in the language of the question, as plain text (no result block): short and specific, and
say where you found it (file paths, lines). If you cannot find out, say so and what would tell.

# Your memory (memory.md)
${a.memory?.trim() || "(empty)"}

# The thread (oldest first)
${thread || "(none)"}

# The question
${c.ask.question}`;
}

/** Where a question is answered: a detached worktree of the repository the asking task works in (when this machine has
 * it) or of the agent's own repository, else an empty directory. It is removed after the run. */
export async function askWorkdir(c: AskClaim, root: string, resolveRepo?: (remote: string) => Promise<string>): Promise<Workdir> {
  const dir = join(root, `ask-${c.ask.id}`);
  let repoPath = "";
  if (c.ask.repo && resolveRepo) repoPath = await resolveRepo(c.ask.repo).catch(() => "");
  if (!repoPath && c.agent.repo) repoPath = expand(c.agent.repo);
  if (repoPath && existsSync(repoPath) && (await git(repoPath, "rev-parse", "--git-dir")).ok) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    const head = (await git(repoPath, "rev-parse", "HEAD")).out;
    const r = await git(repoPath, "worktree", "add", "--detach", dir, "HEAD");
    if (r.ok) return { cwd: dir, repo: repoPath, base: head, writable: [] };
  }
  mkdirSync(dir, { recursive: true });
  return { cwd: dir, writable: [] };
}

/** Whether the run changed anything in its directory (what is then thrown away). */
export async function askTouched(wd: Workdir): Promise<boolean> {
  if (wd.repo) return !!(await git(wd.cwd, "status", "--porcelain")).out || (await git(wd.cwd, "rev-parse", "HEAD")).out !== wd.base;
  try { return readdirSync(wd.cwd).length > 0; } catch { return false; }
}

async function removeAskDir(wd: Workdir) {
  if (wd.repo) {
    await git(wd.repo, "worktree", "remove", "--force", wd.cwd);
    await git(wd.repo, "worktree", "prune");
  }
  rmSync(wd.cwd, { recursive: true, force: true });
}

/** A trigger's check command to run here first (server teamchecks.go). */
export type TriggerCheck = { id: string; agent_id: string; cmd: string; repo?: string; agent_repo?: string };
/** How long a check command may run. */
export const CHECK_TIMEOUT = 60_000;
const CHECK_OUTPUT = 4000;

/** Runs a check command with the agents' git limits: what it printed, its hash, or why it failed. */
export async function runCheckCommand(cmd: string, cwd: string, env: Record<string, string>, timeoutMs = CHECK_TIMEOUT): Promise<{ hash?: string; output: string; error?: string }> {
  const p = Bun.spawn(["sh", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  let out = "", err = "";
  const read = async (s: ReadableStream<Uint8Array>, add: (t: string) => void) => {
    const dec = new TextDecoder();
    for await (const chunk of s) add(dec.decode(chunk, { stream: true }));
  };
  const done = Promise.all([read(p.stdout, (t) => { out += t; }), read(p.stderr, (t) => { err += t; }), p.exited]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = await Promise.race([done.then(() => false), new Promise<boolean>((r) => { timer = setTimeout(() => r(true), timeoutMs); })]);
  clearTimeout(timer);
  if (late) {
    p.kill(9);
    return { error: `超时（${Math.round(timeoutMs / 1000)} 秒）`, output: (out + err).slice(-CHECK_OUTPUT) };
  }
  const code = p.exitCode ?? 0;
  if (code !== 0) return { error: `退出码 ${code}`, output: (err || out).slice(-CHECK_OUTPUT) };
  return { hash: new Bun.CryptoHasher("sha256").update(out).digest("hex"), output: out.slice(0, CHECK_OUTPUT) };
}

export function createWorker(o: WorkerOptions) {
  const log = o.log ?? ((s: string) => console.log(`remi: ${s}`));
  const root = o.workRoot ?? join(homedir(), ".noop", "teamagent", "work");
  const runtimes = o.runtimes ?? RUNTIMES;
  const running = new Map<string, Promise<void>>();
  const kills = new Map<string, () => void>();
  /** Running tasks with news: stop the run between two tool calls and resume it with the news. */
  const steers = new Map<string, () => void>();
  const claiming = new Set<string>();
  /** What happens once a run is over (its last checkpoint), by task. */
  const afterRuns = new Map<string, () => Promise<unknown>>();
  let stopped = false;
  const ckDeps = { api: (path: string, init?: RequestInit) => o.api(withMoves(path, path.split("/")[4] ?? ""), init), dir: join(root, ".checkpoints"), log, upload: o.files?.checkpoint?.bind(o.files) };
  /** Saves are one at a time per task (the timer and the run's stop may meet). */
  const saving = new Map<string, Promise<unknown>>();
  const checkpoint = (id: string, wd: Workdir, filesAllowed: boolean) => {
    const p = (saving.get(id) ?? Promise.resolve()).then(() => saveCheckpoint(ckDeps, id, wd, filesAllowed))
      .catch((e) => log(`${id} 存检查点出错：${e instanceof Error ? e.message : e}`));
    saving.set(id, p);
    return p.finally(() => { if (saving.get(id) === p) saving.delete(id); });
  };
  /** An ended task's checkpoints go (its wip branches, the local refs). */
  const dropping = new Set<string>();
  const drop = async (id: string) => {
    if (!o.checkpoints || dropping.has(id) || running.has(id)) return;
    dropping.add(id);
    try { await saving.get(id); await dropCheckpoint(ckDeps, id); } catch {} finally { dropping.delete(id); }
  };

  /** The move count each running task was claimed with: its calls name it, and the server refuses them once the task
   * moved to another computer (server teammove.go). */
  const runMoves = new Map<string, number>();
  /** Running tasks that moved to another computer: their runs stop and leave nothing behind (no push, PR or report). */
  const movedAway = new Set<string>();
  const withMoves = (path: string, id: string) => runMoves.has(id) ? `${path}${path.includes("?") ? "&" : "?"}moves=${runMoves.get(id)}` : path;
  const report = (id: string, body: Record<string, unknown>) => o.api(withMoves(`/api/v1/tasks/${id}/report`, id), { method: "POST", body: JSON.stringify(body) });

  // A run's final report is written to the outbox first and deleted once the server took it (or refused it for good),
  // so a report lost to a network blip or a restart is sent again instead of the task being run again. It names its
  // run: the server takes one final report per run, so sending it twice never posts twice.
  const outbox = join(root, ".outbox");
  const send = o.send ?? (async (path: string, body: Record<string, unknown>) =>
    ((await o.api(path, { method: "POST", body: JSON.stringify(body) }).catch(() => null)) ? "ok" as const : "retry" as const));
  const sending = new Set<string>();
  async function sendOut(file: string): Promise<boolean> {
    if (sending.has(file)) return false;
    sending.add(file);
    try {
      const { id, body, moves } = JSON.parse(readFileSync(join(outbox, file), "utf8"));
      const res = await send(`/api/v1/tasks/${id}/report${typeof moves === "number" ? `?moves=${moves}` : ""}`, body);
      if (res === "retry") return false;
      if (res === "drop") log(`${id} 的结果服务端不再接收（这次运行已经无效），丢弃`);
      rmSync(join(outbox, file), { force: true });
      return true;
    } catch {
      rmSync(join(outbox, file), { force: true }); // unreadable: nothing to send
      return true;
    } finally {
      sending.delete(file);
    }
  }
  async function finish(t: TeamTask, body: Record<string, unknown>) {
    mkdirSync(outbox, { recursive: true });
    const file = `${t.id}-${t.runs || 0}.json`;
    writeFileSync(join(outbox, file), JSON.stringify({ id: t.id, body: { ...body, ...(t.runs ? { run: t.runs } : {}) }, ...(runMoves.has(t.id) ? { moves: runMoves.get(t.id) } : {}) }));
    if (!(await sendOut(file))) log(`${t.id} 的结果暂时发不出去，连上后重发`);
  }
  /** Sends what is waiting in the outbox, oldest first. */
  async function flush() {
    let files: string[] = [];
    try { files = readdirSync(outbox).filter((f) => f.endsWith(".json")).sort((a, b) => statSync(join(outbox, a)).mtimeMs - statSync(join(outbox, b)).mtimeMs); } catch { return; }
    for (const f of files) if (!(await sendOut(f))) return; // the server is not there: try again later
  }
  /** The tasks whose final report has not reached the server yet: they are not to be run again. */
  const unsent = (id: string) => { try { return readdirSync(outbox).some((f) => f.startsWith(`${id}-`)); } catch { return false; } };

  async function run(c: Claim) {
    const t = c.task;
    runMoves.set(t.id, t.moves ?? 0);
    const rt = runtimes[c.agent.runtime || "codex"];
    if (!rt || !rt.available()) {
      await finish(t, { state: "blocked", summary: `这台机器上没有 ${c.agent.runtime || "codex"}，装好并登录后在线程里回复一句即可重试`, failure: "not_installed" });
      return;
    }
    const notReady = await o.runtimeReady?.(c.agent.runtime || "codex");
    if (notReady) {
      await finish(t, { state: "blocked", summary: notReady, failure: "auth" });
      return;
    }
    let wd: Workdir;
    try {
      wd = await (o.workdir ?? ((cl, r) => prepareWorkdir(cl, r, o.resolveRepo, o.files?.restore?.bind(o.files))))(c, root);
      await prepareDeclared(c, root, wd, o.resolveRepo);
    } catch (e) {
      await finish(t, { state: "blocked", summary: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (o.files && wd.files) await fetchInputs(o.files, c, wd.files).catch(() => null);
    let cancelled = false;
    if (o.checkpoints && !t.readonly) { // while it runs, every 10 minutes; once more when it stops (unless it was cancelled); a patrol keeps nothing
      const ckWd = wd, files = c.checkpoint_files === true;
      const timer = setInterval(() => void checkpoint(t.id, ckWd, files), o.checkpointEveryMs ?? CHECKPOINT_EVERY);
      afterRuns.set(t.id, async () => { clearInterval(timer); if (!cancelled && !stopped) await checkpoint(t.id, ckWd, files); });
    }
    const resume = t.session;
    const prompt = !resume ? taskPrompt(c, wd, o.team?.()) + (t.moves ? await movedPrompt(c, wd) : "") + switchedPrompt(c) : c.wake ? wakePrompt(c) : c.new.length ? followUpPrompt(c) : `Continue the task where you left off (the machine restarted).\n\n${RESULT_SPEC}`;
    let lastStep = 0, pendingStep = "";
    const every = o.stepEveryMs ?? 5000;
    let stepTimer: ReturnType<typeof setTimeout> | undefined;
    const flushStep = () => { stepTimer = undefined; if (pendingStep) void report(t.id, { step: pendingStep }); lastStep = Date.now(); pendingStep = ""; };
    let reacted = false, claimed = false;
    // steering: news came while it runs. Between tool calls the run is stopped at once; during one, when it ends (or
    // after steerWaitMs). The loop below then takes the news (a claim of the running task) and resumes the session.
    let busy = false, steerWanted = false, steered = false, handle: { kill: () => void } | undefined;
    let steerTimer: ReturnType<typeof setTimeout> | undefined;
    const steerNow = () => { clearTimeout(steerTimer); if (!handle || steered) return; steered = true; handle.kill(); };
    steers.set(t.id, () => {
      if (steerWanted) return;
      steerWanted = true;
      if (!busy) steerNow();
      else steerTimer = setTimeout(steerNow, o.steerWaitMs ?? 3 * 60_000);
    });
    const onEvent = (e: RunEvent) => {
      if (e.kind === "step") busy = true;
      if (e.kind === "idle") { busy = false; if (steerWanted) steerNow(); return; }
      if (e.kind === "session") void report(t.id, { session: e.id, branch: wd.branch ?? "" });
      if (e.kind === "message" && !reacted) {
        const emoji = reactionOf(e.text);
        if (emoji) { reacted = true; void report(t.id, { reaction: emoji }); }
      }
      if (e.kind === "message" && !claimed && (!t.tracked || !t.titled)) {
        const title = taskClaimOf(e.text);
        if (title !== null) { claimed = true; void report(t.id, { track: true, ...(title ? { title } : {}) }); }
      }
      if (e.kind !== "step") return;
      pendingStep = e.text;
      if (Date.now() - lastStep >= every) flushStep();
      else stepTimer ??= setTimeout(flushStep, every - (Date.now() - lastStep));
    };
    const stallMs = o.stallMs ?? 20 * 60_000, timeoutMs = o.timeoutMs ?? 60 * 60_000;
    let usage: Usage | undefined, wakeUp = () => {};
    const tc = o.team?.(), teamMcp = tc && Object.keys(tc.mcp).length ? { servers: tc.mcp, file: tc.mcpFile } : null;
    const go = async (resumeId: string, text: string): Promise<RunResult> => {
      const h = rt.start({
        cwd: wd.cwd, prompt: text, resume: resumeId || undefined, writable: wd.writable, onEvent, model: c.agent.model || undefined, stallMs, timeoutMs,
        ...(teamMcp ? { mcp: teamMcp } : {}),
        env: { ...(o.env ?? gateEnv)(wd), ...(o.server && c.read_token ? cliEnv(root, o.server, c.read_token) : {}) }, logFile: o.logDir ? join(o.logDir, `${t.id}-${Date.now()}.jsonl`) : undefined,
      });
      handle = h;
      kills.set(t.id, () => { cancelled = true; h.kill(); });
      if (movedAway.has(t.id)) kills.get(t.id)!(); // it moved while the folder was being made: stop before it works
      const res = await h.done;
      handle = undefined;
      if (res.usage) usage = addUsage(usage, res.usage);
      return res;
    };
    // a pause before trying again, cut short when the task is cancelled
    const pause = (ms: number) => new Promise<void>((res) => {
      const timer = setTimeout(res, o.pauseMs ? o.pauseMs(ms) : ms);
      wakeUp = () => { clearTimeout(timer); res(); };
      kills.set(t.id, () => { cancelled = true; wakeUp(); });
    });
    log(`${t.id} @${c.agent.handle} 开工：${t.title}${resume ? "（续）" : ""}`);
    let r: RunResult = await go(resume, prompt), resumed = !!resume;
    let failure: Failure | null = null, retries = 0, fresh = false, continued = false, emptyRetried = false, shortWaits = 0, quotaAt = 0;
    for (;;) {
      if (cancelled) break;
      if (r.killed && steered) { // stopped for news: take it (the server hands it over with a claim) and go on
        steered = steerWanted = busy = false;
        const fresh: Claim | null = await o.api(`/api/v1/tasks/${t.id}/claim`, { method: "POST" }).catch(() => null);
        if (cancelled) break;
        if (fresh?.task) c = fresh;
        let ready: Record<string, Workdir> = {}, problem = "";
        try { ready = await prepareDeclared(c, root, wd, o.resolveRepo); } catch (e) { problem = e instanceof Error ? e.message : String(e); }
        log(`${t.id} 有新消息，在同一会话里续跑${Object.keys(ready).length ? `（仓库 ${Object.keys(ready).join(" ")} 已就绪）` : ""}`);
        const session = r.session || resume;
        r = session ? await go(session, steerPrompt(c, ready, problem)) : await go("", taskPrompt(c, wd, o.team?.()));
        resumed = !!session;
        continue;
      }
      if (r.killed) break;
      // an empty completion (no text, no step, no error) is a flake of the tool chain: once more, as it was
      if (!r.text && !r.error && !r.stopped && r.exitCode === 0 && !r.steps && !emptyRetried) { emptyRetried = true; r = await go(resume, prompt); continue; }
      const f = classify({ ...r, resumed });
      if (!f) break;
      const plan = planFor(f, c.agent.runtime || "codex");
      if (f === "quota" || f === "rate_limited") {
        // a limit: a reset a few minutes out is waited for here, a later one (or none, once the short retries are
        // used up) by the server, which wakes the task in this session when it is time (design 「额度等重置」)
        const at = resetAt(failureText(r));
        if (at !== undefined && at - Date.now() <= SHORT_WAIT && shortWaits < 2) {
          shortWaits++;
          const wait = at - Date.now() + 5_000;
          log(`${t.id} ${FAILURE_TEXT[f]}，${Math.ceil(wait / 60_000)} 分钟后重试`);
          void report(t.id, { step: `${FAILURE_TEXT[f]}，${Math.ceil(wait / 60_000)} 分钟后重试` });
          await pause(wait);
          if (cancelled) break;
          r = r.session ? await go(r.session, retryPrompt(r.error ?? f)) : await go(resume, prompt);
          resumed = !!(r.session || resume);
          continue;
        }
        if (f === "quota" || at !== undefined || retries >= (plan.act === "retry" ? plan.afterMs.length : 0)) { quotaAt = at ?? 0; failure = "quota"; break; }
      }
      if (plan.act === "retry" && retries < plan.afterMs.length) {
        const wait = plan.afterMs[retries++]!;
        log(`${t.id} ${FAILURE_TEXT[f]}，${Math.round(wait / 60_000)} 分钟后重试（第 ${retries} 次）`);
        void report(t.id, { step: `${FAILURE_TEXT[f]}，${Math.round(wait / 60_000)} 分钟后重试（第 ${retries} 次）` });
        await pause(wait);
        if (cancelled) break;
        r = r.session ? await go(r.session, retryPrompt(r.error ?? f)) : await go(resume, prompt);
        resumed = !!(r.session || resume);
        continue;
      }
      if (plan.act === "fresh" && !fresh) {
        fresh = true;
        log(`${t.id} ${FAILURE_TEXT[f]}，换新会话重来`);
        r = await go("", taskPrompt(c, wd, o.team?.()));
        resumed = false;
        continue;
      }
      if (plan.act === "continue" && !continued && r.session) {
        continued = true;
        log(`${t.id} ${FAILURE_TEXT[f]}，在同一会话里续跑一次`);
        r = await go(r.session, stoppedPrompt(r.stopped ?? "stall", Math.round((r.stopped === "timeout" ? timeoutMs : stallMs) / 60_000)));
        resumed = true;
        continue;
      }
      failure = f;
      break;
    }
    // it worked but forgot the result block: ask for the block alone, once (a plain answer with no steps is fine as it is)
    if (!failure && !r.killed && !cancelled && r.text && r.steps && r.session && !hasResultBlock(r.text)) {
      const again = await go(r.session, RESULT_ONLY);
      if (!again.killed && !cancelled && hasResultBlock(again.text)) r = { ...again, text: again.text };
      else if (again.killed || cancelled) r = again;
    }
    clearTimeout(stepTimer);
    if (r.killed || cancelled) { log(`${t.id} 已停止`); return; }
    if (failure === "quota") { // the server keeps it waiting, says so on the card and the machine's runtime, and wakes it
      const detail = failureText(r).trim().split("\n").slice(-2).join(" ").slice(0, 300);
      await finish(t, { state: "waiting", failure: "quota", retry_at: quotaAt, note: detail, summary: "", session: r.session || resume, ...(usage ? { usage } : {}) });
      log(`${t.id} → 等额度恢复${quotaAt ? `（${new Date(quotaAt).toLocaleString()}）` : "（时间未知）"}`);
      return;
    }
    if (failure) {
      const plan = planFor(failure, c.agent.runtime || "codex");
      const detail = (r.error ?? r.stderr ?? "").trim().split("\n").slice(-3).join("\n").slice(0, 600);
      const summary = plan.act === "block" ? `${plan.why}${detail ? `\n\n${detail}` : ""}` : `运行失败（${FAILURE_TEXT[failure]}）：${detail || `退出码 ${r.exitCode}`}`;
      await finish(t, { state: plan.act === "block" ? "blocked" : "failed", summary, session: r.session, failure, ...(usage ? { usage } : {}) });
      log(`${t.id} → ${plan.act === "block" ? "blocked" : "failed"}（${failure}）`);
      return;
    }
    let result: TaskResult = r.text ? parseTaskResult(r.text) : { status: "failed" as const, summary: `运行失败：${r.error ?? `退出码 ${r.exitCode}`}` };
    if (result.status === "align" && !mayAlign(c.task) && r.session) { // once per task: told so, in the same session
      log(`${t.id} 已经对齐过，让它按现有标准继续`);
      const again = await go(r.session, ALIGNED_AGAIN);
      if (again.killed || cancelled) { log(`${t.id} 已停止`); return; }
      r = again;
      result = r.text ? parseTaskResult(r.text) : { status: "failed", summary: `运行失败：${r.error ?? `退出码 ${r.exitCode}`}` };
    }
    if (result.status === "align") {
      const list = (v: unknown) => (Array.isArray(v) ? v : String(v ?? "").split("\n")).map((x) => String(x).trim()).filter(Boolean);
      if (!mayAlign(c.task) || !list(result.acceptance).length) {
        await finish(t, { state: "blocked", summary: `${result.summary ? `${result.summary}\n\n` : ""}Agent 想再对齐一次（每个任务只对齐一次），没有开工：在线程里回一句它该怎么做`, session: r.session, ...(usage ? { usage } : {}) });
        return;
      }
      await finish(t, { state: "align", summary: result.summary, session: r.session, ...(usage ? { usage } : {}),
        align: { acceptance: list(result.acceptance), not_doing: list(result.not_doing), approach: String(result.approach ?? ""), dirty: await touched(wd) } });
      log(`${t.id} → align`);
      return;
    }
    if (await moved(t.id)) { log(`${t.id} 已经换到另一台电脑，这次运行作废：不推送、不开 PR`); return; }
    let extra: { pr?: PR; note?: string } | null = null;
    const morePRs: PR[] = [], moreNotes: string[] = [];
    if (t.readonly) { // a patrol: what it changed in a repository is thrown away, nothing is pushed
      if (await discard(wd)) { moreNotes.push("这是只读巡视，对仓库的改动已丢弃"); if (result.status === "nothing") result = { ...result, status: "review" }; }
      if (result.status === "nothing" && wd.files && outFiles(join(wd.files, "out")).length) result = { ...result, status: "review" }; // it made a report: that is something to hand over
    } else if (result.status === "nothing") result = { ...result, status: "review" }; // only a patrol may stay silent
    if (result.status === "nothing") {
      await finish(t, { state: "nothing", summary: result.summary, session: r.session, ...(usage ? { usage } : {}) });
      log(`${t.id} → nothing（巡视没有发现，不发消息）`);
      return;
    }
    if (o.afterRun && result.status === "review" && !t.readonly) {
      try { extra = await o.afterRun(c, result, wd); } catch (e) { extra = { note: `推送或开 PR 失败：${e instanceof Error ? e.message : e}` }; }
      for (const [remote, x] of Object.entries(wd.extra ?? {})) { // the repositories it declared: a PR each
        try {
          const got = await o.afterRun(c, result, x);
          if (got?.pr && !extra?.pr && !t.pr) extra = { ...extra, pr: got.pr };
          else if (got?.pr) morePRs.push(got.pr);
          if (got?.note) moreNotes.push(`${remote}：${got.note}`);
        } catch (e) { moreNotes.push(`${remote} 推送或开 PR 失败：${e instanceof Error ? e.message : e}`); }
      }
    }
    const notes: string[] = [];
    if (o.files && wd.files) notes.push(...await uploadOut(o.files, t.id, wd.files).catch((e) => [`上传产出失败：${e instanceof Error ? e.message : e}`]));
    const outputs = (Array.isArray(result.outputs) ? result.outputs : []).filter((x) => x && (x.title || x.external_id)).slice(0, 20);
    for (const pr of morePRs) outputs.push({ title: pr.title || `PR #${pr.number}`, service: pr.provider === "gitlab" ? "GitLab" : "GitHub", external_id: pr.url, url: pr.url, status: "ready", note: pr.repo });
    if (outputs.length) {
      await report(t.id, { outputs: outputs.map(({ preview: _p, ...x }) => ({ ...x, kind: "external" })) });
      for (const x of outputs) {
        if (!x.preview || !o.files) continue;
        const p = resolve(wd.cwd, x.preview);
        const q = x.external_id ? `external_id=${encodeURIComponent(x.external_id)}` : "";
        try { if (q && existsSync(p)) await o.files.preview(t.id, q, readFileSync(p)); } catch {}
      }
    }
    const summary = [result.summary, extra?.pr ? `PR：${extra.pr.url}` : "", ...morePRs.map((p) => `PR：${p.url}`), extra?.note ?? "", ...moreNotes, notes.join("；")].filter(Boolean).join("\n\n");
    const body: Record<string, unknown> = { state: result.status, summary, session: r.session, ...(usage ? { usage } : {}) };
    if (result.result === "confirmed" || result.result === "unconfirmed") body.result = result.result;
    if (result.status === "waiting" && result.wait) {
      const w = result.wait;
      writeFileSync(waitFile(root, t.id), JSON.stringify({ check: w.check ?? "", cancel: w.cancel ?? "", cwd: wd.cwd }));
      body.wait = { how: w.how, every: seconds(w.every), expect: seconds(w.expect), deadline: seconds(w.deadline), what: w.what ?? "" };
    }
    if (extra?.pr) body.pr = extra.pr;
    // Nothing changed (no commits or edits, no PR, no files, no outside results) and nothing left unconfirmed: the
    // summary is the whole result (a question answered, a lookup), so it needs nobody's acceptance.
    if (result.status === "review" && result.result !== "unconfirmed" && !extra?.pr && !t.pr && !outputs.length && !morePRs.length
      && !(wd.files && outFiles(join(wd.files, "out")).length) && !(await touched(wd))) body.answer = true;
    if (result.status === "review" && Array.isArray(result.evidence)) {
      body.evidence = result.evidence.filter((e) => e && Number.isInteger(Number(e.criterion))).slice(0, 20)
        .map((e) => ({ criterion: Number(e.criterion), how: String(e.how ?? ""), proof: String(e.proof ?? "").slice(0, 2000), ...(e.file ? { file: String(e.file) } : {}) }));
    }
    if (result.acceptance && !t.acceptance?.trim()) body.acceptance = Array.isArray(result.acceptance) ? result.acceptance.join("\n") : String(result.acceptance);
    if (c.memory_writable !== false && typeof result.memory === "string" && result.memory.trim() && result.memory.trim() !== (c.agent.memory ?? "").trim()) body.memory = result.memory.trim().slice(0, 8000);
    if (result.status === "needs_decision") body.decision = { question: result.question, options: result.options ?? [], recommendation: result.recommendation };
    await finish(t, body);
    log(`${t.id} → ${result.status}`);
  }

  async function claim(t: TeamTask) {
    if (stopped || running.has(t.id) || claiming.has(t.id) || running.size + claiming.size >= o.maxParallel) return;
    claiming.add(t.id);
    try {
      const c: Claim | null = await o.api(`/api/v1/tasks/${t.id}/claim`, { method: "POST" });
      if (!c?.task) return;
      const p = run(c).catch(async (e) => {
        log(`${t.id} 出错：${e instanceof Error ? e.message : e}`);
        await finish(c.task, { state: "failed", summary: `守护进程出错：${e instanceof Error ? e.message : e}` }).catch(() => null);
      }).then(async () => { await afterRuns.get(t.id)?.(); }).catch(() => {})
        .finally(() => { running.delete(t.id); kills.delete(t.id); steers.delete(t.id); afterRuns.delete(t.id); runMoves.delete(t.id); movedAway.delete(t.id); void poll(); });
      running.set(t.id, p);
    } finally {
      claiming.delete(t.id);
    }
  }

  /** Another agent's question for one of this machine's agents: answered in one read-only run, then thrown away. */
  async function runAsk(c: AskClaim) {
    const id = c.ask.id, runtime = c.agent.runtime || "codex";
    const answer = (body: Record<string, unknown>) => o.api(`/api/v1/asks/${id}/answer`, { method: "POST", body: JSON.stringify(body) }).catch(() => null);
    const rt = runtimes[runtime];
    if (!rt || !rt.available()) { await answer({ error: `@${c.agent.handle} 的电脑上没有 ${runtime}` }); return; }
    const notReady = await o.runtimeReady?.(runtime);
    if (notReady) { await answer({ error: notReady }); return; }
    let wd: Workdir;
    try { wd = await askWorkdir(c, root, o.resolveRepo); } catch (e) { await answer({ error: e instanceof Error ? e.message : String(e) }); return; }
    log(`@${c.agent.handle} 回答 @${c.from.handle} 的问题（只读）`);
    try {
      const h = rt.start({ cwd: wd.cwd, prompt: askPrompt(c, wd), readOnly: true, model: c.agent.model || undefined,
        stallMs: Math.min(o.stallMs ?? 20 * 60_000, 10 * 60_000), timeoutMs: Math.min(o.timeoutMs ?? 60 * 60_000, 20 * 60_000),
        env: (o.env ?? gateEnv)({ cwd: wd.cwd, writable: [] }), logFile: o.logDir ? join(o.logDir, `${id}-${Date.now()}.jsonl`) : undefined });
      kills.set(id, () => h.kill());
      const r = await h.done;
      if (r.killed && stopped) return;
      const discarded = await askTouched(wd);
      const text = (r.text ?? "").replace(/```json[\s\S]*?```/g, "").replace(REACT_LINE, "").trim();
      await answer(text ? { text, discarded } : { error: r.error ?? (r.stopped ? "运行超时" : `退出码 ${r.exitCode}`), discarded });
      log(`@${c.agent.handle} 答完了 @${c.from.handle} 的问题${discarded ? "（改动已丢弃）" : ""}`);
    } finally {
      await removeAskDir(wd).catch(() => null);
    }
  }

  async function claimAsk(id: string) {
    if (stopped || running.has(id) || claiming.has(id) || running.size + claiming.size >= o.maxParallel) return;
    claiming.add(id);
    try {
      const c: AskClaim | null = await o.api(`/api/v1/asks/${id}/claim`, { method: "POST" }).catch(() => null);
      if (!c?.ask) return;
      const p = runAsk(c).catch((e) => log(`问题 ${id} 出错：${e instanceof Error ? e.message : e}`))
        .finally(() => { running.delete(id); kills.delete(id); void poll(); });
      running.set(id, p);
    } finally {
      claiming.delete(id);
    }
  }

  /** A trigger's check command (socket frame, or the poll's list): run here, out of the tasks' slots; the server
   * decides from the output whether the trigger fires. */
  const checksRunning = new Set<string>();
  async function onCheck(x: TriggerCheck) {
    if (stopped || !x?.id || !x.cmd || checksRunning.has(x.id)) return;
    checksRunning.add(x.id);
    try {
      let cwd = "";
      if (x.repo && o.resolveRepo) cwd = await o.resolveRepo(x.repo).catch(() => "");
      if (!cwd && x.agent_repo && existsSync(expand(x.agent_repo))) cwd = expand(x.agent_repo);
      if (!cwd) { cwd = join(root, ".checks", x.id); mkdirSync(cwd, { recursive: true }); }
      const r = await runCheckCommand(x.cmd, cwd, (o.env ?? gateEnv)({ cwd, writable: [] }));
      log(`触发器 ${x.id} 的检查命令${r.error ? `出错：${r.error}` : "跑完了"}`);
      await o.api(`/api/v1/triggers/${x.id}/check`, { method: "POST", body: JSON.stringify(r) }).catch(() => null);
    } catch (e) {
      log(`触发器 ${x.id} 的检查出错：${e instanceof Error ? e.message : e}`);
    } finally {
      checksRunning.delete(x.id);
    }
  }

  /** A question changed (socket frame, or the poll's list). */
  function onAsk(x: { id: string; agent_id: string; state: string }, mine: (agentId: string) => boolean) {
    if (x.state === "queued" && mine(x.agent_id)) void claimAsk(x.id);
  }

  /** Whether a running task moved to another computer since it was claimed here (asks the server when not told yet). */
  async function moved(id: string): Promise<boolean> {
    if (movedAway.has(id)) return true;
    if (!runMoves.has(id)) return false;
    const now: TeamTask | null = await o.api(`/api/v1/tasks/${id}`).catch(() => null);
    if (now?.id === id && (now.moves ?? 0) !== runMoves.get(id)) movedAway.add(id);
    return movedAway.has(id);
  }
  /** It moved: the run here stops and leaves nothing behind (its folder stays for the usual sweep). */
  function stopMoved(id: string) {
    if (!running.has(id)) return;
    movedAway.add(id);
    log(`${id} 换到了另一台电脑，停掉这里的运行`);
    kills.get(id)?.();
  }

  /** A task changed (socket frame, or the poll's list). */
  function onTask(t: TeamTask, mine: (agentId: string) => boolean) {
    if (!mine(t.agent_id)) return;
    if (runMoves.has(t.id) && (t.moves ?? 0) !== runMoves.get(t.id)) return stopMoved(t.id);
    if (t.state === "queued") void claim(t);
    else if (t.state === "running" && t.news) steers.get(t.id)?.();
    else if (t.state === "closed" || t.state === "done") {
      kills.get(t.id)?.(); // cancelled while it ran
      if (t.state === "closed") void cancelOutside(t.id);
      void (running.get(t.id) ?? Promise.resolve()).then(() => drop(t.id)); // ended: its checkpoints go
    }
  }

  /** A cancelled task that was waiting: its outside job is cancelled too, when the agent said how. */
  async function cancelOutside(id: string) {
    const f = waitFile(root, id);
    if (!existsSync(f)) return;
    try {
      const w = JSON.parse(readFileSync(f, "utf8"));
      if (w.cancel && existsSync(w.cwd)) {
        const r = await sh(w.cancel, w.cwd, (o.env ?? gateEnv)({ cwd: w.cwd, writable: [] }));
        log(`${id} 已取消，外部任务取消${r.code === 0 ? "成功" : `失败：${r.out}`}`);
      }
    } catch {}
    try { rmSync(f); } catch {}
  }

  /** The waiting tasks whose check is due: run their check commands here and say what they found. */
  const checking = new Set<string>();
  async function checkWaits() {
    if (stopped) return;
    const r = await o.api("/api/v1/machine/tasks?waiting=1");
    for (const t of (r?.tasks ?? []) as (TeamTask & { wait?: { next_at?: number } })[]) {
      if (checking.has(t.id) || running.has(t.id) || (t.wait?.next_at ?? 0) > Date.now()) continue;
      checking.add(t.id);
      void (async () => {
        let body: Record<string, unknown>;
        try {
          const w = JSON.parse(readFileSync(waitFile(root, t.id), "utf8"));
          if (!w.check) throw new Error("没有查询命令");
          const res = await sh(w.check, existsSync(w.cwd) ? w.cwd : root, (o.env ?? gateEnv)({ cwd: w.cwd, writable: [] }));
          const parsed = res.code === 0 ? parseCheck(res.out) : null;
          body = parsed ?? { error: res.code === 0 ? "查询命令没有输出 {\"state\": …}" : res.out || `退出码 ${res.code}` };
        } catch (e) {
          body = { error: e instanceof Error ? e.message : String(e) };
        }
        await o.api(`/api/v1/tasks/${t.id}/wait`, { method: "POST", body: JSON.stringify(body) }).catch(() => null);
      })().finally(() => checking.delete(t.id));
    }
  }

  /** The tasks waiting for this machine (also the ones it ran before a restart). */
  async function poll() {
    if (stopped) return;
    await flush(); // results from before a restart or a lost connection go first: those tasks must not run again
    const r = await o.api("/api/v1/machine/tasks");
    for (const t of (r?.tasks ?? []) as TeamTask[]) {
      if (runMoves.has(t.id) && (t.moves ?? 0) !== runMoves.get(t.id)) { stopMoved(t.id); continue; }
      if (t.state === "queued" || (t.state === "running" && !running.has(t.id) && !unsent(t.id))) void claim(t);
      else if (t.state === "running" && t.news) steers.get(t.id)?.();
    }
    // a task running here that the server no longer lists as this computer's: it may have moved (a missed frame)
    const listed = new Set(((r?.tasks ?? []) as TeamTask[]).map((t) => t.id));
    for (const id of runMoves.keys()) if (r && !listed.has(id)) void moved(id).then((m) => { if (m) stopMoved(id); });
    for (const x of (r?.asks ?? []) as { id: string }[]) void claimAsk(x.id);
    for (const x of (r?.checks ?? []) as TriggerCheck[]) void onCheck(x);
  }

  /** The folders of tasks that ended a week ago or more (the server says which; it keeps them that long in case
   * someone picks the task up again) go, so worktrees do not pile up on the machine. */
  async function sweep(): Promise<string[]> {
    await dropEnded().catch(() => null);
    let ids: string[] = [];
    try { ids = [...new Set(readdirSync(root).map((n) => n.replace(/\.(files|repos)$/, "")).filter((n) => /^T-\d+$/.test(n)))].sort(); } catch { return []; }
    ids = ids.filter((id) => !running.has(id) && !claiming.has(id) && !unsent(id));
    const removed: string[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const r = await o.api(`/api/v1/machine/tasks?ended=${ids.slice(i, i + 100).join(",")}`).catch(() => null);
      for (const t of (r?.tasks ?? []) as { id: string }[]) {
        if (!ids.includes(t.id) || running.has(t.id)) continue;
        await removeWorkdir(root, t.id).catch((e) => log(`清理 ${t.id} 的目录失败：${e instanceof Error ? e.message : e}`));
        removed.push(t.id);
      }
    }
    if (removed.length) log(`清理了已结束一周以上的任务目录：${removed.join(" ")}`);
    return removed;
  }

  /** The checkpoints of tasks that ended while this machine did not hear of it (it was off): their wip branches go. */
  async function dropEnded() {
    if (!o.checkpoints) return;
    const ids = keptCheckpoints(ckDeps.dir).filter((id) => !running.has(id) && !claiming.has(id));
    for (let i = 0; i < ids.length; i += 100) {
      const r = await o.api(`/api/v1/machine/tasks?ended=${ids.slice(i, i + 100).join(",")}&age=0`).catch(() => null);
      for (const t of (r?.tasks ?? []) as { id: string }[]) if (ids.includes(t.id)) await drop(t.id);
    }
  }

  return {
    onTask, onAsk, onCheck, poll, checkWaits, flush, sweep,
    running: () => [...running.keys()],
    idle: async () => { while (running.size || claiming.size) await Promise.all([...running.values(), Bun.sleep(10)]); },
    stop: () => { stopped = true; for (const k of kills.values()) k(); },
  };
}
