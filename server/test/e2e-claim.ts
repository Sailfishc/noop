// End-to-end: noop's real host code (src/core.ts pull + claim over the files API) against a running Go server.
// Three simulated hosts race to claim the same task, five times; exactly one must win each time, and the losers'
// mirrors must end up showing the winner.
//   REMI_TOKEN=... bun server/test/e2e-claim.ts http://127.0.0.1:8080
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = (process.argv[2] ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const TOKEN = process.env.REMI_TOKEN ?? process.env.TEAMAGENT_TOKEN ?? "";
const b64 = (s: string) => Buffer.from(s).toString("base64");
let fails = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`); if (!ok) fails++; };
async function api(path: string, body?: unknown) {
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "x-noop-host": "e2e" };
  const r = await fetch(BASE + path, body === undefined ? { headers } : { method: "POST", body: JSON.stringify(body), headers });
  return { status: r.status, json: await r.json() as any };
}

const run = `r${Date.now()}`;
const W = mkdtempSync(join(tmpdir(), "teamagent-race-"));
const HOSTS = ["h1", "h2", "h3"];
for (const h of HOSTS) {
  mkdirSync(join(W, h, "data"), { recursive: true });
  writeFileSync(join(W, h, "noop.toml"), `[cloud]\nurl = "${BASE}"\n[server]\ntoken = "${TOKEN}"\n`);
}
const claimHost = join(import.meta.dir, "..", "..", "cloud", "test", "claim-host.ts");
for (let round = 1; round <= 5; round++) {
  const tid = `T-${run}${round}0001`.slice(0, 40);
  const r = await api("/api/files/commit", { msg: "task", changes: [{ path: `tasks/inbox/${tid}.md`, base_version: 0, content: b64(`---\nid: ${tid}\ntitle: race ${round}\n---\nbody\n`) }] });
  check(`round ${round}: seed`, r.status === 200, JSON.stringify(r.json).slice(0, 120));
  const startAt = Date.now() + 1500;
  const procs = HOSTS.map((h) => Bun.spawn(["bun", claimHost, tid, String(startAt)], {
    env: { ...process.env, HUB_DATA: join(W, h, "data"), HUB_HOST: h, HUB_SYNC: "", HUB_SYNC_FAKE: "" }, stdout: "pipe", stderr: "pipe" }));
  const out = await Promise.all(procs.map(async (p) => {
    await p.exited;
    const text = (await new Response(p.stdout).text()).trim();
    try { return JSON.parse(text.split("\n").pop() || "{}"); } catch { return { err: text + (await new Response(p.stderr).text()) }; }
  }));
  const winners = out.filter((o) => o.won).map((o) => o.host);
  const changes = (await api(`/api/files/changes?since=0`)).json.files as any[];
  const active = changes.find((f) => f.path === `tasks/active/${tid}.md` && !f.deleted);
  const claimedBy = active ? Buffer.from(active.content, "base64").toString().match(/claimed_by: (\S+)/)?.[1] : null;
  const inboxGone = changes.find((f) => f.path === `tasks/inbox/${tid}.md`)?.deleted === true;
  const losersSynced = HOSTS.filter((h) => !winners.includes(h)).every((h) => {
    try { return readFileSync(join(W, h, "data", "tasks", "active", `${tid}.md`), "utf8").includes(`claimed_by: ${claimedBy}`); } catch { return false; }
  });
  check(`round ${round}: exactly one winner`, winners.length === 1 && claimedBy === winners[0] && inboxGone && losersSynced,
    `winners ${winners.join(",") || "none"} · server says ${claimedBy} · ${JSON.stringify(out.filter((o) => o.err))}`);
}
rmSync(W, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
