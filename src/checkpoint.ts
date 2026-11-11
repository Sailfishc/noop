// Checkpoints (design step 5 「检查点」): where a task got to, kept off this machine, so that another computer could go
// on with it if this one goes away. The daemon saves them, not the agent: when a run stops and every 10 minutes while
// it runs, only when something changed.
//
// - A repository task: one commit of the whole worktree (committed and uncommitted work, never ignored files) made
//   with a temporary index, so the agent's own index, branch and files are never touched, pushed to agent/T-xxxx-wip
//   with "[skip ci]". Each checkpoint has the previous one as a second parent, so the push is a fast-forward (no force
//   needed where force pushes are not allowed). The task branch and its PR go on as before; the wip branch is deleted
//   when the task ends.
// - A general task (no repository): its directory, packed (tar.gz) and stored on the server, the latest only, at most
//   100 MB, without in/, dependency folders and files that look like keys; only where the machine allows it.
// Runtime sessions are never saved. Saving never fails the task: what went wrong is recorded instead.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parseRemote } from "./gitflow";
import type { Workdir } from "./teamwork";

/** How often a running task is looked at (ms). */
export const CHECKPOINT_EVERY = 10 * 60_000;
/** The packed directory of a general task, at most (compressed). */
export const MAX_CHECKPOINT_FILES = 100 << 20;
/** What is packed before compressing, at most: beyond it the directory is too big without reading it all. */
const MAX_RAW = 400 << 20;
/** A file in a repository's checkpoint, at most (hosts refuse bigger ones; it is a build output or data, not work). */
const MAX_GIT_FILE = 50 << 20;

/** Never packed: what the server has anyway (in/), dependencies and caches, and files that look like keys. */
const SKIP_DIRS = new Set(["in", "node_modules", ".venv", "venv", "__pycache__", ".git", ".cache", ".pytest_cache", ".mypy_cache", ".next", ".gradle", "target"]);
const SKIP_FILE = /^(\.env.*|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa.*|id_ed25519.*|id_ecdsa.*|\.uploaded\.json|\.netrc|\.npmrc|\.pypirc)$/i;

export type RepoPoint = { repo: string; branch: string; commit?: string; head?: string; error?: string };
export type CheckpointRecord = { repos: RepoPoint[]; files?: { id: string; size: number }; error?: string };

/** What this machine remembers of a task's last checkpoint (and needs to delete its wip branches later). */
type State = {
  repos: Record<string, { repo: string; checkout: string; branch: string; commit?: string; head?: string; tree?: string; error?: string }>;
  files?: { fp: string; id?: string; size?: number; error?: string };
  sent?: string;
};

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<{ ok: boolean; out: string; err: string }> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: env ? { ...process.env, ...env } : undefined });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { ok: (await p.exited) === 0, out: out.trim(), err: err.trim() };
}

const lastLine = (s: string) => s.split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 200) ?? "";

/** The wip branch of a task branch. */
export const wipBranch = (branch: string) => `${branch}-wip`;

/** Who checkpoint commits are by (a machine may have no git identity configured). */
const IDENTITY = { GIT_AUTHOR_NAME: "Remi", GIT_AUTHOR_EMAIL: "remi@localhost", GIT_COMMITTER_NAME: "Remi", GIT_COMMITTER_EMAIL: "remi@localhost" };

/** One commit of the worktree as it is now (its HEAD as first parent, the last checkpoint as second), made with a
 * temporary index; nothing of the agent's changes. Returns the commit, or null when there is nothing to keep (nothing
 * done on the branch yet) or nothing new since `last`. */
export async function snapshotTree(x: Workdir, indexFile: string, taskId: string, last?: { commit?: string; head?: string; tree?: string }):
  Promise<{ commit: string; head: string; tree: string } | { same: true } | { none: true } | { error: string }> {
  const head = await git(x.cwd, ["rev-parse", "HEAD"]);
  if (!head.ok) return { error: `读不到 HEAD：${lastLine(head.err)}` };
  const env = { GIT_INDEX_FILE: indexFile };
  rmSync(indexFile, { force: true });
  try {
    const read = await git(x.cwd, ["read-tree", "HEAD"], env);
    if (!read.ok) return { error: `准备暂存区失败：${lastLine(read.err)}` };
    const add = await git(x.cwd, ["add", "-A", "--", "."], env);
    if (!add.ok) return { error: `读取工作区失败：${lastLine(add.err)}` };
    // new files that look like keys (not ignored, not tracked: .env, *.pem, id_rsa…) never leave the machine, and big
    // ones (a build output, a data dump) stay out too: hosts refuse them, and they are not work. Tracked files stay.
    const added = await git(x.cwd, ["diff", "--cached", "--name-only", "-z", "--diff-filter=A", "HEAD"], env);
    const big = await git(x.cwd, ["diff", "--cached", "--name-only", "-z", "--diff-filter=M", "HEAD"], env);
    const drop: string[] = [];
    for (const name of added.out.split("\0").filter(Boolean)) if (SKIP_FILE.test(basename(name))) drop.push(name);
    for (const name of [...added.out.split("\0"), ...big.out.split("\0")].filter(Boolean)) {
      let size = 0;
      try { size = lstatSync(join(x.cwd, name)).size; } catch {}
      if (size > MAX_GIT_FILE && !drop.includes(name)) drop.push(name);
    }
    for (let i = 0; i < drop.length; i += 100) await git(x.cwd, ["rm", "--cached", "--quiet", "--", ...drop.slice(i, i + 100)], env);
    const tree = await git(x.cwd, ["write-tree"], env);
    if (!tree.ok) return { error: `生成检查点失败：${lastLine(tree.err)}` };
    if (last?.head === head.out && last?.tree === tree.out) return { same: true };
    const headTree = (await git(x.cwd, ["rev-parse", "HEAD^{tree}"])).out;
    const ahead = x.base ? Number((await git(x.cwd, ["rev-list", "--count", `${x.base}..HEAD`])).out) || 0 : 1;
    if (!ahead && tree.out === headTree) return { none: true };
    const parents = ["-p", head.out];
    if (last?.commit && last.commit !== head.out && (await git(x.cwd, ["cat-file", "-e", `${last.commit}^{commit}`])).ok) parents.push("-p", last.commit);
    const commit = await git(x.cwd, ["commit-tree", tree.out, ...parents, "-m", `Remi 检查点 ${taskId} [skip ci]\n\n工作区的快照（含没提交的改动），换电脑继续时用；任务结束后删除。`], IDENTITY);
    if (!commit.ok) return { error: `生成检查点失败：${lastLine(commit.err)}` };
    return { commit: commit.out, head: head.out, tree: tree.out };
  } finally {
    rmSync(indexFile, { force: true });
  }
}

/** Push a checkpoint commit to its wip branch: [skip ci] in the message (GitHub, GitLab), and GitLab's ci.skip push
 * option where the host may be GitLab; no hooks (it is a backup, not a delivery). A wip branch that moved elsewhere
 * (another computer's) is replaced: it is only ever this task's. */
export async function pushWip(cwd: string, commit: string, branch: string): Promise<string | null> {
  if (!branch.startsWith("agent/")) return `拒绝推送 ${branch}：只推 agent/ 开头的分支`;
  const host = parseRemote((await git(cwd, ["remote", "get-url", "origin"])).out)?.host ?? "";
  const ref = `${commit}:refs/heads/${branch}`;
  const opts = host && host !== "github.com" ? ["-o", "ci.skip"] : [];
  let r = await git(cwd, ["push", "--no-verify", "--quiet", ...opts, "origin", ref]);
  if (!r.ok && opts.length && /push.?options?/i.test(r.err)) r = await git(cwd, ["push", "--no-verify", "--quiet", "origin", ref]);
  if (!r.ok && /non-fast-forward|fetch first|rejected/i.test(r.err)) r = await git(cwd, ["push", "--no-verify", "--quiet", "--force", "origin", ref]);
  return r.ok ? null : `推送 ${branch} 失败：${lastLine(r.err)}`;
}

/** The files of a general task's directory to pack (relative paths), and a fingerprint of them (names, sizes, times). */
export function packList(dir: string): { files: string[]; bytes: number; fp: string } {
  const files: string[] = [];
  let bytes = 0;
  const h = new Bun.CryptoHasher("sha256");
  const walk = (d: string) => {
    let names: string[] = [];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      let st; try { st = lstatSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(n) && !(d === dir && n === "in")) walk(p);
      } else if (st.isFile() && !SKIP_FILE.test(n)) {
        const rel = relative(dir, p);
        files.push(rel);
        bytes += st.size;
        h.update(`${rel}\0${st.size}\0${Math.floor(st.mtimeMs)}\n`);
      }
    }
  };
  walk(dir);
  return { files, bytes, fp: h.digest("hex") };
}

/** A plain ustar archive of these files (names up to 255 bytes; longer ones are left out), gzipped. */
export function pack(dir: string, files: string[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  const field = (b: Uint8Array, at: number, len: number, s: string) => b.set(enc.encode(s).subarray(0, len), at);
  const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, "0");
  for (const rel of files) {
    const name = rel.split("\\").join("/");
    let data: Uint8Array;
    try { data = readFileSync(join(dir, rel)); } catch { continue; }
    const nb = enc.encode(name);
    let prefix = "", base = name;
    if (nb.length > 100) {
      const cut = name.lastIndexOf("/", Math.min(name.length - 1, 155));
      if (cut <= 0 || enc.encode(name.slice(cut + 1)).length > 100 || enc.encode(name.slice(0, cut)).length > 155) continue;
      prefix = name.slice(0, cut); base = name.slice(cut + 1);
    }
    const hd = new Uint8Array(512);
    field(hd, 0, 100, base);
    field(hd, 100, 8, "0000644\0");
    field(hd, 108, 8, "0000000\0");
    field(hd, 116, 8, "0000000\0");
    field(hd, 124, 12, octal(data.length, 12) + "\0");
    field(hd, 136, 12, octal(Math.floor(Date.now() / 1000), 12) + "\0");
    field(hd, 148, 8, "        ");
    hd[156] = 0x30; // a regular file
    field(hd, 257, 6, "ustar\0");
    field(hd, 263, 2, "00");
    field(hd, 345, 155, prefix);
    let sum = 0;
    for (const b of hd) sum += b;
    field(hd, 148, 8, octal(sum, 7) + "\0 ");
    parts.push(hd, data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return Bun.gzipSync(out);
}

export type CheckpointDeps = {
  api: (path: string, init?: RequestInit) => Promise<any>;
  /** The packed directory to the server: its id there, or null when it could not go. */
  upload?: (taskId: string, data: Uint8Array) => Promise<{ id: string; size: number } | null>;
  /** Where this machine keeps what it remembers of checkpoints. */
  dir: string;
  log?: (s: string) => void;
};

const stateFile = (dir: string, id: string) => join(dir, `${id}.json`);
function readState(dir: string, id: string): State | null {
  try { return JSON.parse(readFileSync(stateFile(dir, id), "utf8")); } catch { return null; }
}
function writeState(dir: string, id: string, s: State) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile(dir, id), JSON.stringify(s));
}

/** The checkout behind a worktree (where a local ref and the remote branch are dealt with after it is gone). */
async function checkoutOf(x: Workdir): Promise<string> {
  return x.repo ?? (await git(x.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).out;
}

/** Saves a checkpoint of the task's directories now, when something changed. filesAllowed: the machine allows
 * packing a general task's directory. Returns what was sent ("unchanged" when nothing was). */
export async function saveCheckpoint(d: CheckpointDeps, taskId: string, wd: Workdir, filesAllowed: boolean): Promise<CheckpointRecord | "unchanged" | null> {
  const prev = readState(d.dir, taskId) ?? { repos: {} };
  const next: State = { repos: {}, files: prev.files, sent: prev.sent };
  const trees: [string, Workdir][] = [];
  if (wd.repo && wd.branch) trees.push([".", wd]);
  for (const [remote, x] of Object.entries(wd.extra ?? {})) if (x.branch) trees.push([remote, x]);
  for (const [key, x] of trees) {
    const last = prev.repos[key];
    const branch = wipBranch(x.branch!);
    const url = (await git(x.cwd, ["remote", "get-url", "origin"])).out;
    const label = key === "." ? (parseRemote(url)?.path ?? basename(url.replace(/\.git$/, ""))) : key;
    const base = { repo: label, checkout: last?.checkout ?? await checkoutOf(x), branch };
    if (!(await git(x.cwd, ["remote", "get-url", "origin"])).ok) { next.repos[key] = { ...base, error: "仓库没有远端，没有存" }; continue; }
    mkdirSync(d.dir, { recursive: true });
    const snap = await snapshotTree(x, join(d.dir, `${taskId}.${key.replace(/[^\w.-]+/g, "_")}.index`), taskId, last);
    if ("same" in snap) { next.repos[key] = last!; continue; }
    if ("none" in snap) { if (last) next.repos[key] = last; continue; }
    if ("error" in snap) { next.repos[key] = { ...base, commit: last?.commit, head: last?.head, tree: last?.tree, error: snap.error }; continue; }
    const err = await pushWip(x.cwd, snap.commit, branch);
    if (err) { next.repos[key] = { ...base, commit: last?.commit, head: last?.head, tree: last?.tree, error: err }; continue; }
    await git(x.cwd, ["update-ref", `refs/remi/wip/${taskId}`, snap.commit]);
    next.repos[key] = { ...base, commit: snap.commit, head: snap.head, tree: snap.tree };
  }
  if (wd.files && !wd.repo) {
    if (!filesAllowed) next.files = { fp: "off", error: "这台电脑设置为不把工作目录存到服务端" };
    else {
      const list = packList(wd.cwd);
      if (list.fp !== prev.files?.fp || prev.files?.error) {
        if (!list.files.length) next.files = prev.files?.id ? prev.files : undefined;
        else if (list.bytes > MAX_RAW) next.files = { fp: list.fp, error: "工作目录太大（超过 400 MB），没有存" };
        else {
          const data = pack(wd.cwd, list.files);
          if (data.length > MAX_CHECKPOINT_FILES) next.files = { fp: list.fp, error: "工作目录压缩后超过 100 MB，没有存" };
          else {
            const got = d.upload ? await d.upload(taskId, data).catch(() => null) : null;
            next.files = got ? { fp: list.fp, ...got } : { fp: "", error: "上传失败，下次再试" };
          }
        }
      }
    }
  }
  const record: CheckpointRecord = {
    repos: Object.values(next.repos).map((r) => ({ repo: r.repo, branch: r.branch, ...(r.commit ? { commit: r.commit, head: r.head } : {}), ...(r.error ? { error: r.error } : {}) })),
    ...(next.files?.id ? { files: { id: next.files.id, size: next.files.size ?? 0 } } : {}),
    ...(next.files?.error ? { error: next.files.error } : {}),
  };
  if (!record.repos.length && !record.files && !record.error) { if (Object.keys(prev.repos).length || prev.files) writeState(d.dir, taskId, next); return null; }
  const key = JSON.stringify(record);
  const unchanged = key === prev.sent;
  const ok = await d.api(`/api/v1/tasks/${taskId}/checkpoint`, { method: "POST", body: JSON.stringify(unchanged ? { unchanged: true } : record) }).catch(() => null);
  if (ok) next.sent = key;
  writeState(d.dir, taskId, next);
  return unchanged ? "unchanged" : record;
}

/** The task ended: its wip branches go from the remote and the local ref from its checkout; nothing else is kept.
 * Returns whether everything went (else it is tried again later). */
export async function dropCheckpoint(d: CheckpointDeps, taskId: string): Promise<boolean> {
  const s = readState(d.dir, taskId);
  if (!s) return true;
  let all = true;
  for (const r of Object.values(s.repos)) {
    if (!r.checkout || !existsSync(r.checkout)) continue;
    if (r.commit) {
      const del = await git(r.checkout, ["push", "--no-verify", "--quiet", "origin", "--delete", r.branch]);
      if (!del.ok && !/remote ref does not exist|unable to delete .*: remote ref/i.test(del.err)) { all = false; d.log?.(`删除 ${r.branch} 失败：${lastLine(del.err)}`); continue; }
    }
    await git(r.checkout, ["update-ref", "-d", `refs/remi/wip/${taskId}`]);
  }
  if (all) rmSync(stateFile(d.dir, taskId), { force: true });
  return all;
}

/** The tasks this machine still keeps checkpoints of. */
export function keptCheckpoints(dir: string): string[] {
  try { return readdirSync(dir).filter((n) => /^T-\d+\.json$/.test(n)).map((n) => n.slice(0, -5)); } catch { return []; }
}
