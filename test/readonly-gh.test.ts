// The agents' gh and glab only read (teamwork.ts readOnlyGitTools): PRs, CI, commits with the machine's own login;
// pushing, opening and merging stay with the machine and people. A stand-in gh / glab prints what it was run with.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateEnv, setGateCredentials } from "../src/teamwork";

const W = mkdtempSync(join(tmpdir(), "ro-gh-"));
const real = join(W, "real");
mkdirSync(real);
const FAKE = {
  gh: `#!/bin/sh\necho "gh $* token=\${GH_TOKEN:-} config=\${GH_CONFIG_DIR:-}"\n`,
  glab: `#!/bin/sh\necho "glab $* token=\${GITLAB_TOKEN:-} host=\${GITLAB_HOST:-} config=\${GLAB_CONFIG_DIR:-}"\n`,
};
for (const [b, text] of Object.entries(FAKE)) { writeFileSync(join(real, b), text); chmodSync(join(real, b), 0o755); }
const PATH = process.env.PATH;
process.env.PATH = `${real}:${PATH}`;
setGateCredentials({ github: "ghp_machine", gitlab: [{ host: "code.corp.com", token: "glpat_machine" }], dir: join(W, "bin") });
const env = { ...process.env, ...gateEnv({ cwd: join(W, "T-0001"), writable: [] }) };
afterAll(() => { process.env.PATH = PATH; setGateCredentials({}); rmSync(W, { recursive: true, force: true }); });

const run = (cmd: string) => {
  const p = Bun.spawnSync(["sh", "-c", cmd], { env, cwd: W });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
};

test("gh reads with the machine's login", () => {
  for (const cmd of ["gh pr list -R acme/pay", "gh pr view 7 -R acme/pay", "gh pr checks 7", "gh run list -b main", "gh api repos/acme/pay/pulls",
    "gh api -X GET search/issues -f q=repo:acme/pay", "gh api graphql -f query='{ viewer { login } }'", "gh search prs --author @me", "gh --version"]) {
    const r = run(cmd);
    expect(r.code, cmd).toBe(0);
    expect(r.out).toStartWith(cmd.split(" ").slice(0, 2).join(" "));
    expect(r.out).toEndWith("token=ghp_machine config="); // not the empty .no-credentials dir: its own (here: the default)
  }
});

test("gh refuses what writes, and says who does it", () => {
  for (const cmd of ["gh pr create -t x -b y", "gh pr merge 7", "gh pr close 7", "gh pr checkout 7", "gh auth token", "gh repo clone acme/pay",
    "gh api -X POST repos/acme/pay/issues", "gh api repos/acme/pay/issues -f title=x", "gh api --method=DELETE repos/acme/pay",
    "gh api graphql -f query='mutation { x }'", "gh run rerun 5", "gh release create v1"]) {
    const r = run(cmd);
    expect(r.code, cmd).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("推分支和开 PR 由机器做，合并由人做");
  }
});

test("a GraphQL query from a file or stdin is refused: it could hide a mutation; written inline it passes", () => {
  writeFileSync(join(W, "merge.graphql"), "mutation { mergePullRequest(input: {pullRequestId: \"X\"}) { clientMutationId } }");
  for (const tool of ["gh", "glab"]) {
    for (const cmd of [`${tool} api graphql -F query=@merge.graphql`, `${tool} api graphql -f query=@merge.graphql`, `${tool} api graphql -Fquery=@merge.graphql`,
      `${tool} api graphql --field query=@- < merge.graphql`, `${tool} api graphql --input merge.graphql`, `${tool} api graphql --input=merge.graphql`]) {
      const r = run(cmd);
      expect(r.code, cmd).toBe(1);
      expect(r.out).toBe("");
      expect(r.err).toContain("把查询直接写在参数里");
    }
    const ok = run(`${tool} api graphql -f query='{ viewer { login } }'`);
    expect(ok.code).toBe(0);
    expect(ok.out).toStartWith(`${tool} api graphql`);
  }
});

test("glab reads merge requests and pipelines on the internal GitLab", () => {
  const r = run("glab mr list -R fin/ledger");
  expect(r.code).toBe(0);
  expect(r.out).toContain("glab mr list -R fin/ledger token=glpat_machine host=code.corp.com");
  expect(run("glab ci list").code).toBe(0);
  expect(run("glab api projects/1/merge_requests").code).toBe(0);
  for (const cmd of ["glab mr create", "glab mr merge 3", "glab mr approve 3", "glab api -X PUT projects/1", "glab auth status"]) {
    const x = run(cmd);
    expect(x.code, cmd).toBe(1);
    expect(x.err).toContain("合并由人做");
  }
});

test("git still cannot push", () => {
  expect(env.GH_TOKEN).toBe("");
  expect(env.GIT_CONFIG_COUNT).toBe("7");
  expect(env.PATH!.split(":")[0]).toBe(join(W, "bin"));
});
