package hub

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// Check commands (design step 6 「长期职责」, 设计二): a schedule may carry a command that is run first, on the agent's
// computer, before anything else. Its output the same as last time: the firing ends there (no engine, no task, no
// message; one "no change" line in the duty's history). Different, or the command failed or ran past checkTimeout: the
// trigger fires as usual with the output (or the error) added to the request, so the agent sees what changed. A broken
// check must not silence a patrol, and the day's limit holds anyway.
//
// It runs an arbitrary command on someone's computer, so it is stricter than a trigger: a trigger with a check always
// waits for the agent's owner (the responsible person on a team computer) unless they set it themselves, whatever the
// agent's own confirm setting; a changed command waits again. What was confirmed is the command's text
// (check_confirmed), shown to the owner when they confirm. Only schedules take one: a new PR or a push is a change
// already. The output's hash is kept only once the trigger really fired: a change that was skipped (its last task still
// open, the day's limit) is still a change next time.
//
// The check goes to the first of the agent's computers that is online; none online, or none answering within
// checkAnswer: the firing is skipped (counted like the other skips, reason "offline").

const (
	checkTimeout = 60 * time.Second // what the machine gives the command (src/teamwork.ts runCheck)
	checkAnswer  = 3 * time.Minute  // a check not answered by then: its computer went away
	checkOutput  = 4000             // characters of output the machine reports, and the request gets
	maxCheckCmd  = 1000
)

// checkCmdOf: a check command as typed, or an error for a trigger that cannot have one.
func checkCmdOf(kind, cmd string) (string, string) {
	cmd = strings.TrimSpace(cmd)
	if cmd == "" {
		return "", ""
	}
	if kind != "schedule" {
		return "", "只有定时触发器能带检查命令：有新 PR、有推送本身就是变化"
	}
	if len([]rune(cmd)) > maxCheckCmd {
		return "", "检查命令太长（最多 1000 字）"
	}
	return cmd, ""
}

// checkReady: the trigger may run: confirmed, and its check command (if any) is the one its owner confirmed.
func (t triggerView) checkReady() bool {
	return t.ConfirmedBy != nil && (t.CheckCmd == "" || t.CheckCmd == t.checkConfirmed)
}

func (h *Hub) machineOnline(id string) bool {
	ms := h.scanMachines(h.db.Query("SELECT "+machineCols+" FROM machines WHERE id = ?", id))
	return len(ms) > 0 && ms[0].Online
}

// skipOffline: no computer of the agent's ran the check.
func (h *Hub) skipOffline(t triggerView, note string) {
	h.must(h.db.Exec("UPDATE triggers SET check_pending = 0, check_machine = '', skipped = skipped + 1, skipped_run = skipped_run + 1, skip_reason = 'offline' WHERE id = ?", t.ID))
	h.noteTriggerRun(t.ID, runSkipped, note, "")
}

// startCheck: a due schedule with a check: its first computer that is online runs the command.
func (h *Hub) startCheck(t triggerView) {
	if t.checkPending > 0 {
		return // the last one is still out
	}
	machine := ""
	for _, id := range h.agentMachineList(t.AgentID) {
		if h.machineOnline(id) {
			machine = id
			break
		}
	}
	if machine == "" {
		h.skipOffline(t, "Agent 的电脑都不在线")
		return
	}
	h.must(h.db.Exec("UPDATE triggers SET check_pending = ?, check_machine = ? WHERE id = ?", h.nowMs(), machine, t.ID))
	t, _ = h.trigger(t.ID)
	b, _ := json.Marshal(obj{"type": "check", "check": h.checkFor(t)})
	h.socks.send("m:"+machine, b)
}

// checkFor: what the machine needs to run a check: the command, and where to run it: the channel's repository, else
// the agent's own, else a directory of its own.
func (h *Hub) checkFor(t triggerView) obj {
	c, _ := h.channel(t.ChannelID)
	a, _ := h.agent(t.AgentID)
	return obj{"id": t.ID, "agent_id": t.AgentID, "cmd": t.CheckCmd, "repo": c.Repo, "agent_repo": a.Repo}
}

// machineChecks: the checks waiting for this machine (its poll).
func (h *Hub) machineChecks(machineID string) []obj {
	out := []obj{}
	for _, t := range scanTriggers(h.db.Query("SELECT "+triggerCols+" FROM triggers WHERE check_pending > 0 AND check_machine = ?", machineID)) {
		out = append(out, h.checkFor(t))
	}
	return out
}

// tickChecks: checks no computer answered in time are given up.
func (h *Hub) tickChecks() {
	for _, t := range scanTriggers(h.db.Query("SELECT "+triggerCols+" FROM triggers WHERE check_pending > 0 AND check_pending < ?", h.nowMs()-checkAnswer.Milliseconds())) {
		h.skipOffline(t, "检查命令没有回音：电脑离开了")
		h.triggerChanged(t, false)
	}
}

// v1TriggerCheck: the machine brings what the check printed ({hash, output} or {error, output}).
func (h *Hub) v1TriggerCheck(w http.ResponseWriter, q *request) {
	t, ok := h.trigger(q.r.PathValue("id"))
	if !ok || t.checkPending == 0 || t.checkMachine != q.who.machineID {
		errJSON(w, 409, "这个检查不在等这台电脑")
		return
	}
	var b struct {
		Hash   string `json:"hash"`
		Output string `json:"output"`
		Error  string `json:"error"`
	}
	if q.json(&b) != nil {
		errJSON(w, 400, "bad json")
		return
	}
	h.must(h.db.Exec("UPDATE triggers SET check_pending = 0, check_machine = '' WHERE id = ?", t.ID))
	output := clip(strings.TrimRight(b.Output, "\n"), checkOutput)
	result := ""
	switch {
	case b.Error != "" || b.Hash == "":
		why := b.Error
		if why == "" {
			why = "没有结果"
		}
		extra := "检查命令出错了（当作有变化）：" + clip(why, 500)
		if output != "" {
			extra += "\n```\n" + output + "\n```"
		}
		result = h.fire(t, extra)
	case b.Hash == t.checkHash:
		h.noteTriggerRun(t.ID, runNoChange, "", "")
		result = "nochange"
	default:
		result = h.fire(t, "检查命令的输出和上次不同：\n```\n"+output+"\n```")
		if result == "fired" {
			h.must(h.db.Exec("UPDATE triggers SET check_hash = ? WHERE id = ?", trimmed(b.Hash, 128), t.ID))
		}
	}
	h.triggerChanged(t, false)
	writeJSON(w, 200, obj{"result": result})
}
