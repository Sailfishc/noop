import { expect, test } from "bun:test";
import { addressedTo, isMachineToken, machineReport, teamEnabled, type TeamAgent, type TeamMessage } from "../src/teamagent";

const agent = (id: string, handle: string): TeamAgent =>
  ({ id, handle, name: handle, owner_id: "u_1", machine_id: "m_1", runtime: "codex", dispatch: "confirm", autonomy: "assist" });
const msg = (over: Partial<TeamMessage>): TeamMessage =>
  ({ id: "msg_1", seq: 1, channel_id: "c_1", thread_id: null, author: { kind: "user", id: "u_2" }, text: "", mentions: [], created: 0, ...over });

test("team mode needs a per-machine token and a server", () => {
  expect(isMachineToken("tam_abc")).toBe(true);
  expect(isMachineToken("legacy-shared-token")).toBe(false);
  expect(teamEnabled({ cloud: { url: "http://hub:8080" }, server: { token: "tam_x" } })).toBe(true);
  expect(teamEnabled({ cloud: { url: "http://hub:8080" }, server: { token: "shared" } })).toBe(false);
  expect(teamEnabled({ server: { token: "tam_x" } })).toBe(false);
});

test("machine report: only runtimes that are installed", () => {
  const r = machineReport({ host: { max_parallel: 2 } }, (b) => b === "codex");
  expect(r.runtimes).toEqual(["codex"]);
  expect(r.max_sessions).toBe(2);
  expect(machineReport({}, () => false).max_sessions).toBe(3);
});

test("a message is for the agents it mentions, never for its own author", () => {
  const ama = agent("a_1", "ama"), acha = agent("a_2", "acha");
  const m = msg({ text: "@ama 看一下", mentions: [{ kind: "agent", id: "a_1", handle: "ama" }, { kind: "user", id: "u_3", handle: "wanglei" }] });
  expect(addressedTo(m, [ama, acha]).map((a) => a.handle)).toEqual(["ama"]);
  expect(addressedTo(msg({ text: "大家好" }), [ama, acha])).toEqual([]);
  expect(addressedTo(msg({ author: { kind: "agent", id: "a_1" }, mentions: [{ kind: "agent", id: "a_1", handle: "ama" }] }), [ama])).toEqual([]);
  expect(addressedTo(msg({ thread_id: "msg_0" }), [ama, acha], new Set(["a_2"])).map((a) => a.handle)).toEqual(["acha"]);
});
