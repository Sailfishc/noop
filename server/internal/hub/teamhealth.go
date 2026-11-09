package hub

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
)

// How runs that go wrong are kept from going wrong again and again (the Remi side of Raft's failure breaker).
// The machine already retries what a retry can fix (rate limits, provider errors) inside one run; the server counts
// what is left over:
//   - per task: runs in a row that failed, or that died with the daemon (the machine claims its own running task
//     again after a restart). At maxFailures the task stops being run on its own and waits for a person.
//   - per agent: a failure that is about the runtime, not the task (logged out, out of credit, not installed) pauses
//     the agent: its tasks wait in the queue instead of failing one after another. It goes on by itself when its
//     machine reports the runtime logged in again, or when a person writes in the thread of one of its tasks.

const maxFailures = 3

// usageView: tokens, split the way providers bill them.
type usageView struct {
	Input      int64 `json:"input"`
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_write"`
	Output     int64 `json:"output"`
}

func (u *usageView) UnmarshalJSON(b []byte) error {
	// the daemon says cacheRead / cacheWrite; stored rows say cache_read / cache_write
	var v struct {
		Input       int64  `json:"input"`
		Output      int64  `json:"output"`
		CacheRead   *int64 `json:"cache_read"`
		CacheWrite  *int64 `json:"cache_write"`
		CacheReadC  int64  `json:"cacheRead"`
		CacheWriteC int64  `json:"cacheWrite"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*u = usageView{Input: max(v.Input, 0), Output: max(v.Output, 0), CacheRead: max(v.CacheReadC, 0), CacheWrite: max(v.CacheWriteC, 0)}
	if v.CacheRead != nil {
		u.CacheRead = max(*v.CacheRead, 0)
	}
	if v.CacheWrite != nil {
		u.CacheWrite = max(*v.CacheWrite, 0)
	}
	return nil
}

func (u *usageView) add(b usageView) usageView {
	if u == nil {
		return b
	}
	return usageView{u.Input + b.Input, u.CacheRead + b.CacheRead, u.CacheWrite + b.CacheWrite, u.Output + b.Output}
}

// pauseView: why an agent takes no work now.
type pauseView struct {
	Reason string `json:"reason"` // auth | billing | not_installed
	Text   string `json:"text"`   // for people
	At     int64  `json:"at"`
}

// failures about the runtime on the machine, not about the task
var runtimeFailures = map[string]string{
	"auth":          "runtime 没有登录",
	"billing":       "runtime 额度不足",
	"not_installed": "机器上没有这个 runtime",
}

// runEnded: a run ended with state (a final report). A failure is counted (and may pause the agent); anything else
// clears the count.
func (h *Hub) runEnded(t taskView, a agentView, state, failure string, cols map[string]any) {
	if state != taskFailed && state != taskBlocked {
		cols["failures"], cols["last_failure"] = 0, ""
		return
	}
	if failure == "" {
		return // the agent itself said blocked or failed: that is its answer, not a broken run
	}
	failure = trimmed(failure, 40)
	cols["failures"], cols["last_failure"] = t.Failures+1, failure
	if text, ok := runtimeFailures[failure]; ok && a.Paused == nil {
		p, _ := json.Marshal(pauseView{Reason: failure, Text: text, At: h.nowMs()})
		h.must(h.db.Exec("UPDATE agents SET paused = ? WHERE id = ?", string(p), a.ID))
		h.agentChanged(a.ID)
	}
}

// mayRun: whether the claim may go ahead. A paused agent's task stays queued (409) until the pause ends; a task the
// daemon keeps dying on (claimed again by its own machine maxFailures times) is handed to a person.
func (h *Hub) mayRun(w http.ResponseWriter, t taskView, a agentView, again bool) bool {
	if a.Paused != nil {
		if !h.wroteSince(t.ThreadID, a.Paused.At) {
			errJSON(w, 409, "Agent 暂停了："+a.Paused.Text)
			return false
		}
		h.must(h.db.Exec("UPDATE agents SET paused = '' WHERE id = ?", a.ID)) // a person asked again: try
		h.agentChanged(a.ID)
	}
	if !again {
		return true
	}
	n := t.Failures + 1
	if n < maxFailures {
		h.setTask(t.ID, map[string]any{"failures": n, "last_failure": "restart"})
		return true
	}
	text := fmt.Sprintf("这个任务连续 %d 次运行到一半守护进程就重启了，已停止自动重跑。看一下机器上的日志，在线程里回复一句就会再试。", n)
	h.setTask(t.ID, map[string]any{"state": taskBlocked, "summary": text, "step": "", "failures": n, "last_failure": "restart"})
	h.insertMessage(t.ChannelID, &t.ThreadID, member{"agent", a.ID}, text)
	h.taskChanged(t.ID)
	errJSON(w, 409, "任务反复中断，已交给人处理")
	return false
}

// wroteSince: a person wrote in the thread after at (ms).
func (h *Hub) wroteSince(thread string, at int64) bool {
	var n int
	err := h.db.QueryRow(`SELECT COUNT(*) FROM messages WHERE (thread_id = ? OR id = ?) AND author_kind = 'user' AND created > ?`, thread, thread, at).Scan(&n)
	if err != nil && err != sql.ErrNoRows {
		panic(err)
	}
	return n > 0
}

// resumeAgents: the machine says how its runtimes are; agents paused for a logged-out or missing runtime that is now
// installed and logged in go on.
func (h *Hub) resumeAgents(machineID string, info []runtimeInfo) {
	ready := map[string]bool{}
	for _, r := range info {
		ready[r.Name] = r.Installed && (r.LoggedIn == nil || *r.LoggedIn)
	}
	for _, a := range scanAgents(h.db.Query("SELECT "+agentCols+" FROM agents WHERE machine_id = ? AND paused != ''", machineID)) {
		if a.Paused.Reason != "billing" && ready[a.Runtime] {
			h.must(h.db.Exec("UPDATE agents SET paused = '' WHERE id = ?", a.ID))
			h.agentChanged(a.ID)
		}
	}
}

func (h *Hub) agentChanged(id string) {
	if a, ok := h.agent(id); ok {
		h.broadcastPeople(obj{"type": "agent", "agent": a})
	}
}
