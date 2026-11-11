package hub

import (
	"encoding/json"
	"fmt"
	"net/http"
)

// How runs that go wrong are kept from going wrong again and again (the Remi side of Raft's failure breaker).
// The machine already retries what a retry can fix (rate limits, provider errors) inside one run; the server counts
// what is left over:
//   - per task: runs in a row that failed, or that died with the daemon (the machine claims its own running task
//     again after a restart). At maxFailures the task stops being run on its own and waits for a person.
//   - per runtime on a machine: a failure that is about the runtime, not the task (a usage limit, out of credit, logged
//     out, not installed) holds back every task that would use it there, instead of each failing in turn
//     (teamquota.go). It used to pause the agent; with an agent on several Computers that stops work the other ones
//     can do.

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

// runEnded: a run on machineID ended with state (a final report). A failure is counted (and one about the runtime holds
// it back there); a wait for the runtime's limit is neither; anything else clears the count and shows the runtime
// works. retryAt, note: what the runtime said about its limit.
func (h *Hub) runEnded(t taskView, a agentView, machineID, state, failure string, retryAt int64, note string, cols map[string]any) {
	if failure == "quota" {
		return // waiting for the runtime's limit: not a failure of the task
	}
	if failure == "" {
		h.runtimeWorked(machineID, a.Runtime)
	}
	if state != taskFailed && state != taskBlocked {
		cols["failures"], cols["last_failure"] = 0, ""
		return
	}
	if failure == "" {
		return // the agent itself said blocked or failed: that is its answer, not a broken run
	}
	failure = trimmed(failure, 40)
	cols["failures"], cols["last_failure"] = t.Failures+1, failure
	h.runtimeFailed(machineID, a.Runtime, failure, retryAt, note)
}

// mayRun: whether machineID's claim may go ahead. A task its runtime there cannot run now stays queued (409,
// teamquota.go); a task the daemon keeps dying on (claimed again by its own machine maxFailures times) is handed to a
// person.
func (h *Hub) mayRun(w http.ResponseWriter, t taskView, a agentView, machineID string, again bool) bool {
	if t.State == taskQueued {
		if ok, why := h.runtimeGate(t, machineID, a.Runtime, true); !ok {
			errJSON(w, 409, why)
			return false
		}
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

// resumeRuntimes: the machine says how its runtimes are; one held back as logged out or missing that is now installed
// and logged in takes work again (a lack of credit or a limit no report can tell).
func (h *Hub) resumeRuntimes(machineID string, info []runtimeInfo) {
	for _, r := range info {
		if !r.Installed || (r.LoggedIn != nil && !*r.LoggedIn) {
			continue
		}
		if s := h.runtimeStatus(machineID, r.Name); s != nil && (s.Reason == "auth" || s.Reason == "not_installed") {
			h.putRuntimeStatus(machineID, r.Name, nil)
		}
	}
}

func (h *Hub) agentChanged(id string) {
	if a, ok := h.agent(id); ok {
		h.broadcastAgent(a)
	}
}
