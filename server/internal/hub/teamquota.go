package hub

import (
	"encoding/json"
	"net/http"
	"time"
)

// Whether a runtime on a machine can take work now (design step 3 「额度等重置」). A usage limit, a lack of credit, a
// logout are facts about one runtime on one Computer, not about a task or an agent: every agent there that uses it is
// stopped by them alike, and the same agent elsewhere is not. Remi does not know subscriptions, accounts or keys; it
// goes by what the runtime said when a run failed:
//   - quota: a limit that resets. The task waits (wait.how "quota") and is woken in the same session: at the time the
//     runtime named (plus a margin), or, when it named none, after 5 minutes, 15 minutes, an hour, then every hour.
//     One task tries first (the probe); when its run gets through, the others wake. Not a call on a person and not a
//     failure; after a day without getting through, the waiting tasks show in their people's inbox, once.
//   - blocked: credit, a spend cap, a plan that lacks the model (billing), a logout (auth), no runtime
//     (not_installed). Waiting does not help: the run stops for a person as before, and the runtime's other tasks stay
//     queued until a person writes in one of their threads, or (auth, not_installed) the machine reports it fixed.
// A run that ends without such a failure clears it.

const (
	quotaMargin = 90 * time.Second // after the time the runtime named: clocks differ, resets are not to the second
	quotaNotice = 24 * time.Hour   // waited this long without getting through: people are told
)

// quotaBackoff: when a limit gave no time, how long before the next try (the tries-th without a time).
func quotaBackoff(tries int) time.Duration {
	switch {
	case tries <= 1:
		return 5 * time.Minute
	case tries == 2:
		return 15 * time.Minute
	}
	return time.Hour
}

// what each kind of runtime trouble says to people (the machine card, the task card)
var runtimeTrouble = map[string]string{
	"quota":         "等额度恢复",
	"billing":       "需要你处理：余额不足",
	"auth":          "没有登录",
	"not_installed": "没有安装",
}

// runtimeStatus: why a runtime on a machine takes no work now (the runtime_status table).
type runtimeStatus struct {
	State  string `json:"state"`  // quota | blocked
	Reason string `json:"reason"` // quota | billing | auth | not_installed
	Text   string `json:"text"`   // for people
	Note   string `json:"note,omitempty"`
	Until  int64  `json:"until,omitempty"`   // quota: when the runtime said the limit resets (0: it did not say)
	NextAt int64  `json:"next_at,omitempty"` // quota: when a task tries again
	Since  int64  `json:"since"`             // when it stopped taking work
	At     int64  `json:"at"`                // the last time a run ran into it
	Tries  int    `json:"tries,omitempty"`   // quota: tries in a row that gave no time
	Probe  string `json:"probe,omitempty"`   // the task trying now
	Stale  bool   `json:"stale,omitempty"`   // quota: waited quotaNotice; people were told
}

const runtimeStatusSchema = `
CREATE TABLE IF NOT EXISTS runtime_status (machine_id TEXT NOT NULL, runtime TEXT NOT NULL, status TEXT NOT NULL,
  PRIMARY KEY (machine_id, runtime));
`

func (h *Hub) runtimeStatus(machineID, runtime string) *runtimeStatus {
	var s string
	if h.db.QueryRow("SELECT status FROM runtime_status WHERE machine_id = ? AND runtime = ?", machineID, runtime).Scan(&s) != nil {
		return nil
	}
	st := &runtimeStatus{}
	if json.Unmarshal([]byte(s), st) != nil {
		return nil
	}
	return st
}

// runtimeStatuses: a machine's runtimes that take no work now (machineView.runtime_status).
func (h *Hub) runtimeStatuses(machineID string) map[string]runtimeStatus {
	out := map[string]runtimeStatus{}
	rows, err := h.db.Query("SELECT runtime, status FROM runtime_status WHERE machine_id = ?", machineID)
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	for rows.Next() {
		var rt, s string
		_ = rows.Scan(&rt, &s)
		var st runtimeStatus
		if json.Unmarshal([]byte(s), &st) == nil {
			out[rt] = st
		}
	}
	return out
}

// putRuntimeStatus stores it (nil: the runtime takes work again), tells people, and brings the waiting tasks' cards up
// to date.
func (h *Hub) putRuntimeStatus(machineID, runtime string, s *runtimeStatus) {
	if s == nil {
		h.must(h.db.Exec("DELETE FROM runtime_status WHERE machine_id = ? AND runtime = ?", machineID, runtime))
		// the tasks it held back in the queue: their machine hears of them now, not at its next poll
		for _, t := range scanTasks(h.db.Query("SELECT "+taskCols+` FROM tasks_v1 WHERE state = 'queued'
			AND agent_id IN (SELECT id FROM agents WHERE machine_id = ? AND runtime = ?) ORDER BY num`, machineID, runtime)) {
			h.taskChanged(t.ID)
		}
	} else {
		b, _ := json.Marshal(s)
		h.must(h.db.Exec(`INSERT INTO runtime_status (machine_id, runtime, status) VALUES (?, ?, ?)
			ON CONFLICT (machine_id, runtime) DO UPDATE SET status = excluded.status`, machineID, runtime, string(b)))
		h.refreshQuotaWaits(machineID, runtime, s)
	}
	if ms := h.scanMachines(h.db.Query("SELECT "+machineCols+" FROM machines WHERE id = ?", machineID)); len(ms) > 0 {
		h.broadcastPeople(obj{"type": "machine", "machine": ms[0]})
	}
}

// quotaWaits: the tasks waiting for this runtime's limit on this machine, oldest first.
func (h *Hub) quotaWaits(machineID, runtime string) []taskView {
	return scanTasks(h.db.Query("SELECT "+taskCols+` FROM tasks_v1 WHERE state = 'waiting' AND json_extract(wait, '$.how') = 'quota'
		AND json_extract(wait, '$.machine') = ? AND json_extract(wait, '$.runtime') = ? ORDER BY updated, num`, machineID, runtime))
}

// refreshQuotaWaits: the waiting tasks show the runtime's time and whether people were told.
func (h *Hub) refreshQuotaWaits(machineID, runtime string, s *runtimeStatus) {
	for _, t := range h.quotaWaits(machineID, runtime) {
		w := t.Wait
		if w.Expect == s.Until && w.NextAt == s.NextAt && w.Stale == s.Stale {
			continue
		}
		w.Expect, w.NextAt, w.Stale = s.Until, s.NextAt, s.Stale
		h.setTask(t.ID, map[string]any{"wait": jsonOrNil(w)})
		h.taskChanged(t.ID)
	}
}

// runtimeFailed: a run on machineID stopped on its runtime (failure: quota, billing, auth, not_installed). retryAt: when
// the runtime said the limit resets (ms, 0: it did not say). Returns the status now.
func (h *Hub) runtimeFailed(machineID, runtime, failure string, retryAt int64, note string) *runtimeStatus {
	text, ok := runtimeTrouble[failure]
	if !ok {
		return nil
	}
	now := h.nowMs()
	s := h.runtimeStatus(machineID, runtime)
	if s == nil || s.Reason != failure {
		s = &runtimeStatus{Since: now}
	}
	s.Reason, s.Text, s.At, s.Probe, s.Note = failure, text, now, "", trimmed(note, 300)
	if failure != "quota" {
		s.State, s.Until, s.NextAt, s.Tries = "blocked", 0, 0, 0
	} else {
		s.State = "quota"
		if retryAt > now {
			s.Until, s.Tries = retryAt, 0
			s.NextAt = retryAt + quotaMargin.Milliseconds()
		} else {
			s.Until = 0
			s.Tries++
			s.NextAt = now + quotaBackoff(s.Tries).Milliseconds()
		}
	}
	h.putRuntimeStatus(machineID, runtime, s)
	return s
}

// runtimeWorked: a run on machineID got through: its runtime takes work again, and the tasks that waited for its limit
// there go on.
func (h *Hub) runtimeWorked(machineID, runtime string) {
	if h.runtimeStatus(machineID, runtime) == nil {
		return
	}
	h.putRuntimeStatus(machineID, runtime, nil)
	for _, t := range h.quotaWaits(machineID, runtime) {
		h.wakeTask(t.ID, t.Wait, "quota", "", "")
	}
}

// quotaWait: what a task waits for when its run stopped on the runtime's limit.
func quotaWait(machineID, runtime string, s *runtimeStatus, now int64) *waitView {
	return &waitView{How: "quota", Since: now, Expect: s.Until, NextAt: s.NextAt, Note: s.Note, Machine: machineID, Runtime: runtime, Stale: s.Stale}
}

// runtimeGate: whether this task may start on machineID now, as far as its runtime there goes. A task the runtime's
// trouble holds back may still go when it is the one to try (its time came and nobody else tries), or when a person
// replied in its thread since the runtime last failed (they may have fixed it). With take, it becomes the one trying.
func (h *Hub) runtimeGate(t taskView, machineID, runtime string, take bool) (bool, string) {
	s := h.runtimeStatus(machineID, runtime)
	if s == nil || s.Probe == t.ID {
		return true, ""
	}
	now := h.nowMs()
	if s.Probe != "" { // the one trying may have gone (cancelled, ended some other way)
		if p, ok := h.task(s.Probe); !ok || (p.State != taskQueued && p.State != taskRunning) {
			s.Probe = ""
		}
	}
	due := s.State == "quota" && now >= s.NextAt && s.Probe == ""
	if !due && !h.repliedSince(t.ThreadID, s.At) {
		return false, s.Text
	}
	if take {
		s.Probe = t.ID
		h.putRuntimeStatus(machineID, runtime, s)
	}
	return true, ""
}

// repliedSince: a person replied in the thread after at (ms); the request itself does not count, so a new task asked
// for after the runtime failed waits like the others.
func (h *Hub) repliedSince(thread string, at int64) bool {
	var n int
	h.must(nil, h.db.QueryRow(`SELECT COUNT(*) FROM messages WHERE thread_id = ? AND author_kind = 'user' AND created > ?`, thread, at).Scan(&n))
	return n > 0
}

// tickQuota: limits whose time came get a task to try; a day without getting through tells people, once.
func (h *Hub) tickQuota() {
	type key struct{ machine, runtime string }
	all := map[key]runtimeStatus{}
	rows, err := h.db.Query("SELECT machine_id, runtime, status FROM runtime_status")
	if err != nil {
		panic(err)
	}
	for rows.Next() {
		var k key
		var s string
		_ = rows.Scan(&k.machine, &k.runtime, &s)
		var st runtimeStatus
		if json.Unmarshal([]byte(s), &st) == nil && st.State == "quota" {
			all[k] = st
		}
	}
	rows.Close()
	now := h.nowMs()
	for k, s := range all {
		changed := false
		if !s.Stale && now-s.Since >= quotaNotice.Milliseconds() {
			s.Stale, changed = true, true
		}
		if s.Probe != "" {
			if p, ok := h.task(s.Probe); !ok || (p.State != taskQueued && p.State != taskRunning) {
				s.Probe, changed = "", true
			}
		}
		if now >= s.NextAt && s.Probe == "" {
			if ws := h.quotaWaits(k.machine, k.runtime); len(ws) > 0 {
				s.Probe, changed = ws[0].ID, true
				h.wakeTask(ws[0].ID, ws[0].Wait, "quota", "", "")
			} // none waiting: the first queued task the machine claims tries (runtimeGate)
		}
		if changed {
			h.putRuntimeStatus(k.machine, k.runtime, &s)
		}
	}
}

// v1TaskRetryNow: 「现在就试」 on a task waiting for its runtime's limit (someone topped up, or logged in another
// account): it tries at once, as the one trying.
func (h *Hub) v1TaskRetryNow(w http.ResponseWriter, q *request) {
	t, _, ok := h.taskFor(w, q, "party", taskWaiting)
	if !ok {
		return
	}
	if t.Wait == nil || t.Wait.How != "quota" {
		errJSON(w, 409, "这个任务不在等额度")
		return
	}
	if s := h.runtimeStatus(t.Wait.Machine, t.Wait.Runtime); s != nil {
		s.NextAt, s.Probe = h.nowMs(), t.ID
		h.putRuntimeStatus(t.Wait.Machine, t.Wait.Runtime, s)
	}
	h.wakeTask(t.ID, t.Wait, "quota", "", "")
	t, _ = h.task(t.ID)
	writeJSON(w, 200, h.taskOut(q, t))
}
