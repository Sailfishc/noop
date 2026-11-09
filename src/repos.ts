// The repositories this machine has. A task names its repository by remote ("github.com/acme/pay", the same on every
// machine); the machine finds its own checkout of it, or clones one. Only the remotes go to the server, never paths.
//
//   [remi]                         # or [teamagent], as it was first called
//   roots = ["~/code", "~/work"]   # where to look for checkouts (default: the usual places, up to three levels deep)
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseRemote } from "./gitflow";

export const DEFAULT_ROOTS = ["~/code", "~/src", "~/projects", "~/work", "~/workspace", "~/dev", "~/github", "~/Developer", "~/repos", "~/git"];

const expand = (p: string, home = homedir()) => (p.startsWith("~") ? join(home, p.slice(1)) : resolve(p));

/** A clone or web address → "host/owner/name" (what the server calls a repository), or "" for anything else. */
export function remoteKey(url: string): string {
  const r = parseRemote(url);
  if (!r || !r.host.includes(".")) return "";
  let path = r.path.replace(/\/-\/.*$/, "");
  if (r.host === "github.com") path = path.split("/").slice(0, 2).join("/");
  return /^[\w.-]+(\/[\w.-]+)+$/.test(path) ? `${r.host}/${path}` : "";
}

type Git = (cwd: string, ...args: string[]) => { ok: boolean; out: string };
const gitSync: Git = (cwd, ...args) => {
  try {
    const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    return { ok: p.exitCode === 0, out: (p.exitCode === 0 ? p.stdout : p.stderr).toString().trim() };
  } catch { return { ok: false, out: "" }; }
};

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isCheckout = (p: string) => existsSync(join(p, ".git"));

/** The git checkouts under roots (up to three levels down: ~/code/github.com/acme/pay) and the given paths, by remote. */
export function scanRepos(roots: string[], extra: string[] = [], git: Git = gitSync, home = homedir()): Map<string, string> {
  const dirs: string[] = [];
  const visit = (d: string, depth: number) => {
    if (!isDir(d)) return;
    if (isCheckout(d)) { dirs.push(d); return; }
    if (depth === 0) return;
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names.slice(0, 400)) if (!n.startsWith(".") && n !== "node_modules") visit(join(d, n), depth - 1);
  };
  for (const r of roots) visit(expand(r, home), 3);
  for (const p of extra) if (p && isDir(expand(p, home))) dirs.push(expand(p, home));
  const out = new Map<string, string>();
  for (const d of dirs) {
    const url = git(d, "remote", "get-url", "origin");
    const key = url.ok ? remoteKey(url.out) : "";
    if (key && !out.has(key)) out.set(key, d);
  }
  return out;
}

export type RepoBook = {
  /** What the server may know: the remotes. */
  list(): { remote: string; name: string }[];
  /** This machine's checkout of a remote: found, found after a fresh look, or cloned. */
  resolve(remote: string): Promise<string>;
  rescan(): void;
};

type Run = (cmd: string[], cwd: string) => Promise<{ ok: boolean; out: string }>;
const runAsync: Run = async (cmd, cwd) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { ok: code === 0, out: (code === 0 ? out : err).trim() };
};

/** roots: where checkouts are; extra: more checkouts (the agents' own repo paths); clones: where new clones go. */
export function repoBook(o: { roots?: string[]; extra?: () => string[]; clones: string; git?: Git; run?: Run; home?: string }): RepoBook {
  const roots = o.roots?.length ? o.roots : DEFAULT_ROOTS;
  let map = new Map<string, string>(), at = 0;
  const rescan = () => { map = scanRepos([...roots, o.clones], o.extra?.() ?? [], o.git, o.home); at = Date.now(); };
  const fresh = () => { if (!at || Date.now() - at > 10 * 60_000) rescan(); };
  const cloning = new Map<string, Promise<string>>(); // two tasks of one repo at once: one clone
  return {
    rescan,
    list: () => { fresh(); return [...map.keys()].sort().map((remote) => ({ remote, name: remote.slice(remote.lastIndexOf("/") + 1) })); },
    async resolve(remote) {
      fresh();
      if (!map.has(remote)) rescan();
      const have = map.get(remote);
      if (have && isCheckout(have)) return have;
      const dir = join(o.clones, ...remote.split("/"));
      if (isCheckout(dir)) { map.set(remote, dir); return dir; }
      if (cloning.has(remote)) return cloning.get(remote)!;
      const p = clone(remote, dir).finally(() => cloning.delete(remote));
      cloning.set(remote, p);
      return p;
    },
  };

  async function clone(remote: string, dir: string): Promise<string> {
    mkdirSync(dirname(dir), { recursive: true });
    const host = remote.slice(0, remote.indexOf("/")), path = remote.slice(remote.indexOf("/") + 1);
    const tries = [`https://${host}/${path}.git`, `git@${host}:${path}.git`];
    const errors: string[] = [];
    for (const url of tries) {
      const r = await (o.run ?? runAsync)(["git", "clone", "--quiet", url, dir], dirname(dir));
      if (r.ok) { map.set(remote, dir); return dir; }
      errors.push(r.out.split("\n").filter(Boolean).at(-1) ?? "");
    }
    throw new Error(`这台机器上没有 ${remote}，克隆也失败了（${errors.filter(Boolean).join("；") || "没有权限或地址不对"}）。在这台机器上 clone 好它，或配置 git 凭证后在线程里回复一句即可重试`);
  }
}
