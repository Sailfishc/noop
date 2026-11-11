package hub

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// Waiting. TeamAgent does not model outside services: the agent decides, from what the person wants, whether a
// result must be seen before the task is done and how to see it. The platform gives it one primitive: wake me.
//
// The agent ends a run with status "waiting" and says what wakes it: a call to the task's callback address
// (callback), a check command its machine runs now and then (poll; the command stays on the machine), or a time
// (timer). Every wait has a deadline. A woken task is queued again and its next run gets why it woke (and the
// callback's body). A waiting task holds no slot on its machine, and nobody is notified while it waits.

const (
	taskWaiting       = "waiting"
	maxCallbackBody   = 64 << 10
	pollMin           = 60 * time.Second
	pollMax           = 30 * time.Minute
	waitMaxDeadline   = 7 * 24 * time.Hour
	pollErrorsToWake  = 3
	defaultWaitWindow = 6 * time.Hour
)

// answer: a person's answer to a question the agent asked (remi ask): only a reply in the thread (or the deadline) wakes it.
// delegates: the tasks its agent delegated (teamdelegate.go): the last one back wakes it with the receipt; no deadline.
var waitHows = map[string]bool{"callback": true, "poll": true, "timer": true, "answer": true, "delegates": true}

// answerWindow: how long a task waits for a person's answer by default before its agent is woken to decide.
const answerWindow = 24 * time.Hour

// waitView: what the task waits for (tasks_v1.wait).
type waitView struct {
	How      string `json:"how"`               // callback | poll | timer | answer | quota | delegates
	Every    int64  `json:"every,omitempty"`   // poll: seconds between checks (grows ×1.5 up to 30 minutes)
	Expect   int64  `json:"expect,omitempty"`  // when the result should be there (unix ms)
	Deadline int64  `json:"deadline"`          // when to stop waiting and wake the agent anyway (unix ms)
	Since    int64  `json:"since"`             // when it started (unix ms)
	NextAt   int64  `json:"next_at,omitempty"` // poll: the next check; timer: when it fires
	Checked  int64  `json:"checked,omitempty"` // poll: the last check
	Checks   int    `json:"checks,omitempty"`  // poll: how many
	Errors   int    `json:"errors,omitempty"`  // poll: the check command failed this many times in a row
	Note     string `json:"note,omitempty"`    // the latest progress line
	What     string `json:"what,omitempty"`    // what it waits for, in the agent's words
	Wake     *wake  `json:"wake,omitempty"`    // why it woke (until its next run takes it)
	// quota: the runtime's limit on a machine (teamquota.go); Expect is when the runtime said it resets (0: it did
	// not say), NextAt when it tries again, Stale that it waited a day and people were told
	Machine string `json:"machine,omitempty"`
	Runtime string `json:"runtime,omitempty"`
	Stale   bool   `json:"stale,omitempty"`
}

type wake struct {
	Reason  string `json:"reason"` // callback | done | failed | errors | timer | deadline | message | quota | delegates
	Note    string `json:"note,omitempty"`
	Payload string `json:"payload,omitempty"` // the callback's body
	At      int64  `json:"at"`
}

func (h *Hub) taskWait(id string) *waitView {
	var s string
	if h.db.QueryRow("SELECT COALESCE(wait, '') FROM tasks_v1 WHERE id = ?", id).Scan(&s) != nil || s == "" {
		return nil
	}
	w := &waitView{}
	if json.Unmarshal([]byte(s), w) != nil {
		return nil
	}
	return w
}

// callbackToken: the task's callback secret, made the first time a run asks.
func (h *Hub) callbackToken(id string) string {
	var tok string
	_ = h.db.QueryRow("SELECT wait_token FROM tasks_v1 WHERE id = ?", id).Scan(&tok)
	if tok == "" {
		tok = randHex(20)
		h.must(h.db.Exec("UPDATE tasks_v1 SET wait_token = ? WHERE id = ?", tok, id))
	}
	return tok
}

func (h *Hub) callbackURL(r *http.Request, token string) string {
	if h.cfg.PublicURL != "" {
		return h.cfg.PublicURL + "/api/v1/hooks/wait/" + token
	}
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	return scheme + "://" + r.Host + "/api/v1/hooks/wait/" + token
}

// startWait: a run ended "waiting" with this request.
type waitRequest struct {
	How      string `json:"how"`
	Every    int64  `json:"every"`    // seconds
	Expect   int64  `json:"expect"`   // seconds from now
	Deadline int64  `json:"deadline"` // seconds from now
	What     string `json:"what"`
}

func (h *Hub) newWait(b *waitRequest) (*waitView, string) {
	if b == nil || !waitHows[b.How] {
		return nil, "waiting 要带 wait.how：callback、poll、timer、answer 或 delegates"
	}
	now := h.nowMs()
	w := &waitView{How: b.How, Since: now, What: trimmed(b.What, 200)}
	dl := time.Duration(b.Deadline) * time.Second
	if dl <= 0 {
		dl = defaultWaitWindow
		if b.How == "answer" {
			dl = answerWindow
		}
	}
	dl = min(dl, waitMaxDeadline)
	w.Deadline = now + dl.Milliseconds()
	if b.How == "delegates" {
		w.Deadline = 0 // it waits as long as they work
	}
	if b.Expect > 0 {
		w.Expect = now + min(time.Duration(b.Expect)*time.Second, dl).Milliseconds()
	}
	switch b.How {
	case "poll":
		every := min(max(time.Duration(b.Every)*time.Second, pollMin), pollMax)
		w.Every = int64(every / time.Second)
		w.NextAt = now + every.Milliseconds()
	case "timer":
		w.NextAt = w.Expect
		if w.NextAt == 0 {
			w.NextAt = w.Deadline
		}
	}
	return w, ""
}

// wakeTask: the wait is over; the task goes back to its machine with why.
func (h *Hub) wakeTask(id string, w *waitView, reason, note, payload string) {
	w.Wake = &wake{Reason: reason, Note: trimmed(note, 500), Payload: payload, At: h.nowMs()}
	step := map[string]string{"callback": "外部回调到了", "done": "外部结果好了", "failed": "外部任务失败了", "errors": "查不到外部状态",
		"timer": "到时间了，去看结果", "deadline": "等到截止时间了，最后确认一次", "quota": "额度恢复了，接着干",
		"delegates": "委派的都交回了，检查汇总"}[reason]
	h.setTask(id, map[string]any{"state": taskQueued, "step": step, "wait": jsonOrNil(w)})
	h.taskChanged(id)
}

// Tick wakes the waits that are due (timers, deadlines, runtimes' limits) and fires the reminders that are. The server calls it every
// half minute.
func (h *Hub) Tick() {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.nowMs()
	rows, err := h.db.Query("SELECT id FROM tasks_v1 WHERE state = ?", taskWaiting)
	if err != nil {
		panic(err)
	}
	var ids []string
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
	for _, id := range ids {
		w := h.taskWait(id)
		if w != nil && (w.How == "quota" || w.How == "delegates") {
			continue // the runtime's limit wakes it (tickQuota); the last delegated task back wakes it (checkReceipt)
		}
		switch {
		case w == nil:
			h.wakeTask(id, &waitView{}, "deadline", "", "")
		case now >= w.Deadline:
			h.wakeTask(id, w, "deadline", w.Note, "")
		case w.How == "timer" && w.NextAt > 0 && now >= w.NextAt:
			h.wakeTask(id, w, "timer", "", "")
		}
	}
	h.tickQuota()
	h.fireReminders()
	h.fireTriggers()
}

// v1WaitHook: anything posted to a task's callback address wakes it with the body (its format is the agent's to
// read).
func (h *Hub) v1WaitHook(w http.ResponseWriter, q *request) {
	tok := q.r.PathValue("token")
	var id string
	if len(tok) != 40 || h.db.QueryRow("SELECT id FROM tasks_v1 WHERE wait_token = ?", tok).Scan(&id) != nil {
		errJSON(w, 404, "not found")
		return
	}
	t, _ := h.task(id)
	wt := h.taskWait(id)
	if t.State != taskWaiting || wt == nil {
		writeJSON(w, 200, obj{"ok": true, "ignored": "the task is not waiting"})
		return
	}
	body := string(q.body)
	if len(body) > maxCallbackBody {
		body = body[:maxCallbackBody]
	}
	h.wakeTask(id, wt, "callback", "", body)
	writeJSON(w, 200, obj{"ok": true})
}

// v1WaitCheck: the machine ran the task's check command: {state: pending|done|failed, note} or {error}.
func (h *Hub) v1WaitCheck(w http.ResponseWriter, q *request) {
	t, _, ok := h.machineTask(w, q)
	if !ok {
		return
	}
	wt := h.taskWait(t.ID)
	if t.State != taskWaiting || wt == nil || wt.How != "poll" {
		errJSON(w, 409, "任务现在不在等查询结果")
		return
	}
	var b struct {
		State string `json:"state"`
		Note  string `json:"note"`
		Error string `json:"error"`
	}
	if err := q.json(&b); err != nil {
		errJSON(w, 400, "bad json")
		return
	}
	now := h.nowMs()
	wt.Checked, wt.Checks = now, wt.Checks+1
	if n := trimmed(b.Note, 300); n != "" {
		wt.Note = n
	}
	switch {
	case b.Error != "":
		wt.Errors++
		if wt.Errors >= pollErrorsToWake {
			h.wakeTask(t.ID, wt, "errors", trimmed(b.Error, 500), "")
			writeJSON(w, 200, obj{"woke": true})
			return
		}
	case b.State == "done" || b.State == "failed":
		h.wakeTask(t.ID, wt, b.State, wt.Note, "")
		writeJSON(w, 200, obj{"woke": true})
		return
	default:
		wt.Errors = 0
	}
	next := time.Duration(float64(time.Duration(wt.Every)*time.Second) * 1.5)
	wt.Every = int64(min(max(next, pollMin), pollMax) / time.Second)
	wt.NextAt = now + wt.Every*1000
	h.setTask(t.ID, map[string]any{"wait": jsonOrNil(wt)})
	h.taskChanged(t.ID)
	writeJSON(w, 200, obj{"woke": false, "next_at": wt.NextAt})
}
