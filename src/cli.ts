#!/usr/bin/env bun
// noop: this machine's side of Remi. It joins a Remi server, runs as a service, and runs the agents' tasks that land
// on this machine (teamagent.ts → teamwork.ts → runtimes.ts). The server and the app hold everything else.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DATA, hostName, loadConfig, type Cfg } from "./config";
import { install, selfUpdate } from "./setup";
import { detectGit, detectRuntimes, startTeamAgent, teamEnabled } from "./teamagent";

const HELP = `noop: this computer's side of Remi

  noop join <server> <code>   join a Remi server with the code from the app (我的机器 → 添加机器)
  noop install                run the daemon as a service (systemd, launchd, or a Scheduled Task)
  noop daemon                 run in the foreground: take this machine's agents' tasks and run them
  noop doctor                 check this machine: server, token, runtimes and their logins, Git credentials
  noop update                 follow this repo's origin now (the daemon does it on its own when idle)
`;

/** Runs the agents' tasks; follows origin when nothing runs (the service manager restarts it on the new code). */
async function daemon(cfg: Cfg) {
  if (!teamEnabled(cfg)) {
    console.error(`这台电脑还没接入 Remi 服务端：先运行 noop join <服务端地址> <接入码>（配置在 ${join(DATA, "config.local.toml")}）`);
    process.exitCode = 1;
    return;
  }
  const ta = startTeamAgent(cfg)!;
  console.log(`remi daemon on ${hostName(cfg)} → ${String(cfg.cloud.url)}`);
  const every = (cfg.update?.check_minutes ?? 30) * 60_000;
  for (;;) {
    await Bun.sleep(every);
    if (ta.worker.running().length) continue;
    if (await selfUpdate().catch(() => false)) {
      console.log("self-updated; restarting");
      ta.stop();
      await ta.worker.idle();
      process.exit(0);
    }
  }
}

/** What this machine needs to work for Remi, each with how to fix it. Exit code 1 when something must be fixed. */
export async function doctor(cfg: Cfg, f: typeof fetch = fetch): Promise<string[]> {
  const lines: string[] = [];
  let bad = false;
  const ok = (good: boolean, text: string, fix = "") => {
    lines.push(`${good ? "✔" : "✘"} ${text}${!good && fix ? `\n    → ${fix}` : ""}`);
    if (!good) bad = true;
  };
  const warn = (text: string, fix: string) => lines.push(`! ${text}\n    → ${fix}`);
  ok(!!Bun.which("git"), "git", "装上 git");
  const url = String(cfg.cloud?.url ?? "");
  if (!teamEnabled(cfg)) ok(false, "接入 Remi 服务端", `在 App 的「我的机器」里添加机器，再运行它给的命令（noop join …）；配置在 ${join(DATA, "config.local.toml")}`);
  else {
    const r = await f(`${url}/api/v1/me`, { headers: { Authorization: `Bearer ${cfg.server.token}` }, signal: AbortSignal.timeout(10_000) }).catch((e: Error) => e);
    if (r instanceof Error) ok(false, `服务端 ${url}`, `连不上：${r.message}。这台电脑要能访问到这个地址`);
    else if (r.status === 401) ok(false, `服务端 ${url}`, "服务端不认这台机器的 token（机器被移除了？）：在 App 的「我的机器」里重新添加");
    else ok(r.ok, `服务端 ${url}${r.ok ? "" : `（${r.status}）`}`, "看一下服务端日志");
  }
  const runtimes = detectRuntimes();
  if (!runtimes.length) ok(false, "runtime", "装一个 runtime：Codex、Claude Code 或 Pi");
  const login: Record<string, string> = { codex: "codex login", claude: "claude auth login", pi: "给 pi 配好模型的凭据" };
  for (const rt of runtimes) {
    if (!rt.installed) { ok(false, `${rt.name}`, `${rt.name} --version 运行失败，重新安装`); continue; }
    if (rt.logged_in === false) ok(false, `${rt.name} ${rt.version}`, `没有登录：${login[rt.name] ?? "登录它"}`);
    else ok(true, `${rt.name} ${rt.version}${rt.logged_in === null ? "（看不出是否登录）" : "，已登录"}`);
  }
  for (const g of await detectGit(cfg)) {
    if (g.configured && g.user) ok(true, `${g.host}：${g.user}（${g.via}）`);
    else if (g.configured) warn(`${g.host}：凭据验证失败`, "检查 token 是否过期");
    else warn(`${g.host}：没有凭据，Agent 推不了分支、开不了 PR`, g.provider === "github" ? "gh auth login，或在 config.local.toml 的 [git.github] 写 token" : "在 config.local.toml 的 [[git.gitlab]] 写 token");
  }
  if (!existsSync(join(DATA, "machine-id"))) warn("这台电脑还没有 machine-id", "noop join 会生成；重新加入时用它找回同一台机器");
  if (bad) process.exitCode = 1;
  return lines;
}

async function main() {
  const [cmd, ...rest] = Bun.argv.slice(2);
  const cfg = loadConfig();
  switch (cmd) {
    case "join": { // the one-line installer: trade the app's join code for this machine's token
      const [server, code] = rest;
      if (!server || !code) throw new Error("用法：noop join <服务端地址> <接入码>");
      const { joinServer } = await import("./join");
      const r = await joinServer(server, code, { data: DATA }).catch((e: Error) => { console.error(e.message); process.exitCode = 1; return null; });
      if (!r) return;
      return void console.log(`已接入 ${server}${r.name ? `：${r.name}` : ""}（配置写在 ${r.file}）`);
    }
    case "install": return install();
    case "daemon": return daemon(cfg);
    case "doctor": return void console.log((await doctor(cfg)).join("\n"));
    case "update": return void console.log((await selfUpdate()) ? "updated" : "up to date");
    default:
      console.log(HELP);
      if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exitCode = 2;
  }
}

if (import.meta.main) await main();
