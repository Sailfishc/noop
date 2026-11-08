import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { joinServer, setTomlKey } from "../src/join";

test("setTomlKey sets a key in its section and leaves the rest alone", () => {
  expect(setTomlKey("", "cloud", "url", "http://a")).toBe('[cloud]\nurl = "http://a"\n');
  const before = '# mine\n[cloud]\nurl = "http://old"\n\n[git.github]\ntoken = "keep"\n';
  const after = setTomlKey(setTomlKey(before, "cloud", "url", "http://new"), "server", "token", "tam_1");
  expect(after).toBe('# mine\n[cloud]\nurl = "http://new"\n\n[git.github]\ntoken = "keep"\n\n[server]\ntoken = "tam_1"\n');
  expect(setTomlKey('[server]\nmax = 3\n[x]\ntoken = "no"\n', "server", "token", "t")).toBe('[server]\ntoken = "t"\nmax = 3\n[x]\ntoken = "no"\n');
});

test("joinServer trades the code for a token and writes it beside what was there", async () => {
  const data = mkdtempSync(join(tmpdir(), "join-"));
  writeFileSync(join(data, "config.local.toml"), '[git.github]\ntoken = "ghp"\n');
  const asked: string[] = [];
  const sent: any[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    asked.push(`${url} ${JSON.parse(String(init.body)).code}`);
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ token: "tam_abc", machine: { name: "王磊的 Mac" } }));
  }) as unknown as typeof fetch;
  const r = await joinServer("http://10.0.0.5:8080/", " tj_123 ", { data, fetch: fake });
  const key = readFileSync(join(data, "machine-id"), "utf8").trim();
  expect(key).toHaveLength(32);
  await joinServer("http://10.0.0.5:8080", "te_9", { data, fetch: fake });
  expect(sent[1]!.key).toBe(key); // the same computer says the same id
  expect(sent[1]!.os).toBeTruthy();
  expect(asked[0]).toBe("http://10.0.0.5:8080/api/v1/machines/join tj_123");
  expect(r.name).toBe("王磊的 Mac");
  expect(readFileSync(r.file, "utf8")).toBe('[git.github]\ntoken = "ghp"\n\n[cloud]\nurl = "http://10.0.0.5:8080"\n\n[server]\ntoken = "tam_abc"\n');

  const expired = (async () => new Response(JSON.stringify({ error: "接入码已过期" }), { status: 410 })) as unknown as typeof fetch;
  await expect(joinServer("http://x", "tj_1", { data, fetch: expired })).rejects.toThrow("接入码已过期");
  await expect(joinServer("10.0.0.5:8080", "tj_1", { data, fetch: expired })).rejects.toThrow("http://");
});
