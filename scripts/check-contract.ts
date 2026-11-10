// The client's picture of the server against the real Go server, so the pretend server the UI tests
// use (app/fixtures.ts and the routes tests add) can't drift away from what remi-server sends.
//
//   bun scripts/check-contract.ts                       routes only (no server needed)
//   bun scripts/check-contract.ts <server url> <invite>  also the shapes, against a fresh server
//                                                        (scripts/e2e.sh starts one)
//
// 1. Routes: every "METHOD /api/v1/..." the client calls (app/team/*.ts, api("GET", `/api/v1/...`)) and every
//    route the tests pretend to serve must be one remi-server registers (server/internal/hub/v1.go).
// 2. Shapes: the fixtures' user, machine, agent, channel, message and task carry no field the real server
//    doesn't send, with the same JSON types. Fields the server sends that the fixtures leave out are listed,
//    not failed: a fixture may stay small.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
let fails = 0;
const fail = (s: string) => { console.log(`FAIL ${s}`); fails++; };

// --- routes ------------------------------------------------------------------
type Route = { method: string; parts: string[] };
const split = (p: string) => p.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").slice(1);
const goRoutes: Route[] = [...readFileSync(join(ROOT, "server/internal/hub/v1.go"), "utf8")
  .matchAll(/"(GET|POST|PUT|PATCH|DELETE) (\/api\/v1\/[^"]*)"/g)]
  .map(([, method, path]) => ({ method: method!, parts: split(path!) }));
const served = (method: string, path: string) => {
  const parts = split(path);
  return goRoutes.some((r) => r.method === method && r.parts.length === parts.length &&
    r.parts.every((p, i) => p.startsWith("{") || parts[i] === "*" || parts[i] === p));
};

const appFiles = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name.startsWith(".") ? [] : appFiles(join(dir, e.name))) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []);
// ${...} in a path is one segment; it may hold a query (`/tasks?${q}`), which split() drops
// (`/link${q}`, a ${...} glued to a segment, is a query string)
const norm = (p: string) => p.replace(/([^/])\$\{[^}]*\}/g, "$1").replace(/\$\{[^}]*\}/g, "*");
const uses: { file: string; method: string; path: string }[] = [];
for (const file of appFiles("app")) {
  const src = readFileSync(join(ROOT, file), "utf8");
  // the client: api("GET", `/api/v1/...`) and fetch(`${url}/api/v1/...`, { method: "POST" ... })
  // (a template may hold quotes inside ${…}: `/signups/${id}/${ok ? "approve" : "reject"}`)
  for (const m of src.matchAll(/\(\s*"(GET|POST|PUT|PATCH|DELETE)",\s*(?:"(\/api\/v1\/[^"]*)"|`(\/api\/v1\/(?:\$\{[^}]*\}|[^`$])*)`)/g)) uses.push({ file, method: m[1]!, path: norm(m[2] ?? m[3]!) });
  for (const m of src.matchAll(/fetch\(`\$\{[^}]+\}(\/api\/v1\/[^`]*)`,\s*\{\s*method:\s*"(GET|POST|PUT|PATCH|DELETE)"/g)) uses.push({ file, method: m[2]!, path: norm(m[1]!) });
  // the pretend server: [`POST ${URL}/api/v1/...`]
  for (const m of src.matchAll(/`(GET|POST|PUT|PATCH|DELETE) \$\{URL\}(\/api\/v1\/[^`]*)`/g)) uses.push({ file, method: m[1]!, path: norm(m[2]!) });
}
const seen = new Set<string>();
for (const u of uses) {
  const key = `${u.method} ${u.path.replace(/[?#].*$/, "")}`;
  if (seen.has(key + u.file)) continue;
  seen.add(key + u.file);
  if (!served(u.method, u.path)) fail(`${u.file}: ${key} is not a route of remi-server (server/internal/hub/v1.go)`);
}
console.log(`routes: ${new Set(uses.map((u) => `${u.method} ${u.path.replace(/[?#].*$/, "")}`)).size} used by the app, ${goRoutes.length} served`);

// --- shapes ------------------------------------------------------------------
const [BASE, INVITE] = [process.argv[2]?.replace(/\/$/, ""), process.argv[3]];
if (BASE && INVITE) {
  const fx = await import(join(ROOT, "app/fixtures.ts"));
  const api = async (method: string, path: string, token = "", body?: unknown) => {
    const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await r.json().catch(() => null) as any;
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(json)}`);
    return json;
  };
  // a small real team: two people, a machine, an agent, a channel, an @mention that becomes a task, a reply
  const zw = await api("POST", `/api/v1/invites/${INVITE}/accept`, "", { name: "张伟", handle: "zhangwei" });
  const wl = await api("POST", `/api/v1/invites/${(await api("POST", "/api/v1/invites", zw.session, { email: "wl@corp.com" })).code}/accept`, "", { name: "王磊", handle: "wanglei" });
  const mach = await api("POST", "/api/v1/machines", zw.session, { name: "张伟的 Mac" });
  await api("PUT", "/api/v1/machine", mach.token, { os: "darwin", arch: "arm64", runtimes: ["codex"], max_sessions: 3 });
  const agent = await api("POST", "/api/v1/agents", zw.session, { handle: "acha", name: "阿查", machine_id: mach.machine.id });
  const ch = await api("POST", "/api/v1/channels", zw.session, { name: "支付后端", members: [{ kind: "user", id: wl.user.id }, { kind: "agent", id: agent.id }] });
  const ask = await api("POST", `/api/v1/channels/${ch.id}/messages`, wl.session, { text: "@acha 看下慢查询", client_id: "c1" });
  await api("POST", `/api/v1/channels/${ch.id}/messages`, mach.token, { text: "收到，在看", thread_id: ask.id, as_agent: agent.id });
  const tasks = (await api("GET", "/api/v1/tasks?limit=10", zw.session)).tasks;

  const real: Record<string, any> = {
    user: (await api("GET", "/api/v1/me", zw.session)).user,
    machine: (await api("GET", "/api/v1/machines", zw.session)).machines[0],
    agent: (await api("GET", "/api/v1/agents", zw.session)).agents[0],
    channel: (await api("GET", "/api/v1/channels", zw.session)).channels.find((c: any) => c.id === ch.id),
    message: (await api("GET", `/api/v1/channels/${ch.id}/messages?limit=10`, zw.session)).messages.find((m: any) => m.id === ask.id),
    reply: (await api("GET", `/api/v1/messages/${ask.id}/thread`, zw.session)).replies[0],
    task: tasks[0],
  };
  const fake: Record<string, any> = { user: fx.zw, machine: fx.mac, agent: fx.acha, channel: fx.pay, message: fx.m1, reply: fx.r1, task: fx.task({}) };
  // a message carries client_id only when its sender gave one: compare messages with the fields either has
  real.message = { ...real.reply, ...real.message };
  real.reply = real.message;
  const type = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  for (const [name, f] of Object.entries(fake)) {
    const r = real[name];
    if (!r) { fail(`${name}: the real server returned none to compare with`); continue; }
    const extra = Object.keys(f).filter((k) => !(k in r));
    if (extra.length) fail(`fixtures ${name} has fields remi-server doesn't send: ${extra.join(", ")}`);
    for (const k of Object.keys(f).filter((k) => k in r)) {
      const [a, b] = [type(f[k]), type(r[k])];
      // null stands for "not set" on both sides: only two different non-null types disagree
      if (a !== b && a !== "null" && b !== "null") fail(`fixtures ${name}.${k} is ${a}, remi-server sends ${b} (${JSON.stringify(r[k]).slice(0, 60)})`);
    }
    const missing = Object.keys(r).filter((k) => !(k in f));
    console.log(`shapes: ${name} ok${missing.length ? ` (fixtures leave out: ${missing.join(", ")})` : ""}`);
  }
}
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log("contract: ok");
