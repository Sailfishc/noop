// The team config repository (the collaboration plan, stage 2): one git repository an admin names in the app
// (设置 → 团队配置), which every machine keeps a copy of and gives to its agents:
//
//   AGENTS.md   the team's conventions: every agent reads them at the start of a task
//   skills/     one folder per skill (with its SKILL.md): linked into ~/.claude/skills, ~/.codex/skills and
//               ~/.pi/agent/skills, so every runtime on the machine finds them
//   mcp.json    MCP servers, as Claude Code writes them ({"mcpServers": {...}}); ${VAR} in it is filled from this
//               machine's environment or its [remi.env] settings, so secrets stay on the machine. Claude Code gets
//               them with --mcp-config, Codex with -c mcp_servers.<name>=…; a server whose ${VAR} is not set here is
//               left out (and said in the status).
//
// The machine reports what came of it (commit, when, problems), and the names of the skills and MCP servers its
// agents can use; the app shows that on the machine's card.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type TeamConfigStatus = { repo: string; commit: string; synced: number; error?: string; instructions: boolean };
/** What the runs get from it. */
export type TeamContext = { instructions: string; mcp: Record<string, McpServer>; mcpFile?: string };
export type McpServer = { type?: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };

const MAX_INSTRUCTIONS = 12_000;
/** Where the runtimes look for skills, under the user's home. */
export const SKILL_DIRS = [".claude/skills", ".codex/skills", ".pi/agent/skills"];

async function git(cwd: string, ...args: string[]): Promise<{ ok: boolean; out: string }> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { ok: code === 0, out: (code === 0 ? out : err).trim() };
}

/** Fills ${VAR} (and $VAR is left alone) from `env`; returns the names that were missing. */
export function fillVars(v: unknown, env: Record<string, string | undefined>, missing: Set<string>): any {
  if (typeof v === "string") return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k) => { const x = env[k]; if (x === undefined || x === "") missing.add(k); return x ?? ""; });
  if (Array.isArray(v)) return v.map((x) => fillVars(x, env, missing));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillVars(x, env, missing)]));
  return v;
}

/** The MCP servers of mcp.json with this machine's values filled in; the ones missing a value are left out. */
export function resolveMcp(json: unknown, env: Record<string, string | undefined>): { servers: Record<string, McpServer>; problems: string[] } {
  const servers: Record<string, McpServer> = {}, problems: string[] = [];
  const all = (json as any)?.mcpServers ?? {};
  for (const [name, def] of Object.entries(all)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || !def || typeof def !== "object") { problems.push(`MCP ${name}：名字或配置不对`); continue; }
    const missing = new Set<string>();
    const filled = fillVars(def, env, missing) as McpServer;
    if (missing.size) { problems.push(`MCP ${name}：这台机器没有 ${[...missing].join("、")}`); continue; }
    if (!filled.command && !filled.url) { problems.push(`MCP ${name}：没有 command 或 url`); continue; }
    servers[name] = filled;
  }
  return { servers, problems };
}

/** A TOML value (for codex -c key=value): strings as JSON strings (TOML takes the same escapes), inline tables. */
export function toml(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(toml).join(", ")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${JSON.stringify(k)} = ${toml(x)}`).join(", ")}}`;
  return '""';
}

/** Codex's flags for these MCP servers. */
export function codexMcpArgs(servers: Record<string, McpServer>): string[] {
  const out: string[] = [];
  for (const [name, s] of Object.entries(servers)) {
    const c: Record<string, unknown> = s.url ? { url: s.url, http_headers: s.headers } : { command: s.command, args: s.args, env: s.env };
    out.push("-c", `mcp_servers.${name}=${toml(c)}`);
  }
  return out;
}

/** Links each skills/<name>/ (with a SKILL.md) into the runtimes' skill folders under `home`. A folder or a link of
 * someone else's with the same name is left alone; links made before for skills that are gone are removed. Returns
 * the linked skill names. `manifest` remembers which links are ours. */
export function linkSkills(configDir: string, home: string, manifest: string): string[] {
  const src = join(configDir, "skills");
  const names = existsSync(src) ? readdirSync(src).filter((n) => /^[\w.-]+$/.test(n) && existsSync(join(src, n, "SKILL.md"))).sort() : [];
  let before: string[] = [];
  try { before = JSON.parse(readFileSync(manifest, "utf8")).links ?? []; } catch {}
  const links: string[] = [];
  for (const d of SKILL_DIRS) {
    const dir = join(home, d);
    for (const n of names) {
      const at = join(dir, n), to = join(src, n);
      let ours = false;
      try { ours = lstatSync(at).isSymbolicLink() && readlinkSync(at) === to; } catch {
        try { mkdirSync(dir, { recursive: true }); symlinkSync(to, at); ours = true; } catch {}
      }
      if (ours) links.push(at);
    }
  }
  for (const at of before) {
    if (links.includes(at)) continue;
    try { if (lstatSync(at).isSymbolicLink() && readlinkSync(at).startsWith(src)) rmSync(at); } catch {}
  }
  try { writeFileSync(manifest, JSON.stringify({ links })); } catch {}
  return names;
}

/** Removes the links linkSkills made to the skills of `configDir`. */
function unlinkSkills(configDir: string, manifest: string) {
  let before: string[] = [];
  try { before = JSON.parse(readFileSync(manifest, "utf8")).links ?? []; } catch {}
  for (const at of before) try { if (lstatSync(at).isSymbolicLink() && readlinkSync(at).startsWith(join(configDir, "skills"))) rmSync(at); } catch {}
  rmSync(manifest, { force: true });
}

/** Keeps the team config repository `repo` in `<root>/team-config` (clone, then fetch and reset to the remote's
 * default branch: nobody edits this copy), links its skills, fills its MCP servers. `repo` "" clears it all. */
export async function syncTeamConfig(repo: string, root: string, o: { home?: string; env?: Record<string, string | undefined>; now?: () => number } = {}):
  Promise<{ status: TeamConfigStatus | null; context: TeamContext | null; skills: string[] }> {
  const home = o.home ?? homedir(), dir = join(root, "team-config"), manifest = join(root, "team-config.links.json");
  const mcpFile = join(root, "team-config.mcp.json");
  if (!repo) {
    if (existsSync(dir)) { unlinkSkills(dir, manifest); rmSync(dir, { recursive: true, force: true }); }
    rmSync(mcpFile, { force: true });
    return { status: null, context: null, skills: [] };
  }
  const status: TeamConfigStatus = { repo, commit: "", synced: (o.now ?? Date.now)(), instructions: false };
  const problems: string[] = [];
  mkdirSync(root, { recursive: true });
  const origin = existsSync(join(dir, ".git")) ? (await git(dir, "remote", "get-url", "origin")).out : "";
  if (origin !== repo) {
    rmSync(dir, { recursive: true, force: true });
    const r = await git(root, "clone", "--quiet", "--depth", "1", repo, dir);
    if (!r.ok) return { status: { ...status, error: `拉取失败：${r.out.slice(0, 300)}` }, context: null, skills: [] };
  } else {
    const f = await git(dir, "fetch", "--quiet", "--depth", "1", "origin");
    if (f.ok) await git(dir, "reset", "--quiet", "--hard", "FETCH_HEAD");
    else problems.push(`更新失败（用的是上次的版本）：${f.out.slice(0, 200)}`);
  }
  status.commit = (await git(dir, "rev-parse", "--short", "HEAD")).out;
  let instructions = "";
  try { instructions = readFileSync(join(dir, "AGENTS.md"), "utf8").trim().slice(0, MAX_INSTRUCTIONS); } catch {}
  status.instructions = !!instructions;
  const skills = linkSkills(dir, home, manifest);
  let mcp: Record<string, McpServer> = {};
  if (existsSync(join(dir, "mcp.json"))) {
    try {
      const r = resolveMcp(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")), o.env ?? process.env);
      mcp = r.servers;
      problems.push(...r.problems);
    } catch (e) { problems.push(`mcp.json 读不了：${e instanceof Error ? e.message : e}`); }
  }
  if (Object.keys(mcp).length) writeFileSync(mcpFile, JSON.stringify({ mcpServers: mcp }), { mode: 0o600 });
  else rmSync(mcpFile, { force: true });
  if (problems.length) status.error = problems.join("；").slice(0, 500);
  return { status, context: { instructions, mcp, ...(Object.keys(mcp).length ? { mcpFile } : {}) }, skills };
}

/** The skills the runtimes on this machine can use (the team's and the machine's own), by name. */
export function localSkills(home = homedir()): string[] {
  const out = new Set<string>();
  for (const d of SKILL_DIRS) {
    try { for (const n of readdirSync(join(home, d))) if (existsSync(join(home, d, n, "SKILL.md"))) out.add(n); } catch {}
  }
  return [...out].sort();
}
