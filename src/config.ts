// Where this machine keeps its things, and its config. A Remi machine needs only config.local.toml in its data dir:
// the server's address and this machine's token (written by `noop join`), plus any local settings ([host], [clis],
// [git], [remi] roots, [gates]).
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

/** This repo (the daemon's code, self-updating). */
export const CODE = resolve(import.meta.dir, "..");
/** Machine-local home: $NOOP_HOME, else ~/.noop (or ~/.agent-hub on machines from before the rename). */
export function homeDir(): string {
  if (process.env.NOOP_HOME) return resolve(process.env.NOOP_HOME.replace(/^~/, homedir()));
  for (const d of [".noop", ".agent-hub"]) if (existsSync(join(homedir(), d))) return join(homedir(), d);
  return join(homedir(), ".noop");
}
export const HOME_DIR = homeDir();
/** The data dir: config, logs, the machine's id. $HUB_DATA (the service sets it), else <home>/data. */
export const DATA = resolve((process.env.HUB_DATA || join(HOME_DIR, "data")).replace(/^~/, homedir()));

export type Cfg = Record<string, any>;

function merge(a: any, b: any): any {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {}))
    out[k] = v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" ? merge(out[k], v) : v;
  return out;
}

/** config.toml, then config.local.toml over it (both in the data dir; either may be missing). */
export function loadConfig(dir = DATA): Cfg {
  const read = (f: string) => (existsSync(join(dir, f)) ? Bun.TOML.parse(readFileSync(join(dir, f), "utf8")) : {});
  return merge(read("config.toml"), read("config.local.toml"));
}

export const hostName = (cfg: Cfg): string => process.env.HUB_HOST || cfg.host?.name || hostname().split(".")[0];
