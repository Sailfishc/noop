import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteKey, repoBook, scanRepos } from "../src/repos";

test("remoteKey names a repository the way the server does", () => {
  expect(remoteKey("git@github.com:Acme/pay.git")).toBe("github.com/Acme/pay");
  expect(remoteKey("https://github.com/acme/pay/pull/3")).toBe("github.com/acme/pay");
  expect(remoteKey("ssh://git@code.corp.com:2222/fin/core/pay.git")).toBe("code.corp.com/fin/core/pay");
  expect(remoteKey("https://code.corp.com/fin/pay/-/merge_requests/3")).toBe("code.corp.com/fin/pay");
  expect(remoteKey("/srv/git/pay.git")).toBe("");
  expect(remoteKey("")).toBe("");
});

const sh = (cwd: string, ...cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
};

function checkout(dir: string, remote?: string) {
  mkdirSync(dir, { recursive: true });
  sh(dir, "git", "init", "-q");
  if (remote) sh(dir, "git", "remote", "add", "origin", remote);
}

test("scanRepos finds checkouts under the roots by their remote, and only those with one", () => {
  const H = realpathSync(mkdtempSync(join(tmpdir(), "repos-")));
  checkout(join(H, "code", "pay"), "git@github.com:acme/pay.git");
  checkout(join(H, "code", "github.com", "acme", "web"), "https://github.com/acme/web");
  checkout(join(H, "code", "scratch")); // no origin: nothing to name it by
  checkout(join(H, "elsewhere", "ledger"), "https://code.corp.com/fin/ledger.git");
  const m = scanRepos(["~/code"], [join(H, "elsewhere", "ledger")], undefined, H);
  expect([...m.keys()].sort()).toEqual(["code.corp.com/fin/ledger", "github.com/acme/pay", "github.com/acme/web"]);
  expect(m.get("github.com/acme/pay")).toBe(join(H, "code", "pay"));
});

test("repoBook resolves a remote to the checkout, or clones it, or says why not", async () => {
  const H = realpathSync(mkdtempSync(join(tmpdir(), "repos-")));
  checkout(join(H, "code", "pay"), "git@github.com:acme/pay.git");
  const clones = join(H, "clones");
  const cloned: string[] = [];
  const book = repoBook({
    roots: ["~/code"], clones, home: H,
    run: async (cmd) => {
      cloned.push(cmd[3]!);
      if (cmd[3]!.startsWith("git@")) { checkout(cmd[4]!, cmd[3]); return { ok: true, out: "" }; } // https fails, ssh works
      return { ok: false, out: "fatal: Authentication failed" };
    },
  });
  expect(book.list()).toEqual([{ remote: "github.com/acme/pay", name: "pay" }]);
  expect(await book.resolve("github.com/acme/pay")).toBe(join(H, "code", "pay"));
  expect(cloned).toEqual([]);
  expect(await book.resolve("github.com/acme/web")).toBe(join(clones, "github.com", "acme", "web"));
  expect(cloned).toEqual(["https://github.com/acme/web.git", "git@github.com:acme/web.git"]);
  expect(book.list().map((r) => r.remote)).toContain("github.com/acme/web");
  const none = repoBook({ roots: [], clones, home: H, run: async () => ({ ok: false, out: "fatal: repository not found" }) });
  await expect(none.resolve("github.com/acme/secret")).rejects.toThrow("repository not found");
});
