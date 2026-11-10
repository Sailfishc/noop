// End-to-end for M1: two people, one machine, one agent, one channel — against a running Go server, with the
// daemon's own module (src/teamagent.ts) as the machine.
//   bun server/test/e2e-team.ts http://127.0.0.1:18080 <invite code for the first admin>
import { mkdtempSync, rmSync } from "node:fs";
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

ta.stop();
rmSync(W, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
