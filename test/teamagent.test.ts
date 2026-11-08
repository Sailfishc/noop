import { expect, test } from "bun:test";
import { addressedTo, detectGit, detectRuntimes, isMachineToken, machineReport, teamEnabled, type TeamAgent, type TeamMessage } from "../src/teamagent";

const agent = (id: string, handle: string): TeamAgent =>
  ({ id, handle, name: handle, owner_id: "u_1", machine_id: "m_1", runtime: "codex", dispatch: "confirm", autonomy: "assist" });
const msg = (over: Partial<TeamMessage>): TeamMessage =>
  ({ id: "msg_1", seq: 1, channel_id: "c_1", thread_id: null, author: { kind: "user", id: "u_2" }, text: "", mentions: [], created: 0, ...over });

test("team mode needs a per-machine token and a server", () => {
  expect(isMachineToken("tam_abc")).toBe(true);
  expect(isMachineToken("legacy-shared-token")).toBe(false);
  expect(teamEnabled({ cloud: { url: "http://hub:8080" }, server: { token: "tam_x" } })).toBe(true);
  expect(teamEnabled({ cloud: { url: "http://hub:8080" }, server: { token: "shared" } })).toBe(false);
  expect(teamEnabled({ server: { token: "tam_x" } })).toBe(false);
});

test("machine report: only runtimes that are installed", () => {
  const r = machineReport({ host: { max_parallel: 2 } }, (b) => b === "codex");
  expect(r.runtimes).toEqual(["codex"]);
  expect(r.max_sessions).toBe(2);
  expect(machineReport({}, () => false).max_sessions).toBe(3);
});

test("the machine tells which runtimes it has and whether they are logged in", () => {
  const out: Record<string, { code: number; out: string }> = {
    "codex --version": { code: 0, out: "codex-cli 0.46.0" },
    "codex login status": { code: 0, out: "Logged in using ChatGPT" },
    "claude --version": { code: 0, out: "1.0.98 (Claude Code)" },
  };
  expect(detectRuntimes((c) => out[c.join(" ")] ?? null)).toEqual([
    { name: "codex", version: "0.46.0", installed: true, logged_in: true },
    { name: "claude", version: "1.0.98", installed: true, logged_in: null },
  ]);
  out["codex login status"] = { code: 1, out: "Not logged in" };
  delete out["claude --version"];
  expect(detectRuntimes((c) => out[c.join(" ")] ?? null)).toEqual([{ name: "codex", version: "0.46.0", installed: true, logged_in: false }]);
  expect(detectRuntimes(() => null)).toEqual([]);
});

test("git credentials are reported as status only, never the token", async () => {
  const seen: string[] = [];
  const f = async (url: string, init?: RequestInit) => {
    seen.push(url);
    const h = new Headers(init?.headers);
    if (url.endsWith("/api/v4/user") && h.get("private-token") === "glpat-secret") return Response.json({ username: "zhangwei" });
    return new Response("no", { status: 401 });
  };
  const cfg = { git: { gitlab: [{ host: "Code.Corp.com", token: "glpat-secret" }, { host: "other.corp.com" }] } };
  const env = { a: process.env.GITHUB_TOKEN, b: process.env.GH_TOKEN };
  delete process.env.GITHUB_TOKEN; delete process.env.GH_TOKEN; // CI sets one
  const r = await detectGit(cfg, f as any, (c) => (c[0] === "gh" ? { code: 0, out: "gho_x" } : null))
    .finally(() => { if (env.a !== undefined) process.env.GITHUB_TOKEN = env.a; if (env.b !== undefined) process.env.GH_TOKEN = env.b; });
  expect(r).toEqual([
    { provider: "github", host: "github.com", configured: true, via: "gh", user: "" },
    { provider: "gitlab", host: "code.corp.com", configured: true, via: "token", user: "zhangwei" },
    { provider: "gitlab", host: "other.corp.com", configured: false, via: "", user: "" },
  ]);
  expect(JSON.stringify(r)).not.toContain("secret");
  expect(JSON.stringify(r)).not.toContain("gho_x");
  expect(seen).toEqual(["https://api.github.com/user", "https://code.corp.com/api/v4/user"]);
});

test("a message is for the agents it mentions, never for its own author", () => {
  const ama = agent("a_1", "ama"), acha = agent("a_2", "acha");
  const m = msg({ text: "@ama 看一下", mentions: [{ kind: "agent", id: "a_1", handle: "ama" }, { kind: "user", id: "u_3", handle: "wanglei" }] });
  expect(addressedTo(m, [ama, acha]).map((a) => a.handle)).toEqual(["ama"]);
  expect(addressedTo(msg({ text: "大家好" }), [ama, acha])).toEqual([]);
  expect(addressedTo(msg({ author: { kind: "agent", id: "a_1" }, mentions: [{ kind: "agent", id: "a_1", handle: "ama" }] }), [ama])).toEqual([]);
  expect(addressedTo(msg({ thread_id: "msg_0" }), [ama, acha], new Set(["a_2"])).map((a) => a.handle)).toEqual(["acha"]);
});
