import { expect, test } from "bun:test";
import { doctor } from "../src/cli";

const fakeFetch = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch;

test("doctor: not joined says how to join", async () => {
  const lines = await doctor({}, fakeFetch(200));
  expect(lines.some((l) => l.startsWith("✘ 接入 Remi 服务端") && l.includes("noop join"))).toBe(true);
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
});

test("doctor: a token the server refuses, or a server it cannot reach", async () => {
  const cfg = { cloud: { url: "http://remi.test:8080" }, server: { token: "tam_" + "ab".repeat(32) } };
  let lines = await doctor(cfg, fakeFetch(401));
  expect(lines.find((l) => l.includes("服务端 http://remi.test:8080"))).toContain("重新添加");
  lines = await doctor(cfg, (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch);
  expect(lines.find((l) => l.includes("服务端 http://remi.test:8080"))).toContain("连不上");
  lines = await doctor(cfg, fakeFetch(200));
  expect(lines).toContain("✔ 服务端 http://remi.test:8080");
  process.exitCode = 0;
});
