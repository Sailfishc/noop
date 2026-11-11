import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropCheckpoint, keptCheckpoints, pack, packList, saveCheckpoint } from "../src/checkpoint";
import { createWorker, movedPrompt, prepareWorkdir, type Claim, type TeamTask } from "../src/teamwork";
import type { Runtime } from "../src/runtimes";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, ...cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { cwd, env: ENV });
  return (p.stdout.toString() + p.stderr.toString()).trim();
};

/** A checkout with an origin (a bare repository) and one commit on main. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), "ckpt-"));
  const origin = join(root, "origin.git"), work = join(root, "work");
  sh(root, "git", "init", "-q", "--bare", "-b", "main", origin);
  sh(root, "git", "clone", "-q", origin, work);
  writeFileSync(join(work, "a.txt"), "a\n");
  writeFileSync(join(work, ".gitignore"), "secret.env\n");
  sh(work, "git", "add", ".");
  sh(work, "git", "commit", "-qm", "init");
  sh(work, "git", "push", "-q", "origin", "HEAD:main");
  return { root, origin, work };
}

const claimFor = (repoPath: string, id = "T-0007"): Claim => ({
  task: { id, branch: "", repo: "" } as unknown as TeamTask,
  agent: { handle: "acha", repo: repoPath } as any,
  channel: { id: "c", name: "c", topic: "" }, recent: [], thread: [], new: [], names: {}, creator: { name: "x", handle: "x" }, resumed: false,
});

test("a repository task: committed and uncommitted work on agent/T-xxxx-wip, ignored files left out, the agent's index untouched", async () => {
  const r = repo();
  const wd = await prepareWorkdir(claimFor(r.work), join(r.root, "tasks"));
  writeFileSync(join(wd.cwd, "b.txt"), "committed\n");
  sh(wd.cwd, "git", "add", "b.txt");
  sh(wd.cwd, "git", "commit", "-qm", "b");
  writeFileSync(join(wd.cwd, "c.txt"), "staged\n");
  sh(wd.cwd, "git", "add", "c.txt");
  writeFileSync(join(wd.cwd, "d.txt"), "untracked\n");
  writeFileSync(join(wd.cwd, "a.txt"), "changed, not staged\n");
  writeFileSync(join(wd.cwd, "secret.env"), "KEY=1\n");
  writeFileSync(join(wd.cwd, ".env"), "TOKEN=2\n"); // not ignored, not tracked, looks like a key
  mkdirSync(join(wd.cwd, "certs"));
  writeFileSync(join(wd.cwd, "certs", "server.pem"), "-----\n");
  const before = { status: sh(wd.cwd, "git", "status", "--porcelain"), head: sh(wd.cwd, "git", "rev-parse", "HEAD"), branch: sh(wd.cwd, "git", "branch", "--show-current"), staged: sh(wd.cwd, "git", "diff", "--cached", "--name-only") };

  const sent: any[] = [];
  const d = { api: async (path: string, init?: RequestInit) => { sent.push({ path, body: JSON.parse(String(init?.body)) }); return {}; }, dir: join(r.root, "ck") };
  const rec = await saveCheckpoint(d, "T-0007", wd, true);
  expect(rec).not.toBe("unchanged");
  expect(sent[0].path).toBe("/api/v1/tasks/T-0007/checkpoint");
  const point = sent[0].body.repos[0];
  expect(point).toMatchObject({ branch: "agent/T-0007-wip", head: before.head });

  // the agent's side: exactly as it was
  expect(sh(wd.cwd, "git", "status", "--porcelain")).toBe(before.status);
  expect(sh(wd.cwd, "git", "diff", "--cached", "--name-only")).toBe(before.staged);
  expect(sh(wd.cwd, "git", "branch", "--show-current")).toBe(before.branch);
  expect(sh(wd.cwd, "git", "rev-parse", "HEAD")).toBe(before.head);

  // the remote: everything but the ignored file and the new key-looking ones, the task branch's HEAD as first parent, [skip ci]
  expect(sh(r.origin, "git", "rev-parse", "refs/heads/agent/T-0007-wip")).toBe(point.commit);
  const files = sh(r.origin, "git", "ls-tree", "-r", "--name-only", point.commit).split("\n");
  expect(files.sort()).toEqual([".gitignore", "a.txt", "b.txt", "c.txt", "d.txt"]);
  expect(sh(r.origin, "git", "show", `${point.commit}:a.txt`)).toBe("changed, not staged");
  expect(sh(r.origin, "git", "rev-parse", `${point.commit}^1`)).toBe(before.head);
  expect(sh(r.origin, "git", "log", "-1", "--format=%s", point.commit)).toContain("[skip ci]");
  expect(sh(r.origin, "git", "branch", "--list", "agent/T-0007")).toBe(""); // the task branch is not pushed by it

  // nothing changed: nothing pushed, only "still current"
  expect(await saveCheckpoint(d, "T-0007", wd, true)).toBe("unchanged");
  expect(sent[1].body).toEqual({ unchanged: true });

  // a change: the next checkpoint follows the last one (a fast-forward, no force)
  writeFileSync(join(wd.cwd, "d.txt"), "more\n");
  await saveCheckpoint(d, "T-0007", wd, true);
  const next = sent[2].body.repos[0].commit;
  expect(next).not.toBe(point.commit);
  expect(sh(r.origin, "git", "rev-parse", `${next}^2`)).toBe(point.commit);
  expect(sh(r.origin, "git", "rev-parse", "refs/heads/agent/T-0007-wip")).toBe(next);

  // the task ended: the wip branch goes, the local ref too, nothing kept
  expect(keptCheckpoints(d.dir)).toEqual(["T-0007"]);
  expect(await dropCheckpoint(d, "T-0007")).toBe(true);
  expect(sh(r.origin, "git", "branch", "--list", "agent/T-0007-wip")).toBe("");
  expect(sh(r.work, "git", "for-each-ref", "refs/remi/")).toBe("");
  expect(keptCheckpoints(d.dir)).toEqual([]);
});

test("a repository task with nothing done yet: no checkpoint", async () => {
  const r = repo();
  const wd = await prepareWorkdir(claimFor(r.work, "T-0008"), join(r.root, "tasks"));
  const sent: any[] = [];
  expect(await saveCheckpoint({ api: async (p, i) => sent.push(p), dir: join(r.root, "ck") }, "T-0008", wd, true)).toBe(null);
  expect(sent).toEqual([]);
});

test("a general task: its directory packed without in/, dependencies and keys; the machine's switch; too big", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ckg-"));
  const cwd = join(dir, "T-0009");
  for (const p of ["in", "out", "node_modules/x", "notes"]) mkdirSync(join(cwd, p), { recursive: true });
  writeFileSync(join(cwd, "in", "brief.pdf"), "people's attachment");
  writeFileSync(join(cwd, "out", "report.md"), "# report");
  writeFileSync(join(cwd, "node_modules", "x", "i.js"), "dep");
  writeFileSync(join(cwd, "notes", "draft.md"), "draft");
  writeFileSync(join(cwd, ".env"), "KEY=1");
  writeFileSync(join(cwd, "server.pem"), "-----");
  const list = packList(cwd);
  expect(list.files.sort()).toEqual(["notes/draft.md", "out/report.md"]);

  // what pack makes, system tar reads
  const tgz = pack(cwd, list.files);
  const x = join(dir, "x");
  mkdirSync(x);
  writeFileSync(join(dir, "c.tgz"), tgz);
  sh(x, "tar", "-xzf", join(dir, "c.tgz"));
  expect(readFileSync(join(x, "notes", "draft.md"), "utf8")).toBe("draft");
  expect(existsSync(join(x, "in"))).toBe(false);

  const wd = { cwd, writable: [], files: cwd };
  const sent: any[] = [], uploads: number[] = [];
  const d = { api: async (_p: string, i?: RequestInit) => { sent.push(JSON.parse(String(i?.body))); return {}; }, dir: join(dir, "ck"),
    upload: async (_id: string, data: Uint8Array) => { uploads.push(data.length); return { id: `ckpt-T-0009-${uploads.length}`, size: data.length }; } };
  await saveCheckpoint(d, "T-0009", wd, false);
  expect(uploads).toEqual([]);
  expect(sent[0]).toMatchObject({ error: "这台电脑设置为不把工作目录存到服务端" });
  await saveCheckpoint(d, "T-0009", wd, true);
  expect(uploads.length).toBe(1);
  expect(sent[1]).toMatchObject({ files: { id: "ckpt-T-0009-1" } });
  expect(await saveCheckpoint(d, "T-0009", wd, true)).toBe("unchanged");
  expect(uploads.length).toBe(1);
  writeFileSync(join(cwd, "notes", "draft.md"), "draft 2, longer");
  await saveCheckpoint(d, "T-0009", wd, true);
  expect(uploads.length).toBe(2);
});

/** A runtime that writes a file and ends with a result. */
const fakeRuntime = (onStart?: () => void): Runtime => ({
  name: "codex", available: () => true,
  start: (o: any) => {
    onStart?.();
    writeFileSync(join(o.cwd, "work.txt"), "done\n");
    return { kill() {}, done: Promise.resolve({ text: "```json\n{\"status\": \"review\", \"summary\": \"ok\"}\n```", exitCode: 0, steps: 1 } as any) };
  },
} as any);

test("the worker checkpoints when a run stops (after its report), and not when checkpoints are off", async () => {
  for (const on of [true, false]) {
    const r = repo();
    const calls: string[] = [];
    const api = async (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/claim")) return { ...claimFor(r.work, "T-0010"), task: { id: "T-0010", state: "running", branch: "", repo: "", runs: 1 } };
      return { tasks: [] };
    };
    const w = createWorker({ api, maxParallel: 1, workRoot: join(r.root, "tasks"), runtimes: { codex: fakeRuntime() }, checkpoints: on, send: async (p) => { calls.push(`SEND ${p}`); return "ok"; } });
    w.onTask({ id: "T-0010", state: "queued", agent_id: "a" } as TeamTask, () => true);
    await Bun.sleep(50);
    await w.idle();
    const report = calls.findIndex((c) => c.startsWith("SEND /api/v1/tasks/T-0010/report"));
    const ck = calls.findIndex((c) => c.startsWith("POST /api/v1/tasks/T-0010/checkpoint"));
    expect(report).toBeGreaterThanOrEqual(0);
    if (on) {
      expect(ck).toBeGreaterThan(report);
      expect(sh(r.origin, "git", "ls-tree", "-r", "--name-only", "refs/heads/agent/T-0010-wip")).toContain("work.txt");
    } else {
      expect(ck).toBe(-1);
      expect(sh(r.origin, "git", "branch", "--list", "agent/T-0010-wip")).toBe("");
    }
    w.stop();
  }
});

test("moved to another computer: a fresh worktree comes back from the checkpoint (commits, and changes not committed)", async () => {
  const r = repo();
  // computer A: commits one file, leaves two more uncommitted, a checkpoint goes to the remote
  const wd = await prepareWorkdir(claimFor(r.work, "T-0011"), join(r.root, "a"));
  writeFileSync(join(wd.cwd, "b.txt"), "committed\n");
  sh(wd.cwd, "git", "add", "b.txt");
  sh(wd.cwd, "git", "commit", "-qm", "b on A");
  writeFileSync(join(wd.cwd, "c.txt"), "new, not committed\n");
  writeFileSync(join(wd.cwd, "a.txt"), "changed, not committed\n");
  sh(wd.cwd, "rm", "-f", ".gitignore");
  const sent: any[] = [];
  await saveCheckpoint({ api: async (_p, i) => sent.push(JSON.parse(String(i?.body))), dir: join(r.root, "cka") }, "T-0011", wd, true);
  const point = sent[0].repos[0];

  // computer B: its own clone, no local branch of the task
  const b = join(r.root, "b-clone");
  sh(r.root, "git", "clone", "-q", r.origin, b);
  const moved = claimFor(b, "T-0011");
  moved.task.moves = 1;
  moved.task.checkpoint = { at: Date.now(), repos: [point] };
  const wb = await prepareWorkdir(moved, join(r.root, "b"));
  expect(wb.restored).toBe("checkpoint");
  expect(sh(wb.cwd, "git", "log", "-1", "--format=%s")).toBe("b on A");
  expect(sh(wb.cwd, "git", "rev-parse", "HEAD")).toBe(point.head);
  expect(readFileSync(join(wb.cwd, "c.txt"), "utf8")).toBe("new, not committed\n");
  expect(readFileSync(join(wb.cwd, "a.txt"), "utf8")).toBe("changed, not committed\n");
  expect(existsSync(join(wb.cwd, ".gitignore"))).toBe(false);
  const st = sh(wb.cwd, "git", "status", "--porcelain");
  expect(st).toContain(" M a.txt");
  expect(st).toContain("?? c.txt");
  expect(sh(wb.cwd, "git", "diff", "--cached", "--name-only")).toBe(""); // not staged: as the agent left them
  expect(sh(b, "git", "for-each-ref", "refs/remi/")).toBe(""); // nothing of the fetch left behind
  expect(await movedPrompt(moved, wb)).toContain("restored from the checkpoint");

  // no checkpoint, but the task branch was pushed: it starts from that
  sh(r.work, "git", "push", "-q", "origin", `${point.head}:refs/heads/agent/T-0012`);
  const c2 = claimFor(join(r.root, "b-clone"), "T-0012");
  c2.task.moves = 1;
  const w2 = await prepareWorkdir(c2, join(r.root, "b"));
  expect(w2.restored).toBe("branch");
  expect(sh(w2.cwd, "git", "rev-parse", "HEAD")).toBe(point.head);
});

test("a general task moved: its directory comes back from the server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ckm-"));
  mkdirSync(join(dir, "src", "notes"), { recursive: true });
  writeFileSync(join(dir, "src", "notes", "draft.md"), "draft");
  const tgz = pack(join(dir, "src"), packList(join(dir, "src")).files);
  const c = claimFor("", "T-0013");
  c.agent.repo = "";
  c.task.moves = 1;
  c.task.checkpoint = { at: Date.now(), repos: [], files: { id: "ckpt-T-0013-1", size: tgz.length } };
  const wd = await prepareWorkdir(c, join(dir, "work"), undefined, async (id) => (id === "T-0013" ? tgz : null));
  expect(wd.restored).toBe("checkpoint");
  expect(readFileSync(join(wd.cwd, "notes", "draft.md"), "utf8")).toBe("draft");
  expect(existsSync(join(wd.cwd, "in"))).toBe(true);
});

test("a run whose task moved away stops: nothing pushed, no report, no checkpoint", async () => {
  const r = repo();
  const calls: string[] = [];
  let moves = 0, release = () => {};
  const api = async (path: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.endsWith("/claim")) return { ...claimFor(r.work, "T-0014"), task: { id: "T-0014", state: "running", branch: "", repo: "", runs: 1, moves: 0 } };
    if (path === "/api/v1/tasks/T-0014") return { id: "T-0014", moves };
    return { tasks: [] };
  };
  const slow: Runtime = { name: "codex", available: () => true, start: (o: any) => {
    writeFileSync(join(o.cwd, "work.txt"), "done\n");
    let kill = () => {};
    const done = new Promise<any>((res) => { release = () => res({ text: "```json\n{\"status\": \"review\", \"summary\": \"ok\"}\n```", exitCode: 0, steps: 1 }); kill = () => res({ killed: true, text: "", exitCode: 1 }); });
    return { kill: () => kill(), done };
  } } as any;
  const pushed: string[] = [];
  const w = createWorker({ api, maxParallel: 1, workRoot: join(r.root, "tasks"), runtimes: { codex: slow }, checkpoints: true,
    afterRun: async () => { pushed.push("pr"); return null; }, send: async (p) => { calls.push(`SEND ${p}`); return "ok"; } });
  const mine = () => true;
  w.onTask({ id: "T-0014", state: "queued", agent_id: "a" } as TeamTask, mine);
  await Bun.sleep(1); // the move can come before the run starts (a slow worktree) as well as during it // the move may come before the run starts (slow worktree), or during it
  // the owner moved it while it ran (the socket says so): the run here stops
  moves = 1;
  w.onTask({ id: "T-0014", state: "queued", agent_id: "a", moves: 1 } as TeamTask, mine);
  await w.idle();
  expect(pushed).toEqual([]);
  expect(calls.some((c) => c.startsWith("SEND"))).toBe(false);
  expect(calls.some((c) => c.includes("/checkpoint"))).toBe(false);

  // a frame missed: the run ends, but the machine asks before pushing
  const r2 = repo();
  moves = 0;
  const api2 = async (path: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.endsWith("/claim")) return { ...claimFor(r2.work, "T-0015"), task: { id: "T-0015", state: "running", branch: "", repo: "", runs: 1, moves: 0 } };
    if (path === "/api/v1/tasks/T-0015") return { id: "T-0015", moves: 1 };
    return { tasks: [] };
  };
  const w2 = createWorker({ api: api2, maxParallel: 1, workRoot: join(r2.root, "tasks"), runtimes: { codex: fakeRuntime() }, checkpoints: true,
    afterRun: async () => { pushed.push("pr"); return null; }, send: async (p) => { calls.push(`SEND ${p}`); return "ok"; } });
  calls.length = 0;
  w2.onTask({ id: "T-0015", state: "queued", agent_id: "a" } as TeamTask, mine);
  await Bun.sleep(50);
  await w2.idle();
  expect(pushed).toEqual([]);
  expect(calls.some((c) => c.startsWith("SEND"))).toBe(false);
  release();
  w.stop(); w2.stop();
});

test("a run's reports name the move count it was claimed with", async () => {
  const r = repo();
  const sends: string[] = [];
  const api = async (path: string) => {
    if (path.endsWith("/claim")) return { ...claimFor(r.work, "T-0016"), task: { id: "T-0016", state: "running", branch: "", repo: "", runs: 1, moves: 2 } };
    if (path === "/api/v1/tasks/T-0016") return { id: "T-0016", moves: 2 };
    return { tasks: [] };
  };
  const w = createWorker({ api, maxParallel: 1, workRoot: join(r.root, "tasks"), runtimes: { codex: fakeRuntime() }, send: async (p) => { sends.push(p); return "ok"; } });
  w.onTask({ id: "T-0016", state: "queued", agent_id: "a" } as TeamTask, () => true);
  await Bun.sleep(50);
  await w.idle();
  expect(sends).toEqual(["/api/v1/tasks/T-0016/report?moves=2"]);
  w.stop();
});
