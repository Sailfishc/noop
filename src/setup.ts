// noop install / update: the daemon as a service, and following this repo's origin.
import { $ } from "bun";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODE, DATA } from "./config";

// ------------------------------------------------------------------ self-update
/** Fast-forward framework code if origin has new commits that pass tests. Returns true if updated. */
export async function selfUpdate(opts: { busy?: number; force?: boolean } = {}): Promise<boolean> {
  // never swap code (and then restart) under running work: defer until this host is idle
  if ((opts.busy ?? 0) > 0 && !opts.force) return false;
  const g = (...a: string[]) => $`git ${a}`.cwd(CODE).quiet().nothrow();
  if (!existsSync(join(CODE, ".git"))) return false;
  if ((await g("status", "--porcelain", "--untracked-files=no")).stdout.toString().trim()) return false; // local edits → skip
  await g("fetch", "-q", "origin");
  const head = (await g("rev-parse", "HEAD")).stdout.toString().trim();
  const up = (await g("rev-parse", "@{u}")).stdout.toString().trim();
  if (!up || head === up) return false;
  // upstream history may have been rewritten (e.g. scrubbed); with no local edits, follow it — tests below still guard the switch
  if ((await g("merge-base", "--is-ancestor", "HEAD", "@{u}")).exitCode !== 0) {
    // diverged: follow upstream only when it already has every local commit's change (a rewrite); unpushed work stays
    if ((await g("cherry", "@{u}", "HEAD")).stdout.toString().split("\n").some((l) => l.startsWith("+"))) return false;
    await g("reset", "--hard", "-q", "@{u}");
  }
  else await g("merge", "--ff-only", "-q", "@{u}");
  const deps = await $`bun install --frozen-lockfile`.cwd(CODE).quiet().nothrow();
  const test = await $`bun test`.cwd(CODE).quiet().nothrow();
  if (deps.exitCode !== 0 || test.exitCode !== 0) {
    await g("reset", "--hard", "-q", head); // roll back a bad release
    await $`bun install --frozen-lockfile`.cwd(CODE).quiet().nothrow();
    console.error(`self-update to ${up.slice(0, 7)} failed tests → rolled back to ${head.slice(0, 7)}\n${test.stdout.toString().slice(-3000)}${test.stderr.toString().slice(-3000)}`);
    return false;
  }
  console.log(`self-updated ${head.slice(0, 7)} → ${up.slice(0, 7)}`);
  return true;
}

// ------------------------------------------------------------------ service install
/** Machines installed before the rename keep their service name. */
export const SERVICE = existsSync(join(homedir(), ".config/systemd/user/agent-hub.service")) || existsSync(join(homedir(), "Library/LaunchAgents/com.agent-hub.daemon.plist")) ? "agent-hub" : "noop";
const LABEL = SERVICE === "agent-hub" ? "com.agent-hub.daemon" : "dev.noop.daemon";
export async function install() {
  const bun = Bun.which("bun") ?? join(homedir(), ".bun/bin/bun");
  const cli = join(CODE, "src", "cli.ts");
  const path = [join(homedir(), ".bun/bin"), join(homedir(), ".local/bin"), join(homedir(), ".cargo/bin"), join(homedir(), "go/bin"), join(homedir(), ".local/share/mise/shims"),
    join(homedir(), ".local/share/mise/command-wrappers/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  if (process.platform === "linux") {
    const unit = join(homedir(), `.config/systemd/user/${SERVICE}.service`);
    mkdirSync(join(unit, ".."), { recursive: true });
    writeFileSync(unit, `[Unit]
Description=Remi machine daemon
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${bun} ${cli} daemon
Restart=always
RestartSec=10
# stopping lets running agents finish (the daemon drains), so a restart never throws work away.
# The stop timeout must outlast the longest agent run (clis.timeout_minutes, default 60), or systemd
# SIGKILLs the agents mid-run and the restarted daemon redoes them.
KillMode=mixed
TimeoutStopSec=90min
Environment=PATH=${path}
Environment=HUB_DATA=${DATA}
Nice=5
# keep the box awake while tasks run
ExecStartPre=-/usr/bin/true

[Install]
WantedBy=default.target
`);
    await $`systemctl --user daemon-reload`.nothrow();
    await $`systemctl --user enable --now ${SERVICE}.service`.nothrow();
    await $`loginctl enable-linger ${process.env.USER ?? ""}`.nothrow(); // run without a login session / monitor
    console.log(`✔ systemd user service installed: ${unit}
  logs:   journalctl --user -u ${SERVICE} -f
  24/7:   linger enabled (runs with no one logged in). To prevent sleep on this always-on box:
          sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`);
  } else if (process.platform === "darwin") {
    const plist = join(homedir(), `Library/LaunchAgents/${LABEL}.plist`);
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-i</string><string>${bun}</string><string>${cli}</string><string>daemon</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string><key>HUB_DATA</key><string>${DATA}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${join(DATA, "logs", "daemon.log")}</string>
  <key>StandardErrorPath</key><string>${join(DATA, "logs", "daemon.log")}</string>
</dict></plist>
`);
    mkdirSync(join(DATA, "logs"), { recursive: true });
    await $`launchctl bootout gui/${process.getuid!()} ${plist}`.quiet().nothrow();
    await $`launchctl bootstrap gui/${process.getuid!()} ${plist}`.nothrow();
    console.log(`✔ launchd agent installed: ${plist} (caffeinate -i keeps it awake while plugged in; when the lid closes, its tasks wait until it is back)`);
  } else if (process.platform === "win32") {
    const cmd = `"${bun}" "${cli}" daemon`;
    await $`schtasks /Create /F /SC ONLOGON /RL LIMITED /TN ${SERVICE} /TR ${cmd}`.nothrow();
    await $`schtasks /Run /TN ${SERVICE}`.nothrow();
    console.log("✔ Scheduled Task '${SERVICE}' installed (runs at logon, restarts with the daemon's own loop). Disable sleep: powercfg /change standby-timeout-ac 0");
  }
}
