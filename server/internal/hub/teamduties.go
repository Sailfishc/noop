package hub

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// Standing duties (design step 6 「长期职责」, 设计一 and 设计三). A duty is not an object of its own: it is a name on
// triggers. The triggers of one channel, one agent and one duty name are seen together (the channel's trigger panel
// groups them, with how the last seven days went) and paused together. Each firing leaves a line in trigger_runs, the
// duty's history: what came of it (no change, nothing found, it spoke, it proposed, it failed, skipped).
//
// A read-only trigger (new ones are, by default) runs a patrol: the agent may read, run commands, speak in the thread,
// write out/, and ask, but the server refuses its PR, handoff and delegation, and the machine throws away whatever it
// changed in the repository. A patrol that finds nothing a person needs to know ends with "nothing": no message in the
// channel, nothing unread, nothing in anyone's inbox, not on the task board (it is not tracked); one line in the history.
//
// How "post the ⚡ message only when the agent first speaks" fits tasks, which hang on a message and its thread
// (verified for this step): the task is made with the id its first message will have, and the message itself waits in
// the task's `held` column. The run reads it like any first message (the claim puts it in front of the thread). The
// first time anything is posted in that thread (the agent says something, asks a person, reports a result, fails), the
// message goes up first, under that id and at that moment, so the channel shows it in the right order and as unread
// then, never before. A patrol that ends with nothing never posts it. The agent's reaction waits on the id too.

const triggerRunsSchema = `
CREATE TABLE IF NOT EXISTS trigger_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, trigger_id TEXT NOT NULL, at INTEGER NOT NULL,
  outcome TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', task_id TEXT);
CREATE INDEX IF NOT EXISTS trigger_runs_trigger ON trigger_runs (trigger_id, id);
CREATE INDEX IF NOT EXISTS trigger_runs_task ON trigger_runs (task_id);
`

const (
	keepTriggerRuns = 100 // lines of history per trigger
	showTriggerRuns = 20  // lines the panel shows
	maxDutyName     = 40
	recentDays      = 7
)

// Outcomes of one firing. running: its task has not said how it went yet.
const (
	runRunning  = "running"
	runNoChange = "nochange"
	runNothing  = "nothing"
	runSpoke    = "spoke"
	runProposed = "proposed"
	runFailed   = "failed"
	runSkipped  = "skipped"
)

type triggerRunView struct {
	TriggerID string `json:"trigger_id"`
	At        int64  `json:"at"`
	Outcome   string `json:"outcome"`
	Note      string `json:"note,omitempty"`
	TaskID    string `json:"task_id,omitempty"`
}

// readonlyRefusal: what a patrol's agent hears when it tries to hand work on (teamhandoff.go, teamdelegate.go).
const readonlyRefusal = "这是只读巡视：不能转交或委派，也不开 PR。把发现和建议做的事写进结果，由人决定"

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// noteTriggerRun adds a line to a trigger's history and keeps only the latest keepTriggerRuns.
func (h *Hub) noteTriggerRun(triggerID, outcome, note, taskID string) {
	h.must(h.db.Exec("INSERT INTO trigger_runs (trigger_id, at, outcome, note, task_id) VALUES (?, ?, ?, ?, ?)",
		triggerID, h.nowMs(), outcome, clip(oneLine(note), 120), nilIfEmpty(taskID)))
	h.must(h.db.Exec(`DELETE FROM trigger_runs WHERE trigger_id = ? AND id NOT IN
		(SELECT id FROM trigger_runs WHERE trigger_id = ? ORDER BY id DESC LIMIT ?)`, triggerID, triggerID, keepTriggerRuns))
}

// dutyRunEnded: the run of a task a trigger opened said how it went (state: what the machine reported). The first
// word counts: a task that goes on later (people reply) does not change its line.
func (h *Hub) dutyRunEnded(t taskView, state, summary string) {
	if t.Mandate == nil || t.Mandate.Trigger == "" {
		return
	}
	outcome := runSpoke
	switch state {
	case "nothing":
		if t.held != "" {
			outcome = runNothing
		}
	case taskFailed, taskBlocked:
		outcome = runFailed
	}
	h.must(h.db.Exec("UPDATE trigger_runs SET outcome = ?, note = ? WHERE task_id = ? AND outcome = ?",
		outcome, clip(oneLine(summary), 120), t.ID, runRunning))
}

// heldMessage: the first message of a patrol's thread as it will be posted (the run reads it before it is).
func (h *Hub) heldMessage(t taskView) messageView {
	return messageView{ID: t.ThreadID, ChannelID: t.ChannelID, Author: member{"user", t.CreatedBy}, Text: t.held,
		Mentions: h.mentions(t.held), Attachments: []string{}, Created: t.Created, Reactions: []reaction{}}
}

// postHeld: something is about to be posted in this thread; if it is a patrol's whose first message waits, that goes
// up now, under its id, in the name of the person who set the trigger up.
func (h *Hub) postHeld(threadID string) {
	var id, held, by, channelID string
	if h.db.QueryRow("SELECT id, held, created_by, channel_id FROM tasks_v1 WHERE thread_id = ? AND held IS NOT NULL LIMIT 1", threadID).
		Scan(&id, &held, &by, &channelID) != nil {
		return
	}
	h.must(h.db.Exec("UPDATE tasks_v1 SET held = NULL WHERE thread_id = ?", threadID))
	mentions, _ := json.Marshal(h.mentions(held))
	h.must(h.db.Exec(`INSERT OR IGNORE INTO messages (id, channel_id, thread_id, author_kind, author_id, text, mentions, attachments, created)
		VALUES (?, ?, NULL, 'user', ?, ?, ?, '[]', ?)`, threadID, channelID, by, held, string(mentions), h.nowMs()))
	if m, ok := h.message(threadID); ok {
		h.broadcastChannel(channelID, obj{"type": "message", "message": m})
	}
	h.taskChanged(id)
}

// triggerRecent: how the last recentDays went, by outcome.
func (h *Hub) triggerRecent(id string) map[string]int64 {
	out := map[string]int64{}
	rows, err := h.db.Query("SELECT outcome, COUNT(*) FROM trigger_runs WHERE trigger_id = ? AND at >= ? GROUP BY outcome",
		id, h.nowMs()-(recentDays*24*time.Hour).Milliseconds())
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	for rows.Next() {
		var o string
		var n int64
		_ = rows.Scan(&o, &n)
		out[o] = n
	}
	return out
}

func (h *Hub) withRecent(ts []triggerView) []triggerView {
	for i := range ts {
		ts[i].Recent = h.triggerRecent(ts[i].ID)
	}
	return ts
}

// dutyTriggers: the triggers of a duty (channel, agent, name); the panel's "duty" is the trigger itself when it has no
// name (trigger=ID).
func (h *Hub) dutyTriggers(w http.ResponseWriter, q *request, channelID, agentID, duty, triggerID string) ([]triggerView, bool) {
	var ts []triggerView
	if triggerID != "" {
		ts = scanTriggers(h.db.Query("SELECT "+triggerCols+" FROM triggers WHERE id = ?", triggerID))
	} else {
		ts = scanTriggers(h.db.Query("SELECT "+triggerCols+" FROM triggers WHERE channel_id = ? AND agent_id = ? AND duty = ? AND duty != ''",
			channelID, agentID, strings.TrimSpace(duty)))
	}
	if len(ts) == 0 || !h.userCanRead(q.who.userID, ts[0].ChannelID) || !h.memberOrAdmin(ts[0].ChannelID, q.who.userID) {
		errJSON(w, 404, "没有这个职责")
		return nil, false
	}
	return ts, true
}

// v1TriggerRuns: a duty's history, newest first (?channel=&agent=&duty= or ?trigger=), for the channel's members.
func (h *Hub) v1TriggerRuns(w http.ResponseWriter, q *request) {
	ts, ok := h.dutyTriggers(w, q, q.query("channel"), q.query("agent"), q.query("duty"), q.query("trigger"))
	if !ok {
		return
	}
	ids := make([]any, 0, len(ts))
	marks := make([]string, 0, len(ts))
	for _, t := range ts {
		ids, marks = append(ids, t.ID), append(marks, "?")
	}
	rows, err := h.db.Query("SELECT trigger_id, at, outcome, note, COALESCE(task_id, '') FROM trigger_runs WHERE trigger_id IN ("+
		strings.Join(marks, ", ")+") ORDER BY id DESC LIMIT ?", append(ids, showTriggerRuns)...)
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []triggerRunView{}
	for rows.Next() {
		var r triggerRunView
		if err := rows.Scan(&r.TriggerID, &r.At, &r.Outcome, &r.Note, &r.TaskID); err != nil {
			panic(err)
		}
		out = append(out, r)
	}
	writeJSON(w, 200, obj{"runs": out})
}

// v1DutyPause: {channel_id, agent_id, duty, enabled}: pause or resume every trigger of a duty. The same people as for
// one trigger: who set it up, the agent's owner, an admin; all of the duty's, or none.
func (h *Hub) v1DutyPause(w http.ResponseWriter, q *request) {
	var b struct {
		ChannelID string `json:"channel_id"`
		AgentID   string `json:"agent_id"`
		Duty      string `json:"duty"`
		Enabled   *bool  `json:"enabled"`
	}
	_ = q.json(&b)
	if b.Enabled == nil || strings.TrimSpace(b.Duty) == "" {
		errJSON(w, 400, "说清楚哪个职责，暂停还是恢复")
		return
	}
	ts, ok := h.dutyTriggers(w, q, b.ChannelID, b.AgentID, b.Duty, "")
	if !ok {
		return
	}
	me := q.who.userID
	a, _ := h.agent(b.AgentID)
	for _, t := range ts {
		if me != t.CreatedBy && me != a.OwnerID && !h.isAdmin(me) {
			errJSON(w, 403, "这个职责里有别人设的触发器：只有设置它的人、Agent 的主人或管理员能暂停")
			return
		}
	}
	for _, t := range ts {
		h.must(h.db.Exec("UPDATE triggers SET enabled = ? WHERE id = ?", boolInt(*b.Enabled), t.ID))
		h.triggerChanged(t, false)
	}
	writeJSON(w, 200, obj{"triggers": h.withRecent(scanTriggers(h.db.Query("SELECT "+triggerCols+" FROM triggers WHERE channel_id = ? AND agent_id = ? AND duty = ?",
		ts[0].ChannelID, ts[0].AgentID, ts[0].Duty)))})
}

// dutyName: what a person typed as a duty's name, kept to one short line.
func dutyName(s string) string {
	return trimmed(strings.Join(strings.Fields(s), " "), maxDutyName)
}
