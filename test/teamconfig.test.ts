import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCommand, codexCommand } from "../src/runtimes";
import { codexMcpArgs, linkSkills, localSkills, resolveMcp, syncTeamConfig } from "../src/teamconfig";
import { prepareWorkdir, taskPrompt, type Claim } from "../src/teamwork";

const sh = (cwd: string, ...cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim() };
};

test("MCP servers: ${VAR} is filled from this machine; one missing a value is left out and said", () => {
  const r = resolveMcp({ mcpServers: {
    jira: { command: "npx", args: ["-y", "jira-mcp"], env: { JIRA_TOKEN: "${JIRA_TOKEN}", JIRA_URL: "https://jira.corp" } },
    wiki: { url: "https://wiki.corp/mcp", headers: { Authorization: "Bearer ${WIKI_TOKEN}" } },
    "bad name": { command: "x" },
  } }, { JIRA_TOKEN: "s3cret" });
  expect(r.servers.jira!.env!.JIRA_TOKEN).toBe("s3cret");
  expect(r.servers.wiki).toBeUndefined();
  expect(r.problems.join(" ")).toContain("wiki：这台机器没有 WIKI_TOKEN");
  expect(r.problems.join(" ")).toContain("bad name");
});

test("the runtimes get the team's MCP servers: Claude Code by file (allowed by name), Codex by -c", () => {
  const servers = { jira: { command: "npx", args: ["-y", "jira-mcp"], env: { T: 'a"b' } }, wiki: { url: "https://wiki/mcp", headers: { A: "b" } } };
  const c = claudeCommand({ mcpConfig: { servers, file: "/h/team-config.mcp.json" } });
  expect(c.join(" ")).toContain("--mcp-config /h/team-config.mcp.json");
  expect(c[c.indexOf("--allowedTools") + 1]!.split(",")).toEqual(expect.arrayContaining(["mcp__jira", "mcp__wiki", "Skill"]));
  expect(codexMcpArgs(servers)).toEqual([
    "-c", 'mcp_servers.jira={"command" = "npx", "args" = ["-y", "jira-mcp"], "env" = {"T" = "a\\"b"}}',
    "-c", 'mcp_servers.wiki={"url" = "https://wiki/mcp", "http_headers" = {"A" = "b"}}',
  ]);
  const x = codexCommand({ cwd: "/w", mcp: { servers } });
  expect(x.indexOf("--cd")).toBeGreaterThan(x.indexOf('mcp_servers.jira={"command" = "npx", "args" = ["-y", "jira-mcp"], "env" = {"T" = "a\\"b"}}'));
});

test("skills are linked for every runtime; someone's own folder stays; gone skills are unlinked", () => {
  const W = mkdtempSync(join(tmpdir(), "teamconfig-"));
  try {
    const cfg = join(W, "cfg"), home = join(W, "home"), manifest = join(W, "links.json");
    for (const n of ["release-notes", "sql-review"]) { mkdirSync(join(cfg, "skills", n), { recursive: true }); writeFileSync(join(cfg, "skills", n, "SKILL.md"), `# ${n}`); }
    mkdirSync(join(cfg, "skills", "no-skill-md"), { recursive: true });
    mkdirSync(join(home, ".claude/skills/sql-review"), { recursive: true }); // the person's own
    writeFileSync(join(home, ".claude/skills/sql-review/SKILL.md"), "mine");
    expect(linkSkills(cfg, home, manifest)).toEqual(["release-notes", "sql-review"]);
    expect(lstatSync(join(home, ".claude/skills/release-notes")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(home, ".codex/skills/sql-review")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(home, ".pi/agent/skills/release-notes")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(home, ".claude/skills/sql-review/SKILL.md"), "utf8")).toBe("mine");
    expect(localSkills(home)).toEqual(["release-notes", "sql-review"]);
    rmSync(join(cfg, "skills", "release-notes"), { recursive: true });
    linkSkills(cfg, home, manifest);
    expect(existsSync(join(home, ".codex/skills/release-notes"))).toBe(false);
    expect(existsSync(join(home, ".claude/skills/sql-review"))).toBe(true);
  } finally { rmSync(W, { recursive: true, force: true }); }
});

test("the team config repository: cloned, kept up to date, its AGENTS.md and MCP servers for the runs; cleared when unset", async () => {
  const W = realpathSync(mkdtempSync(join(tmpdir(), "teamconfig-")));
  try {
    const origin = join(W, "origin.git"), edit = join(W, "edit"), root = join(W, "root"), home = join(W, "home");
    sh(W, "git", "init", "-q", "--bare", "-b", "main", origin);
    sh(W, "git", "clone", "-q", origin, edit);
    writeFileSync(join(edit, "AGENTS.md"), "PR 标题用中文。\n");
    mkdirSync(join(edit, "skills", "release-notes"), { recursive: true });
    writeFileSync(join(edit, "skills", "release-notes", "SKILL.md"), "# release notes");
    writeFileSync(join(edit, "mcp.json"), JSON.stringify({ mcpServers: { jira: { command: "jira-mcp", env: { T: "${JIRA_TOKEN}" } } } }));
    sh(edit, "git", "add", ".");
    sh(edit, "git", "commit", "-qm", "init");
    sh(edit, "git", "push", "-q", "origin", "HEAD:main");

    let r = await syncTeamConfig(origin, root, { home, env: { JIRA_TOKEN: "tok" }, now: () => 7 });
    expect(r.status).toMatchObject({ repo: origin, synced: 7, instructions: true });
    expect(r.status!.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(r.status!.error).toBeUndefined();
    expect(r.context!.instructions).toBe("PR 标题用中文。");
    expect(r.skills).toEqual(["release-notes"]);
    expect(JSON.parse(readFileSync(r.context!.mcpFile!, "utf8")).mcpServers.jira.env.T).toBe("tok");
    expect(statSync(r.context!.mcpFile!).mode & 0o777).toBe(0o600);

    writeFileSync(join(edit, "AGENTS.md"), "PR 标题用中文。发布前在 #ops 说一声。\n");
    sh(edit, "git", "commit", "-qam", "more");
    sh(edit, "git", "push", "-q", "origin", "HEAD:main");
    r = await syncTeamConfig(origin, root, { home, env: {} });
    expect(r.context!.instructions).toContain("发布前在 #ops 说一声");
    expect(r.context!.mcpFile).toBeUndefined();
    expect(r.status!.error).toContain("jira：这台机器没有 JIRA_TOKEN");

    r = await syncTeamConfig("", root, { home });
    expect(r.status).toBeNull();
    expect(existsSync(join(root, "team-config"))).toBe(false);
    expect(existsSync(join(home, ".claude/skills/release-notes"))).toBe(false);

    r = await syncTeamConfig(join(W, "nope.git"), root, { home });
    expect(r.status!.error).toContain("拉取失败");
  } finally { rmSync(W, { recursive: true, force: true }); }
});

const claim = (): Claim => ({
  task: { id: "T-0001", channel_id: "c_1", thread_id: "msg_1", agent_id: "a_1", created_by: "u_1", title: "发版", body: "@acha 发版",
    state: "running", step: "", summary: "", decision: null, pr: null, branch: "agent/T-0001", session: "", claimed_by: "m_1", runs: 1 },
  agent: { id: "a_1", handle: "acha", name: "阿查", owner_id: "u_2", machine_id: "m_1", runtime: "codex", dispatch: "team", autonomy: "assist" },
  channel: { id: "c_1", name: "支付后端", topic: "", conventions: "发布前在 #ops 说一声" },
  recent: [], thread: [], new: [], names: {}, creator: { name: "张伟", handle: "zhangwei" }, resumed: false,
});

test("the prompt has the team's conventions and the channel's", () => {
  const p = taskPrompt(claim(), { cwd: "/w", writable: [] }, { instructions: "PR 标题用中文", mcp: {} });
  expect(p).toContain("# Team conventions (the team's AGENTS.md; they hold in every channel)\nPR 标题用中文");
  expect(p).toContain("# How #支付后端 works (its members wrote this; it comes before the team's conventions)\n发布前在 #ops 说一声");
  expect(taskPrompt({ ...claim(), channel: { id: "c_1", name: "x", topic: "" } }, { cwd: "/w", writable: [] })).not.toContain("conventions");
});

test("a fresh worktree runs the repository's .remi/setup.sh once, and the prompt says how it went", async () => {
  const W = realpathSync(mkdtempSync(join(tmpdir(), "teamconfig-")));
  try {
    const origin = join(W, "origin.git"), repo = join(W, "repo");
    sh(W, "git", "init", "-q", "--bare", "-b", "main", origin);
    sh(W, "git", "clone", "-q", origin, repo);
    mkdirSync(join(repo, ".remi"));
    writeFileSync(join(repo, ".remi", "setup.sh"), 'echo run >> "$REMI_WORKTREE/../setup-runs"\n[ -f fail ] && { echo "npm ERR! nope" >&2; exit 3; }\nexit 0\n');
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-qm", "init");
    sh(repo, "git", "push", "-q", "origin", "HEAD:main");
    const c = claim();
    const wd = await prepareWorkdir({ ...c, agent: { ...c.agent, repo } }, join(W, "work"));
    expect(wd.setup).toBe("ok");
    expect(taskPrompt(c, wd)).toContain("Its .remi/setup.sh already ran there");
    const again = await prepareWorkdir({ ...c, agent: { ...c.agent, repo } }, join(W, "work"));
    expect(again.setup).toBeUndefined();
    expect(readFileSync(join(W, "work", "setup-runs"), "utf8")).toBe("run\n");

    writeFileSync(join(repo, "fail"), "");
    sh(repo, "git", "add", ".");
    sh(repo, "git", "commit", "-qm", "fail");
    sh(repo, "git", "push", "-q", "origin", "HEAD:main");
    const bad = await prepareWorkdir({ ...c, task: { ...c.task, id: "T-0002", branch: "agent/T-0002" }, agent: { ...c.agent, repo } }, join(W, "work"));
    expect(bad.setup).toContain("failed (exit 3): npm ERR! nope");
    expect(taskPrompt(c, bad)).toContain("fix or work around that first");
  } finally { rmSync(W, { recursive: true, force: true }); }
});
