// The dev machine of scripts/dev.sh: seeds a fresh server with a small team (once), prints login links, then runs
// this repository's daemon code as the team's machine (dev.sh puts scripts/fake-codex.ts on its PATH as codex).
//
//   NOOP_HOME=<dir>/machine bun scripts/dev.ts <server url> <dir> [invite code of the first admin]
//
// <dir>/state.json keeps the seeded team (sessions, machine token) across restarts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [BASE, DIR_ARG, INVITE] = [process.argv[2]!.replace(/\/$/, ""), process.argv[3]!, process.argv[4]];
const DIR = resolve(DIR_ARG);
const STATE = join(DIR, "state.json");

async function api(method: string, path: string, token = "", body?: unknown) {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await r.json().catch(() => null)) as any;
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(json)}`);
  return json;
}
const sh = (cwd: string, ...cmd: string[]) => {
  const env = { ...process.env, GIT_AUTHOR_NAME: "dev", GIT_AUTHOR_EMAIL: "dev@localhost", GIT_COMMITTER_NAME: "dev", GIT_COMMITTER_EMAIL: "dev@localhost" };
  const r = Bun.spawnSync(cmd, { cwd, env });
  if (r.exitCode) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
};

type State = { zw: string; wl: string; zwId: string; wlId: string; machineToken: string; channel: string };
let state: State;
if (existsSync(STATE)) {
  state = JSON.parse(readFileSync(STATE, "utf8"));
} else {
  if (!INVITE) throw new Error("a fresh server: pass the first admin's invite code");
  // the agent's repository, with a local origin to push agent/T-xxxx branches to
  const origin = join(DIR, "origin.git"), repo = join(DIR, "repo");
  sh(DIR, "git", "init", "-q", "--bare", "-b", "main", origin);
  sh(DIR, "git", "clone", "-q", origin, repo);
  writeFileSync(join(repo, "README.md"), "# orders\n\nA pretend service for the dev team.\n");
  sh(repo, "git", "add", ".");
  sh(repo, "git", "commit", "-qm", "init");
  sh(repo, "git", "push", "-q", "origin", "HEAD:main");
  sh(repo, "git", "remote", "set-head", "origin", "main");

  const zw = await api("POST", `/api/v1/invites/${INVITE}/accept`, "", { name: "张伟", handle: "zhangwei" });
  const wl = await api("POST", `/api/v1/invites/${(await api("POST", "/api/v1/invites", zw.session, { email: "wl@dev.local" })).code}/accept`, "", { name: "王磊", handle: "wanglei" });
  const mach = await api("POST", "/api/v1/machines", zw.session, { name: "开发机" });
  const acha = await api("POST", "/api/v1/agents", zw.session, { handle: "acha", name: "阿查", machine_id: mach.machine.id, repo, description: "管 orders 仓库的 Agent（假 Codex）" });
  const notes = await api("POST", "/api/v1/agents", zw.session, { handle: "notes", name: "记录员", machine_id: mach.machine.id, description: "不碰代码，写笔记和报告" });
  await api("PATCH", `/api/v1/agents/${acha.id}`, zw.session, { dispatch: "team" });
  await api("PATCH", `/api/v1/agents/${notes.id}`, zw.session, { dispatch: "team", confirm: false });
  const members = [{ kind: "user", id: wl.user.id }, { kind: "agent", id: acha.id }, { kind: "agent", id: notes.id }];
  const pay = await api("POST", "/api/v1/channels", zw.session, { name: "支付后端", topic: "orders 服务", members });
  await api("POST", "/api/v1/channels", zw.session, { name: "运维", members: [{ kind: "user", id: wl.user.id }] });
  await api("POST", `/api/v1/channels/${pay.id}/messages`, wl.session, { text: "今天下午三点发版，大家注意一下" });
  await api("POST", `/api/v1/channels/${pay.id}/messages`, zw.session, { text: "收到 👍" });
  // 张伟's own project: only he (and @notes, his) sees it; 王磊 sees no trace of it
  const mine = await api("POST", "/api/v1/channels", zw.session, { name: "私房菜", topic: "周末的菜谱整理", private: true, members: [{ kind: "agent", id: notes.id }] });
  await api("POST", `/api/v1/channels/${mine.id}/messages`, zw.session, { text: "这里记我自己的事，团队看不到" });
  state = { zw: zw.session, wl: wl.session, zwId: zw.user.id, wlId: wl.user.id, machineToken: mach.token, channel: pay.id };
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log("dev: seeded 张伟 (admin), 王磊, the machine 开发机, @acha (orders repo, needs 张伟's confirm), @notes, #支付后端, #运维, 张伟's private 私房菜");
}

for (const [who, session] of [["张伟", state.zw], ["王磊", state.wl]] as const) {
  const c = await api("POST", "/api/v1/login-codes", session);
  console.log(`dev: sign in as ${who}: ${BASE}${c.path}  (code ${c.code})`);
}
console.log(`dev: API as 张伟: curl -H "authorization: Bearer ${state.zw}" ${BASE}/api/v1/me`);
console.log(`dev: try in #支付后端: "@acha 给 orders 加个索引", "@notes 整理一下发版注意事项", tags [decide] [block] [fail] [slow]`);

const { startTeamAgent } = await import("../src/teamagent");
const ta = startTeamAgent({ cloud: { url: BASE }, server: { token: state.machineToken }, host: { max_parallel: 2 } }, {
  stateFile: join(DIR, "teamagent.json"), log: (s: string) => console.log(`machine: ${s}`),
  worker: { workRoot: join(DIR, "work"), logDir: join(DIR, "logs") },
})!;
const bye = () => { ta.stop(); process.exit(0); };
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
console.log("dev: the machine is running (Ctrl-C stops everything)");
