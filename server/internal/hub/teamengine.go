package hub

import (
	"fmt"
	"net/http"
	"slices"
	"time"
)

// 「换引擎继续」 (design step 5): a task stopped by its runtime on its computer (waiting for the runtime's limit, or held
// back by it: no credit, logged out, not installed) while another runtime there can take work. After a while the
// agent's owner is asked once per stop, on a card that never blocks: go on with that runtime, or keep waiting. Nothing
// switches on its own.
//
// A switch is for this task only (tasks_v1.runtime): the agent keeps its runtime and the other tasks theirs. The task
// stays on the same computer and in the same work directory, starts a fresh session (sessions belong to one runtime)
// from the thread, with that runtime's default model (the agent's model names another runtime's). The task card and
// the PR say which runtime did it.
//
// Not done: switching on its own, switching back on its own, switching while it runs, another computer's runtime (that
// is 换电脑继续).

const (
	engineAfterKnown   = 30 * time.Minute // a limit with a reset this far away (or further) is worth asking about
	engineAfterUnknown = 15 * time.Minute // a limit with no time, or a runtime held back: asked after this long
)

// engineView: the card. Since: when the runtime stopped taking work there (one stop, one card); State: proposed (waits
// for the owner) | kept (the owner keeps waiting) | switched | withdrawn (the runtime came back, or the task went on).
type engineView struct {
	From      string `json:"from"`
	To        string `json:"to"`
	Machine   string `json:"machine"`
	At        int64  `json:"at"`
	Since     int64  `json:"since"`
	Reason    string `json:"reason"` // what holds From back: quota | billing | auth | not_installed
	State     string `json:"state"`
	DecidedBy string `json:"decided_by,omitempty"`
}

// runsWith: the agent as this task runs it: its own runtime and model, or the runtime the task switched to, with that
// runtime's default model.
func runsWith(t taskView, a agentView) agentView {
	if t.Runtime != "" && t.Runtime != a.Runtime {
		a.Runtime, a.Model = t.Runtime, ""
	}
	return a
}

// engineStop: where a task is stopped by its runtime, and the runtime's trouble there (nil: it is not).
func (h *Hub) engineStop(t taskView, a agentView) (string, *runtimeStatus) {
	machine := ""
	switch {
	case t.State == taskWaiting && t.Wait != nil && t.Wait.How == "quota":
		machine = t.Wait.Machine
	case t.State == taskBlocked && t.ClaimedBy != nil && runtimeTrouble[t.LastFailure] != "":
		machine = *t.ClaimedBy
	case t.State == taskQueued && t.ClaimedBy != nil: // woken to try the runtime again: still stopped while it is held back
		machine = *t.ClaimedBy
	}
	if machine == "" {
		return "", nil
	}
	return machine, h.runtimeStatus(machine, a.Runtime)
}

// engineTarget: the first other runtime on the machine that can take work now ("" when none can).
func (h *Hub) engineTarget(machine, from string) string {
	ms := h.scanMachines(h.db.Query("SELECT "+machineCols+" FROM machines WHERE id = ?", machine))
	if len(ms) == 0 {
		return ""
	}
	for _, r := range ms[0].RuntimeInfo {
		if r.Name != from && runtimes[r.Name] && h.canTake(machine, r.Name) {
			return r.Name
		}
	}
	return ""
}

func (h *Hub) setEngine(id string, e *engineView) {
	h.must(h.db.Exec("UPDATE tasks_v1 SET engine = ? WHERE id = ?", jsonOrNil(e), id))
}

// tickEngines: put a card up where a task has been stopped by its runtime long enough and another runtime on the same
// computer can take it; take it down when the runtime is back or the task went on.
func (h *Hub) tickEngines() {
	ts := scanTasks(h.db.Query("SELECT " + taskCols + ` FROM tasks_v1 WHERE (state = 'waiting' AND json_extract(wait, '$.how') = 'quota')
		OR (state = 'blocked' AND claimed_by IS NOT NULL AND last_failure IN ('quota', 'billing', 'auth', 'not_installed'))
		OR json_extract(engine, '$.state') IN ('proposed', 'kept')`))
	now := h.nowMs()
	for _, t := range ts {
		a, ok := h.agent(t.AgentID)
		a = runsWith(t, a)
		machine, s := h.engineStop(t, a)
		open := t.Engine != nil && (t.Engine.State == "proposed" || t.Engine.State == "kept")
		if !ok || s == nil {
			if open { // the runtime takes work again, or the task went on
				e := *t.Engine
				e.State = "withdrawn"
				h.setEngine(t.ID, &e)
				h.taskChanged(t.ID)
			}
			continue
		}
		if s.State == "quota" && s.Until > 0 {
			if s.Until-now < engineAfterKnown.Milliseconds() {
				continue // it resets soon enough: wait
			}
		} else if now-s.Since < engineAfterUnknown.Milliseconds() {
			continue
		}
		if t.Engine != nil && t.Engine.Since == s.Since {
			if t.Engine.State == "proposed" && t.State != taskQueued { // the card names a runtime that can take it now
				if to := h.engineTarget(machine, a.Runtime); to != "" && to != t.Engine.To {
					e := *t.Engine
					e.To = to
					h.setEngine(t.ID, &e)
					h.taskChanged(t.ID)
				}
			}
			continue // one stop, one card
		}
		to := h.engineTarget(machine, a.Runtime)
		if to == "" {
			continue // no other runtime there can take it: it waits (the task card says why)
		}
		h.setEngine(t.ID, &engineView{From: a.Runtime, To: to, Machine: machine, At: now, Since: s.Since, Reason: s.Reason, State: "proposed"})
		h.noteCall(t, "engine", a.OwnerID)
		h.taskChanged(t.ID)
	}
}

// v1TaskEngine: the agent's owner answers the card: {to} goes on with that runtime (default: the card's), {keep}
// keeps waiting for this one.
func (h *Hub) v1TaskEngine(w http.ResponseWriter, q *request) {
	t, ok := h.task(q.r.PathValue("id"))
	if !ok || !h.canRead(q.who, t.ChannelID) && !h.isOwnerOf(q.who.userID, t.AgentID) {
		errJSON(w, 404, "not found")
		return
	}
	agent, _ := h.agent(t.AgentID)
	if agent.OwnerID != q.who.userID {
		errJSON(w, 403, "只有 Agent 的主人能决定换引擎")
		return
	}
	a := runsWith(t, agent)
	var b struct {
		To   string `json:"to"`
		Keep bool   `json:"keep"`
	}
	_ = q.json(&b)
	if b.Keep {
		if t.Engine == nil || t.Engine.State != "proposed" {
			errJSON(w, 409, "没有要回答的卡片")
			return
		}
		e := *t.Engine
		e.State, e.DecidedBy = "kept", q.who.userID
		h.setEngine(t.ID, &e)
		h.taskChanged(t.ID)
		t, _ = h.task(t.ID)
		writeJSON(w, 200, h.taskOut(q, t))
		return
	}
	machine, s := h.engineStop(t, a)
	if s == nil {
		errJSON(w, 409, "这个任务现在没有被引擎拦住")
		return
	}
	to := b.To
	if to == "" && t.Engine != nil {
		to = t.Engine.To
	}
	if to == "" || to == a.Runtime || !runtimes[to] {
		errJSON(w, 400, "只能换成这台电脑上的另一种引擎")
		return
	}
	ms := h.scanMachines(h.db.Query("SELECT "+machineCols+" FROM machines WHERE id = ?", machine))
	if len(ms) == 0 || !slices.ContainsFunc(ms[0].RuntimeInfo, func(r runtimeInfo) bool { return r.Name == to }) {
		errJSON(w, 400, "只能换成这台电脑上的另一种引擎")
		return
	}
	if !h.canTake(machine, to) {
		errJSON(w, 409, "那种引擎现在也接不了活")
		return
	}
	e := engineView{From: a.Runtime, To: to, Machine: machine, At: h.nowMs(), Since: s.Since, Reason: s.Reason, State: "switched", DecidedBy: q.who.userID}
	if t.Engine != nil && t.Engine.Since == s.Since {
		e.At = t.Engine.At
	}
	if s.Probe == t.ID { // it was the one to try the old runtime: another task will
		s.Probe = ""
		h.putRuntimeStatus(machine, a.Runtime, s)
	}
	h.setEngine(t.ID, &e)
	runtime := to
	if to == agent.Runtime {
		runtime = "" // back to the agent's own
	}
	h.setTask(t.ID, map[string]any{"runtime": runtime, "claimed_by": machine, "session": "", "state": taskQueued, "wait": nil, "step": "",
		"news": 0, "failures": 0, "last_failure": ""})
	h.insertMessage(t.ChannelID, &t.ThreadID, member{"agent", agent.ID}, fmt.Sprintf("%s %s，这个任务换用 %s 接着做：同一个工作目录，新开会话，用 %s 的默认模型。",
		runtimeName(a.Runtime), heldText[s.Reason], runtimeName(to), runtimeName(to)))
	h.taskChanged(t.ID)
	t, _ = h.task(t.ID)
	writeJSON(w, 200, h.taskOut(q, t))
}

// heldText: what holds a runtime back, after its name ("Codex 额度用完了").
var heldText = map[string]string{"quota": "额度用完了", "billing": "余额不足", "auth": "没有登录", "not_installed": "没有安装"}

// runtimeName: how people call a runtime.
func runtimeName(r string) string {
	switch r {
	case "codex":
		return "Codex"
	case "claude":
		return "Claude Code"
	case "pi":
		return "Pi"
	}
	return r
}
