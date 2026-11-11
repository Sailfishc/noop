// End-to-end for M1: two people, one machine, one agent, one channel — against a running Go server, with the
// daemon's own module (src/teamagent.ts) as the machine.
//   bun server/test/e2e-team.ts http://127.0.0.1:18080 <invite code for the first admin>
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onAgentMessage, startTeamAgent, type TeamMessage } from "../../src/teamagent";

const BASE = (process.argv[2] ?? "http://127.0.0.1:18080").replace(/\/$/, "");
const INVITE = process.argv[3] ?? "";
let fails = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`); if (!ok) fails++; };
async function api(method: string, path: string, token = "", body?: unknown) {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
}
const until = async (what: string, f: () => boolean | Promise<boolean>, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await f()) return true; await Bun.sleep(50); }
  check(what, false, "timed out");
  return false;
};

async function accept(code: string, handle: string) {
  const r2 = await api("POST", `/api/v1/invites/${code}/accept`, "", { name: handle, handle });
  check(`${handle} joins`, r2.status === 200, JSON.stringify(r2.json).slice(0, 160));
  return r2.json as { session: string; user: { id: string } };
}

const zw = await accept(INVITE, "zhangwei");
const inv = await api("POST", "/api/v1/invites", zw.session, { email: "wang@corp.com" });
const wl = await accept(inv.json.code, "wanglei");

const mach = await api("POST", "/api/v1/machines", wl.session, { name: "王磊的 Mac" });
const token = mach.json.token as string, mid = mach.json.machine.id as string;
const agent = await api("POST", "/api/v1/agents", wl.session, { handle: "acha", name: "阿查", machine_id: mid });
const ch = await api("POST", "/api/v1/channels", zw.session, { name: "支付后端", members: [{ kind: "user", id: wl.user.id }, { kind: "agent", id: agent.json.id }] });

// the machine joins with the daemon's own code
const W = mkdtempSync(join(tmpdir(), "teamagent-e2e-"));
const heard: TeamMessage[] = [];
onAgentMessage((m) => { heard.push(m); });
const cfg = { cloud: { url: BASE }, server: { token }, host: { max_parallel: 2 } };
let ta = startTeamAgent(cfg, { stateFile: join(W, "state.json"), log: () => {} })!;
// online comes with the socket; the machine's report (PUT /machine) can land a moment later
await until("machine online and reported", async () => {
  const m = (await api("GET", "/api/v1/machines", zw.session)).json.machines.find((m: any) => m.id === mid);
  return m?.online === true && m.os !== "";
});
const m = (await api("GET", "/api/v1/machines", zw.session)).json.machines.find((x: any) => x.id === mid);
check("machine reported its sessions", m.max_sessions === 2, JSON.stringify(m));
await until("daemon knows its agent", () => ta.agents().some((a) => a.handle === "acha"));

const post = await api("POST", `/api/v1/channels/${ch.json.id}/messages`, zw.session, { text: "@acha 看下慢查询" });
await until("the agent's machine hears the @mention live", () => heard.some((x) => x.id === post.json.id));
await api("POST", `/api/v1/channels/${ch.json.id}/messages`, zw.session, { text: "没 @ 它的消息" });
const reply = await api("POST", `/api/v1/channels/${ch.json.id}/messages`, token, { text: "收到，在看", thread_id: post.json.id, as_agent: agent.json.id });
check("the agent answers in the thread", reply.status === 200 && reply.json.thread_id === post.json.id);

// offline: messages wait on the server and arrive on reconnect, once
ta.stop();
await Bun.sleep(200);
const missed = await api("POST", `/api/v1/channels/${ch.json.id}/messages`, wl.session, { text: "@acha 你离线时发的" });
ta = startTeamAgent(cfg, { stateFile: join(W, "state.json"), log: () => {} })!;
await until("catch up after reconnect", () => heard.some((x) => x.id === missed.json.id));
await Bun.sleep(300);
check("nothing delivered twice", heard.length === 2, heard.map((x) => x.text).join(" | "));
check("unaddressed messages are not handed to the agent", !heard.some((x) => x.text.includes("没 @")));

// a person's own machine that synced the team config repository before (it no longer gets one unless its owner
// turns that on): the daemon clears what it left, the skills' links and the MCP servers' file, when it starts
ta.stop();
const root = join(W, "cfg"), home = join(W, "home");
mkdirSync(join(root, "team-config", "skills", "release-notes"), { recursive: true });
writeFileSync(join(root, "team-config", "skills", "release-notes", "SKILL.md"), "# release notes");
mkdirSync(join(home, ".claude", "skills"), { recursive: true });
const link = join(home, ".claude", "skills", "release-notes");
symlinkSync(join(root, "team-config", "skills", "release-notes"), link);
writeFileSync(join(root, "team-config.links.json"), JSON.stringify({ links: [link] }));
writeFileSync(join(root, "team-config.mcp.json"), "{}");
ta = startTeamAgent(cfg, { stateFile: join(W, "state.json"), log: () => {}, home, configRoot: root })!;
await until("an earlier sync is cleared from a machine that isn't given the team config", () =>
  !existsSync(link) && !existsSync(join(root, "team-config")) && !existsSync(join(root, "team-config.mcp.json")));

ta.stop();

// a private channel: 王磊's own project with his @acha in it. 张伟 (an admin, not in it) sees no trace of it anywhere,
// and @acha, asked by 张伟 in a public channel, cannot bring up what it read there.
const priv = await api("POST", "/api/v1/channels", wl.session, { name: "私房菜", private: true, members: [{ kind: "agent", id: agent.json.id }] });
check("a private channel", priv.status === 200 && priv.json.private === true, JSON.stringify(priv.json).slice(0, 160));
const secret = await api("POST", `/api/v1/channels/${priv.json.id}/messages`, wl.session, { text: "@acha 整理 zebra 菜谱" });
const secretTask = (await api("GET", `/api/v1/tasks?thread=${secret.json.id}`, wl.session)).json.tasks[0];
const trace = (r: { json: any }) => JSON.stringify(r.json).includes("zebra") || JSON.stringify(r.json).includes(priv.json.id);
check("an outsider's channel list has no trace of it", !trace(await api("GET", "/api/v1/channels", zw.session)));
check("nor their search", !trace(await api("GET", "/api/v1/search?q=zebra", zw.session)));
check("nor their task list", !trace(await api("GET", "/api/v1/tasks", zw.session)));
check("nor their inbox", !trace(await api("GET", "/api/v1/inbox", zw.session)));
for (const path of [`/api/v1/channels/${priv.json.id}`, `/api/v1/channels/${priv.json.id}/messages`, `/api/v1/messages/${secret.json.id}/thread`, `/api/v1/tasks/${secretTask.id}`]) {
  check(`by id it is not found: ${path.replace(/\/(?:[a-z]+_[0-9a-f]+|T-\d+)/g, "/…")}`, (await api("GET", path, zw.session)).status === 404);
}
const claim = await api("POST", `/api/v1/tasks/${secretTask.id}/claim`, token);
check("on its owner's task the agent finds the private words", (await (await fetch(`${BASE}/api/v1/agent/search?q=zebra`, { headers: { authorization: `Bearer ${claim.json.read_token}` } })).text()).includes("zebra"));
await api("POST", `/api/v1/tasks/${secretTask.id}/report`, token, { state: "review", summary: "好了", run: claim.json.task.runs });
const ask = await api("POST", `/api/v1/channels/${ch.json.id}/messages`, zw.session, { text: "@acha 找找菜谱" });
const askTask = (await api("GET", `/api/v1/tasks?thread=${ask.json.id}`, zw.session)).json.tasks[0];
await api("POST", `/api/v1/tasks/${askTask.id}/confirm`, wl.session);
const claim2 = await api("POST", `/api/v1/tasks/${askTask.id}/claim`, token);
const found = await (await fetch(`${BASE}/api/v1/agent/search?q=zebra`, { headers: { authorization: `Bearer ${claim2.json.read_token}` } })).text();
check("asked by an outsider elsewhere, it finds nothing there", !found.includes("zebra"), found.slice(0, 160));

rmSync(W, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
