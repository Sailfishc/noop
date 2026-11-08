// TeamAgent tasks on this machine: claim the tasks of this machine's agents, run each in its own work directory (a git
// worktree of the agent's repository on branch agent/T-xxxx) with the agent's runtime, keep the task card's step up
// to date, and report the result. The next turn of a task (people replied in its thread, or answered its decision)
// resumes the same runtime session with only what is new.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { RUNTIMES, type RunEvent, type Runtime, type RunResult } from "./runtimes";
import type { TeamAgent, TeamMessage } from "./teamagent";

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
  /** The repository it runs in, host/owner/name ("" or missing: a general task, or the agent's own repo path). */
  repo?: string;
};
/** On whose word the agent works and how far it may go (fixed when the task was made). */
export type Mandate = { by: string; rule: string; confirm: boolean; joined?: boolean; autonomy: string; branch: string; runtime: string; model?: string };
export type Claim = {
  task: TeamTask; agent: TeamAgent & { repo?: string; memory?: string }; channel: { id: string; name: string; topic: string };
  recent: TeamMessage[]; thread: TeamMessage[]; new: TeamMessage[]; names: Record<string, string>;
  creator: { name: string; handle: string }; resumed: boolean;
};
export type TaskResult = {
  status: "review" | "needs_decision" | "blocked" | "failed";
  summary: string; question?: string; options?: string[]; recommendation?: string; pr_title?: string; pr_body?: string;
  /** The criteria the agent worked to, when people gave none. */
  acceptance?: string;
  /** The agent's memory.md as it wants it now, when it learned something lasting. */
  memory?: string;
  /** Results kept by outside services it called. */
  outputs?: ExternalOutput[];
};

/** Where a task runs. `repo` is the checkout this worktree belongs to. `files`: in/ (what people attached) and out/
 * (what goes back to the thread), inside cwd for a general task, beside the worktree for a repository task. */
export type Workdir = { cwd: string; repo?: string; base?: string; branch?: string; writable: string[]; files?: string };

/** What happens after a run: push the branch and open or update the PR (M3: gitflow.ts). */
export type AfterRun = (c: Claim, r: TaskResult, wd: Workdir) => Promise<{ pr?: PR; note?: string } | null>;

const STATUSES = new Set(["review", "needs_decision", "blocked", "failed"]);

/** The result block at the end of the agent's last message. Without one, the message itself is the summary. */
export function parseTaskResult(text: string): TaskResult {
  const blocks = [...text.matchAll(/```json\s*(\{[\s\S]*?\})\s*```/g)].map((m) => m[1]).reverse();
  for (const b of blocks) {
    try {
      const r = JSON.parse(b);
      if (STATUSES.has(r.status)) {
        const options = Array.isArray(r.options) ? r.options.map(String).filter(Boolean) : undefined;
        if (r.status === "needs_decision" && !String(r.question ?? "").trim()) return { ...r, status: "blocked", summary: String(r.summary ?? "") };
        return { ...r, summary: String(r.summary ?? ""), options };
      }
    } catch {}
  }
  const prose = text.replace(/```json[\s\S]*?```/g, "").trim();
  return prose ? { status: "review", summary: prose.slice(0, 4000) } : { status: "failed", summary: "Agent 没有给出结果" };
}

const who = (c: Claim, m: TeamMessage) => c.names[m.author.id] ?? (m.author.kind === "agent" ? "an agent" : "someone");
const quote = (c: Claim, ms: TeamMessage[]) => ms.map((m) => `- ${who(c, m)}: ${m.text.replace(/\n/g, "\n  ")}`).join("\n");

const RESULT_SPEC = `When you stop, end your final message with EXACTLY one fenced \`\`\`json block:
{
  "status": "review" | "needs_decision" | "blocked" | "failed",
  "summary": "1-3 sentences for the thread: what you did or found, with file paths, commands and links",
  "question": "needs_decision only: one short question",
  "options": ["A: <recommended> — consequence", "B: ... — consequence"],
  "recommendation": "A",
  "pr_title": "review with commits only: the pull request title",
  "pr_body": "review with commits only: what changed and how it was verified",
  "acceptance": "only when the task came without acceptance criteria: the criteria you worked to, one per line",
  "memory": "only when you learned something that will matter in later tasks (how the team works, a repo's quirks, people's preferences): your whole memory.md as it should be now, short bullet points, under 4000 characters",
  "outputs": [{"kind": "external", "title": "what it is", "service": "which service keeps it", "external_id": "its id there", "url": "https link to it", "status": "pending" | "ready" | "failed", "preview": "optional: path of a small picture of it you saved"}]
}
review = the work is ready for a person to look at; needs_decision = you need a person to choose before going on (do all the
preparation that does not depend on the answer first); blocked = you cannot go on without something you do not have;
failed = it cannot be done. When the task has acceptance criteria, say in the summary how each one is met (or which is
not, and why); do not report review while one is unmet. Write summary, question and options in the language the people in the thread use (Simplified
Chinese unless they write otherwise), plain text, no emoji.`;

const FILES = (wd: Workdir) => wd.files
  ? `\n- Files people attached to the thread are in ${join(wd.files, "in")}. Put what people should get that is not a code change (a report, a table, a picture) in ${join(wd.files, "out")}: every file there is uploaded to the thread when you stop. Keep drafts elsewhere.
- When you start work in an outside service (a cloud job, a render, a deployment), list it in "outputs" with its id there, and say plainly whether you saw its result.`
  : "";

const RULES = (wd: Workdir) => wd.repo
  ? `# Rules (enforced: breaking them fails)
- Work in ${wd.cwd}, a git worktree of ${wd.repo} on branch ${wd.branch}. Commit your changes on this branch with clear messages.
- Never push, force-push, merge, delete branches, or change other branches: the machine pushes ${wd.branch} and opens the pull request after you stop. Never run gh/glab commands that change anything.
- Run the project's tests or checks for what you changed before you stop, and say in the summary what you ran.${FILES(wd)}`
  : `# Rules
- Work in ${wd.cwd} (this task's own directory; no repository).${FILES(wd)}
- Never push to remote repositories, merge, or publish anything.`;

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

/** The first turn: who the agent is, what it remembers, where it works, the channel, the task and its thread. */
export function taskPrompt(c: Claim, wd: Workdir): string {
  const a = c.agent, t = c.task;
  return `You are ${a.name} (@${a.handle}), an AI teammate in a TeamAgent workspace, running headless on your owner's machine.
${a.description ? `Your role: ${a.description}\n` : ""}People hand you tasks by @-mentioning you in a channel; you work on one task now.

# Your memory (memory.md)
${a.memory?.trim() || "(empty)"}

${RULES(wd)}${t.repo ? `\nRepository: ${t.repo}` : ""}

# Channel #${c.channel.name}
${c.channel.topic ? `Purpose: ${c.channel.topic}\n` : ""}Latest messages (oldest first, cut to 600 characters):
${quote(c, c.recent) || "(none)"}

# Task ${t.id}: ${t.title}
Asked by ${c.creator.name} (@${c.creator.handle}).${mandateLine(c)}
The request and its thread:
${quote(c, c.thread)}

# Acceptance criteria
${t.acceptance?.trim() || "(none given: decide sensible criteria for this request, work to them, and return them in \"acceptance\")"}

${RESULT_SPEC}`;
}

/** A later turn of the same session: only what people said since, and the decision answer if there is one. */
export function followUpPrompt(c: Claim): string {
  return `People in the task's thread said more since your last turn:
${quote(c, c.new)}

Continue the task with this in mind (same rules as before).

${RESULT_SPEC}`;
}

export type Api = (path: string, init?: RequestInit) => Promise<any>;

export type WorkerOptions = {
  api: Api;
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
export async function prepareWorkdir(c: Claim, root: string, resolve?: (remote: string) => Promise<string>): Promise<Workdir> {
  const dir = join(root, c.task.id);
  let repoPath = c.agent.repo ? expand(c.agent.repo) : "";
  if (c.task.repo) {
    if (!resolve) throw new Error(`这台机器不知道去哪找 ${c.task.repo}`);
    repoPath = await resolve(c.task.repo);
  }
  if (!repoPath) {
    mkdirSync(join(dir, "in"), { recursive: true });
    mkdirSync(join(dir, "out"), { recursive: true });
    return { cwd: dir, writable: [], files: dir };
  }
  if (!existsSync(repoPath) || (!existsSync(join(repoPath, ".git")) && !(await git(repoPath, "rev-parse", "--git-dir")).ok)) {
    throw new Error(`@${c.agent.handle} 的仓库 ${c.agent.repo} 在这台机器上不存在或不是 git 仓库`);
  }
  const common = (await git(repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir")).out;
  const branch = c.task.branch || `agent/${c.task.id}`;
  await git(repoPath, "fetch", "--quiet", "origin").catch(() => null);
  let base = (await git(repoPath, "rev-parse", "--abbrev-ref", "origin/HEAD")).out;
  if (!base || base === "origin/HEAD" || base.includes("fatal")) base = (await git(repoPath, "rev-parse", "--abbrev-ref", "HEAD")).out;
  if (!existsSync(dir)) {
    mkdirSync(root, { recursive: true });
    const exists = (await git(repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).ok;
    const r = exists ? await git(repoPath, "worktree", "add", dir, branch) : await git(repoPath, "worktree", "add", "-b", branch, dir, base);
    if (!r.ok) throw new Error(`开 worktree 失败：${r.out}`);
  }
  const files = join(root, `${c.task.id}.files`);
  mkdirSync(join(files, "in"), { recursive: true });
  mkdirSync(join(files, "out"), { recursive: true });
  return { cwd: dir, repo: repoPath, base, branch, writable: [common, files], files };
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
      const name = basename(decodeURIComponent(a)).replace(/[^\w.\-\u4e00-\u9fff]+/g, "_").slice(-120);
      const p = join(inDir, name);
      if (existsSync(p)) continue;
      const data = await files.download(a);
      if (data) writeFileSync(p, data);
    }
  }
}

/** Git configuration for the agent's process only: every push goes to an address that refuses it, and gh/glab see
 * no credentials. The daemon pushes the task branch itself, with its normal environment. */
export function gateEnv(wd: Workdir): Record<string, string> {
  const prefixes = ["https://", "http://", "ssh://", "git@", "git://", "file://", "/"];
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(prefixes.length) };
  prefixes.forEach((p, i) => {
    env[`GIT_CONFIG_KEY_${i}`] = "url.no-push://teamagent-agents-may-not-push/.pushInsteadOf";
    env[`GIT_CONFIG_VALUE_${i}`] = p;
  });
  const empty = join(wd.cwd, "..", ".no-credentials");
  mkdirSync(empty, { recursive: true });
  return { ...env, GH_CONFIG_DIR: empty, GLAB_CONFIG_DIR: empty, GH_TOKEN: "", GITHUB_TOKEN: "", GITLAB_TOKEN: "" };
}

export function createWorker(o: WorkerOptions) {
  const log = o.log ?? ((s: string) => console.log(`teamagent: ${s}`));
  const root = o.workRoot ?? join(homedir(), ".noop", "teamagent", "work");
  const runtimes = o.runtimes ?? RUNTIMES;
  const running = new Map<string, Promise<void>>();
  const kills = new Map<string, () => void>();
  const claiming = new Set<string>();
  let stopped = false;

  const report = (id: string, body: Record<string, unknown>) => o.api(`/api/v1/tasks/${id}/report`, { method: "POST", body: JSON.stringify(body) });

  async function run(c: Claim) {
    const t = c.task;
    const rt = runtimes[c.agent.runtime || "codex"];
    if (!rt || !rt.available()) {
      await report(t.id, { state: "blocked", summary: `这台机器上没有 ${c.agent.runtime || "codex"}，装好并登录后在线程里回复一句即可重试` });
      return;
    }
    let wd: Workdir;
    try {
      wd = await (o.workdir ?? ((cl, r) => prepareWorkdir(cl, r, o.resolveRepo)))(c, root);
    } catch (e) {
      await report(t.id, { state: "blocked", summary: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (o.files && wd.files) await fetchInputs(o.files, c, wd.files).catch(() => null);
    const resume = t.session;
    const prompt = !resume ? taskPrompt(c, wd) : c.new.length ? followUpPrompt(c) : `Continue the task where you left off (the machine restarted).\n\n${RESULT_SPEC}`;
    let lastStep = 0, pendingStep = "";
    const every = o.stepEveryMs ?? 5000;
    let stepTimer: ReturnType<typeof setTimeout> | undefined;
    const flushStep = () => { stepTimer = undefined; if (pendingStep) void report(t.id, { step: pendingStep }); lastStep = Date.now(); pendingStep = ""; };
    const onEvent = (e: RunEvent) => {
      if (e.kind === "session") void report(t.id, { session: e.id, branch: wd.branch ?? "" });
      if (e.kind !== "step") return;
      pendingStep = e.text;
      if (Date.now() - lastStep >= every) flushStep();
      else stepTimer ??= setTimeout(flushStep, every - (Date.now() - lastStep));
    };
    const start = (resumeId: string, text: string) => rt.start({
      cwd: wd.cwd, prompt: text, resume: resumeId || undefined, writable: wd.writable, onEvent, model: c.agent.model || undefined,
      env: (o.env ?? gateEnv)(wd), logFile: o.logDir ? join(o.logDir, `${t.id}-${Date.now()}.jsonl`) : undefined,
    });
    log(`${t.id} @${c.agent.handle} 开工：${t.title}${resume ? "（续）" : ""}`);
    let h = start(resume, prompt);
    kills.set(t.id, () => h.kill());
    let r: RunResult = await h.done;
    if (resume && !r.killed && r.exitCode !== 0 && !r.text) { // the session is gone (another machine, cleaned up): start over
      h = start("", taskPrompt(c, wd));
      kills.set(t.id, () => h.kill());
      r = await h.done;
    }
    clearTimeout(stepTimer);
    if (r.killed) { log(`${t.id} 已停止`); return; }
    const result = r.text ? parseTaskResult(r.text) : { status: "failed" as const, summary: `运行失败：${r.error ?? `退出码 ${r.exitCode}`}` };
    let extra: { pr?: PR; note?: string } | null = null;
    if (o.afterRun && result.status === "review") {
      try { extra = await o.afterRun(c, result, wd); } catch (e) { extra = { note: `推送或开 PR 失败：${e instanceof Error ? e.message : e}` }; }
    }
    const notes: string[] = [];
    if (o.files && wd.files) notes.push(...await uploadOut(o.files, t.id, wd.files).catch((e) => [`上传产出失败：${e instanceof Error ? e.message : e}`]));
    const outputs = (Array.isArray(result.outputs) ? result.outputs : []).filter((x) => x && (x.title || x.external_id)).slice(0, 20);
    if (outputs.length) {
      await report(t.id, { outputs: outputs.map(({ preview: _p, ...x }) => ({ ...x, kind: "external" })) });
      for (const x of outputs) {
        if (!x.preview || !o.files) continue;
        const p = resolve(wd.cwd, x.preview);
        const q = x.external_id ? `external_id=${encodeURIComponent(x.external_id)}` : "";
        try { if (q && existsSync(p)) await o.files.preview(t.id, q, readFileSync(p)); } catch {}
      }
    }
    const summary = [result.summary, extra?.pr ? `PR：${extra.pr.url}` : "", extra?.note ?? "", notes.join("；")].filter(Boolean).join("\n\n");
    const body: Record<string, unknown> = { state: result.status, summary, session: r.session };
    if (extra?.pr) body.pr = extra.pr;
    if (result.acceptance && !t.acceptance?.trim()) body.acceptance = String(result.acceptance);
    if (typeof result.memory === "string" && result.memory.trim() && result.memory.trim() !== (c.agent.memory ?? "").trim()) body.memory = result.memory.trim().slice(0, 8000);
    if (result.status === "needs_decision") body.decision = { question: result.question, options: result.options ?? [], recommendation: result.recommendation };
    await report(t.id, body);
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
        await report(t.id, { state: "failed", summary: `守护进程出错：${e instanceof Error ? e.message : e}` }).catch(() => null);
      }).finally(() => { running.delete(t.id); kills.delete(t.id); void poll(); });
      running.set(t.id, p);
    } finally {
      claiming.delete(t.id);
    }
  }

  /** A task changed (socket frame, or the poll's list). */
  function onTask(t: TeamTask, mine: (agentId: string) => boolean) {
    if (!mine(t.agent_id)) return;
    if (t.state === "queued") void claim(t);
    else if (t.state === "closed" || t.state === "done") kills.get(t.id)?.(); // cancelled while it ran
  }

  /** The tasks waiting for this machine (also the ones it ran before a restart). */
  async function poll() {
    if (stopped) return;
    const r = await o.api("/api/v1/machine/tasks");
    for (const t of (r?.tasks ?? []) as TeamTask[]) {
      if (t.state === "queued" || (t.state === "running" && !running.has(t.id))) void claim(t);
    }
  }

  return {
    onTask, poll,
    running: () => [...running.keys()],
    idle: async () => { while (running.size || claiming.size) await Promise.all([...running.values(), Bun.sleep(10)]); },
    stop: () => { stopped = true; for (const k of kills.values()) k(); },
  };
}
