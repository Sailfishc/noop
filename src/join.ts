// `noop join <server> <code>`: what the one-line installer runs. It trades the one-time join code from the app
// (我的机器 → 添加机器) for this machine's token and writes both into config.local.toml, keeping everything else.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";

/** Sets `key = "value"` in a TOML section, adding the key or the section when missing; other lines stay as they are. */
export function setTomlKey(text: string, section: string, key: string, value: string): string {
  const line = `${key} = ${JSON.stringify(value)}`;
  const lines = text.split("\n");
  const header = lines.findIndex((l) => l.trim() === `[${section}]`);
  if (header < 0) {
    const body = text.replace(/\n*$/, "");
    return `${body}${body ? "\n\n" : ""}[${section}]\n${line}\n`;
  }
  let end = lines.findIndex((l, i) => i > header && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  const at = lines.findIndex((l, i) => i > header && i < end && new RegExp(`^\\s*${key}\\s*=`).test(l));
  if (at >= 0) lines[at] = line;
  else lines.splice(header + 1, 0, line);
  return lines.join("\n");
}

/** This computer's own id, kept in its data dir: joining again from it finds the same machine (and its agents). */
export function machineKey(data: string): string {
  const file = join(data, "machine-id");
  const have = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (have.length >= 16) return have;
  mkdirSync(data, { recursive: true });
  const key = randomBytes(16).toString("hex");
  writeFileSync(file, key + "\n", { mode: 0o600 });
  return key;
}

const osName = () => (process.platform === "darwin" ? "macOS" : process.platform);

export type JoinResult = { name: string; file: string };

export async function joinServer(server: string, code: string, opts: { data: string; fetch?: typeof fetch }): Promise<JoinResult> {
  const url = server.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) throw new Error(`服务端地址要以 http:// 或 https:// 开头：${server}`);
  let r: Response;
  try {
    r = await (opts.fetch ?? fetch)(`${url}/api/v1/machines/join`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code.trim(), host: hostname().replace(/\.local$/, ""), os: osName(), arch: process.arch, key: machineKey(opts.data) }),
    });
  } catch (e) {
    throw new Error(`连不上服务端 ${url}：${(e as Error).message}。这台电脑要能访问到这个地址。`);
  }
  const body = (await r.json().catch(() => ({}))) as { token?: string; machine?: { name?: string }; error?: string };
  if (!r.ok || !body.token) throw new Error(body.error || `服务端返回 ${r.status}`);
  mkdirSync(opts.data, { recursive: true });
  const file = join(opts.data, "config.local.toml");
  let text = existsSync(file) ? readFileSync(file, "utf8") : "";
  text = setTomlKey(text, "cloud", "url", url);
  text = setTomlKey(text, "server", "token", body.token);
  writeFileSync(file, text, { mode: 0o600 });
  return { name: body.machine?.name ?? "", file };
}
