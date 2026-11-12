package hub

import (
	"database/sql"
	"time"
)

// A conversation (一段对话, ADR 0001): consecutive messages between the same person and the same agent in a channel
// share one runtime session (and work directory) so the agent remembers what was just said without re-sending the whole
// chat each turn. After two hours of quiet, the conversation ends; the next message opens a fresh session and recovers
// context from the recent messages of that conversation. A channel's TL shares one conversation across the channel
// (scope "*"). When a turn turns into a tracked task (changes code, opens a PR, asks a decision, waits, or needs
// acceptance), that task keeps the worktree and session for its own thread, and the channel's next conversation starts
// fresh with recent context.

const convIdle = 2 * time.Hour

const conversationsSchema = `
CREATE TABLE IF NOT EXISTS conversations (
	channel_id TEXT NOT NULL,
	scope      TEXT NOT NULL,
	agent_id   TEXT NOT NULL,
	work_id    TEXT NOT NULL DEFAULT '',
	session    TEXT NOT NULL DEFAULT '',
	claimed_by TEXT,
	runtime    TEXT NOT NULL DEFAULT '',
	turns      INTEGER NOT NULL DEFAULT 0,
	updated    INTEGER NOT NULL,
	PRIMARY KEY (channel_id, scope, agent_id)
);
`

func isConvTurn(m messageView, root string, tracked bool, o taskOrigin) bool {
	if tracked || root != m.ID || o.Parent != "" || o.Trigger != "" || o.Reminder != "" || o.Readonly {
		return false
	}
	return o.Firing == nil || o.Firing.Kind == "tl"
}

func convScopeOf(by string, o taskOrigin) string {
	if o.Firing != nil && o.Firing.Kind == "tl" {
		return "*"
	}
	return by
}

// convBind binds a new conversation turn to an active conversation's workdir, session and machine (or starts a new
// segment when none exists or two hours have passed).
func (h *Hub) convBind(m messageView, root string, a agentView, by string, tracked bool, o taskOrigin, newTaskID string) (convID, scope, session string, claimedBy *string) {
	if !isConvTurn(m, root, tracked, o) {
		return "", "", "", nil
	}
	scope = convScopeOf(by, o)
	if scope == "" {
		return "", "", "", nil
	}
	now := h.nowMs()
	var workID, ses, rt string
	var cb sql.NullString
	var turns, updated int64
	err := h.db.QueryRow(`SELECT work_id, session, claimed_by, runtime, turns, updated FROM conversations
		WHERE channel_id = ? AND scope = ? AND agent_id = ?`, m.ChannelID, scope, a.ID).
		Scan(&workID, &ses, &cb, &rt, &turns, &updated)
	if err == sql.ErrNoRows {
		h.must(h.db.Exec(`INSERT INTO conversations (channel_id, scope, agent_id, work_id, session, claimed_by, runtime, turns, updated)
			VALUES (?, ?, ?, ?, '', NULL, ?, 0, ?)`, m.ChannelID, scope, a.ID, newTaskID, a.Runtime, now))
		return newTaskID, scope, "", nil
	}
	if err != nil {
		panic(err)
	}
	sameMachine := !cb.Valid || cb.String == "" || h.agentOn(a.ID, cb.String)
	if now-updated <= convIdle.Milliseconds() && rt == a.Runtime && sameMachine && workID != "" {
		convID = workID
		session = ses
		if cb.Valid && cb.String != "" {
			s := cb.String
			claimedBy = &s
		}
		h.must(h.db.Exec(`UPDATE conversations SET updated = ? WHERE channel_id = ? AND scope = ? AND agent_id = ?`,
			now, m.ChannelID, scope, a.ID))
		return convID, scope, session, claimedBy
	}
	// Idle past 2h, switched runtime/machine, or previous segment promoted to a tracked task: start a new segment.
	h.must(h.db.Exec(`UPDATE conversations SET work_id = ?, session = '', claimed_by = NULL, runtime = ?, updated = ?
		WHERE channel_id = ? AND scope = ? AND agent_id = ?`, newTaskID, a.Runtime, now, m.ChannelID, scope, a.ID))
	return newTaskID, scope, "", nil
}

// convRunningBefore reports whether an earlier turn sharing the same conversation workdir is currently running, so
// back-to-back messages run sequentially in the same session rather than racing on one CLI session.
func (h *Hub) convRunningBefore(t taskView) bool {
	if t.ConvID == "" {
		return false
	}
	return h.count("SELECT COUNT(*) FROM tasks_v1 WHERE conv_id = ? AND num < ? AND state = 'running'", t.ConvID, taskNum(t.ID)) > 0
}

// convRecent returns recent messages from an earlier conversation segment when starting a fresh session after the 2h
// idle window (or after a task promotion rotated the segment), so the agent still recalls the recent exchange.
func (h *Hub) convRecent(t taskView) []messageView {
	if t.convScope == "" || t.Session != "" {
		return nil
	}
	var turns int64
	if h.db.QueryRow("SELECT turns FROM conversations WHERE channel_id = ? AND scope = ? AND agent_id = ?",
		t.ChannelID, t.convScope, t.AgentID).Scan(&turns) != nil || turns == 0 {
		return nil
	}
	var ms []messageView
	if t.convScope == "*" {
		ms = scanMessages(h.db.Query("SELECT "+messageCols+` FROM messages m WHERE m.channel_id = ? AND m.id != ?
			ORDER BY m.seq DESC LIMIT 10`, t.ChannelID, t.ThreadID))
	} else {
		ms = scanMessages(h.db.Query("SELECT "+messageCols+` FROM messages m WHERE m.channel_id = ? AND m.id != ?
			AND ((m.author_kind = 'user' AND m.author_id = ?) OR (m.author_kind = 'agent' AND m.author_id = ?))
			ORDER BY m.seq DESC LIMIT 10`, t.ChannelID, t.ThreadID, t.convScope, t.AgentID))
	}
	for i, j := 0, len(ms)-1; i < j; i, j = i+1, j-1 {
		ms[i], ms[j] = ms[j], ms[i]
	}
	for i := range ms {
		ms[i].Text = clip(ms[i].Text, contextChars)
	}
	return ms
}

// convSession records a running conversation turn's session id as soon as the runtime emits it.
func (h *Hub) convSession(t taskView, a agentView, machineID, session string) {
	if t.convScope == "" || t.ConvID == "" || session == "" {
		return
	}
	h.must(h.db.Exec(`UPDATE conversations SET session = ?, claimed_by = ?, runtime = ?, updated = ?
		WHERE channel_id = ? AND scope = ? AND agent_id = ? AND work_id = ?`,
		session, nilIfEmpty(machineID), a.Runtime, h.nowMs(), t.ChannelID, t.convScope, t.AgentID, t.ConvID))
}

// convFinish updates the conversation at the end of a turn: plain answers keep the session warm for the next message
// (and pass it to any already-queued follow-up message); tasks that stay open or changed a repo keep their workdir
// for their own thread and rotate the channel conversation.
func (h *Hub) convFinish(t taskView, a agentView, machineID, session string, promoted bool) {
	if t.convScope == "" || t.ConvID == "" {
		return
	}
	now := h.nowMs()
	if !promoted && session != "" {
		h.must(h.db.Exec(`UPDATE conversations SET session = ?, claimed_by = ?, runtime = ?, turns = turns + 1, updated = ?
			WHERE channel_id = ? AND scope = ? AND agent_id = ? AND work_id = ?`,
			session, nilIfEmpty(machineID), a.Runtime, now, t.ChannelID, t.convScope, t.AgentID, t.ConvID))
		rows, err := h.db.Query(`SELECT id FROM tasks_v1 WHERE conv_id = ? AND id != ? AND state = 'queued'`, t.ConvID, t.ID)
		if err != nil {
			panic(err)
		}
		var waiting []string
		for rows.Next() {
			var id string
			_ = rows.Scan(&id)
			waiting = append(waiting, id)
		}
		rows.Close()
		for _, id := range waiting {
			h.must(h.db.Exec(`UPDATE tasks_v1 SET session = ?, claimed_by = ? WHERE id = ? AND session = ''`,
				session, nilIfEmpty(machineID), id))
			h.taskChanged(id)
		}
		return
	}
	h.convDetach(t)
}

// convDetach rotates the conversation away from t's workdir so t owns its folder and session on its own.
func (h *Hub) convDetach(t taskView) {
	if t.convScope == "" || t.ConvID == "" {
		return
	}
	h.must(h.db.Exec(`UPDATE conversations SET work_id = '', session = '', claimed_by = NULL, turns = turns + 1, updated = ?
		WHERE channel_id = ? AND scope = ? AND agent_id = ? AND work_id = ?`,
		h.nowMs(), t.ChannelID, t.convScope, t.AgentID, t.ConvID))
	rows, err := h.db.Query(`SELECT id FROM tasks_v1 WHERE conv_id = ? AND id != ? AND state IN ('pending', 'queued') AND runs = 0`, t.ConvID, t.ID)
	if err != nil {
		panic(err)
	}
	var waiting []string
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		waiting = append(waiting, id)
	}
	rows.Close()
	for _, id := range waiting {
		h.must(h.db.Exec(`UPDATE tasks_v1 SET conv_id = id, session = '', claimed_by = NULL WHERE id = ?`, id))
		h.taskChanged(id)
	}
}
