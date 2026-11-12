// The agent's remi command (a shell script on the runtime's PATH) against a stand-in server: what it asks for.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliEnv } from "../src/teamwork";

test("remi turns each command into the right request", async () => {
  const seen: { method: string; path: string; query: Record<string, string>; type: string; body: string; auth: string }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      seen.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), type: req.headers.get("content-type") ?? "", body: await req.text(), auth: req.headers.get("authorization") ?? "" });
      return new Response("ok\n");
    },
  });
  const W = mkdtempSync(join(tmpdir(), "remi-"));
  const env = { ...process.env, ...cliEnv(W, `http://127.0.0.1:${server.port}/`, "rt_abc"), no_proxy: "127.0.0.1", NO_PROXY: "127.0.0.1" };
  // async: the stand-in server answers on this same event loop
  const remi = async (...args: string[]) => {
    const p = Bun.spawn(["remi", ...args], { env, cwd: W, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(p.stdout).text();
    return { exitCode: await p.exited, stdout };
  };
  writeFileSync(join(W, "报告 1.md"), "# 结果");

  await remi("read", "--channel", "支付后端", "--limit", "5");
  await remi("search", "慢", "查询");
  await remi("task", "T-0001");
  await remi("channel", "#后端");
  await remi("who", "@acha");
  await remi("file", "/media/123-spec.pdf");
  await remi("memory");
  await remi("say", "改到一半，", "还差测试");
  await remi("upload", join(W, "报告 1.md"));
  await remi("remind", "每天", "9:00", "@acha", "汇总告警");
  await remi("handoff", "@bei", "写发布说明");
  await remi("ask", "@liuli", "版本号？");
  await remi("submit", "render", "job-1");
  await remi("who");
  await remi("delegate", "@bei", "写文档");
  await remi("propose", "--key", "ci-main-red", "--urgent", "主干", "红了", "--why", "@ci 第 3 次失败 & 没人看", "--plan", "修好测试，主干变绿");
  await remi("reminders");
  await remi("remind", "cancel", "rem_1", "rem_2");
  await remi("remind", "cancel", "--here");
  await remi("remind", "pause", "--here");
  await remi("remind", "resume", "rem_1");
  const usage = await remi("bogus");
  server.stop(true);
  rmSync(W, { recursive: true, force: true });

  expect(seen.every((s) => s.auth === "Bearer rt_abc")).toBe(true);
  expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
    "GET /api/v1/agent/read", "GET /api/v1/agent/search", "GET /api/v1/agent/tasks/T-0001", "GET /api/v1/agent/channel",
    "GET /api/v1/agent/who", "GET /api/v1/agent/file", "GET /api/v1/agent/memory", "POST /api/v1/agent/say", "POST /api/v1/agent/upload",
    "POST /api/v1/agent/remind", "POST /api/v1/agent/handoff", "POST /api/v1/agent/ask", "POST /api/v1/agent/submit",
    "GET /api/v1/agent/who", "POST /api/v1/agent/delegate", "POST /api/v1/agent/propose",
    "GET /api/v1/agent/reminders", "POST /api/v1/agent/remind/cancel", "POST /api/v1/agent/remind/cancel",
    "POST /api/v1/agent/remind/pause", "POST /api/v1/agent/remind/resume",
  ]);
  expect(seen[19]).toMatchObject({ body: "--here" });
  expect(seen[20]).toMatchObject({ body: "rem_1" });
  expect(seen[17]).toMatchObject({ type: "text/plain; charset=utf-8", body: "rem_1 rem_2" });
  expect(seen[18]).toMatchObject({ body: "--here" }); // not a curl option
  expect(Object.fromEntries(new URLSearchParams(seen[15].body))).toEqual({ title: "主干 红了", why: "@ci 第 3 次失败 & 没人看", plan: "修好测试，主干变绿", key: "ci-main-red", urgent: "1" });
  expect(seen[10]).toMatchObject({ type: "text/plain; charset=utf-8", body: "@bei 写发布说明" });
  expect(seen[11]).toMatchObject({ body: "@liuli 版本号？" }); // a leading @ is text, not curl's @file
  expect(seen[12]).toMatchObject({ body: "render job-1" });
  expect(seen[0].query).toEqual({ channel: "支付后端", limit: "5" });
  expect(seen[1].query).toEqual({ q: "慢 查询" });
  expect(seen[3].query).toEqual({ channel: "#后端" });
  expect(seen[4].query).toEqual({ handle: "@acha" });
  expect(seen[5].query).toEqual({ path: "/media/123-spec.pdf" });
  expect(seen[7]).toMatchObject({ type: "text/plain; charset=utf-8", body: "改到一半， 还差测试" });
  expect(seen[8]).toMatchObject({ query: { name: "报告 1.md" }, type: "", body: "# 结果" });
  expect(seen[9]).toMatchObject({ type: "text/plain; charset=utf-8", body: "每天 9:00 @acha 汇总告警" });
  expect(seen[13].query).toEqual({ handle: "" }); // alone: the agents it may turn to
  expect(seen[14]).toMatchObject({ type: "text/plain; charset=utf-8", body: "@bei 写文档" });
  expect(usage.exitCode).toBe(2);
  expect(usage.stdout).toContain("remi say TEXT");
  expect(usage.stdout).toContain("tomorrow 9:00");
  expect(usage.stdout).toContain("remi handoff @WHO WHAT");
  expect(usage.stdout).toContain("remi delegate @AGENT WHAT");
  expect(usage.stdout).toContain("2026-12-01 10:00");
  expect(usage.stdout).toContain("remi remind cancel ID... | --here"); // the last line of the usage too
  expect(usage.stdout).not.toContain("api=");
});
