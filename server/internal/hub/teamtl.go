package hub

import (
	"fmt"
	"strings"
	"time"
)

// Channel TL (ADR 0002, Spec §3–§4): each channel may name at most one member agent as its TL (default: none).
// When a person posts a top-level message that addresses no agent (no @agent in text and no "continue talking with @x"
// target), only the channel's TL is woken. Consecutive unaddressed messages within 20 seconds merge into one wake so a
// multi-line thought costs one call, and the TL shares one conversation across the channel (scope "*" in teamconv.go).
//
// The TL acts in the sender's name (existing dispatch and owner-confirmation rules hold) and has three choices:
// 1. Stay silent (status "nothing") — nothing appears in the chat.
// 2. Answer directly — posted as a top-level message in the channel.
// 3. Hand off or delegate to a more suitable agent in the channel, or @-mention a person.

const tlDebounce = 20 * time.Second

const tlPendingSchema = `
CREATE TABLE IF NOT EXISTS tl_pending (
	channel_id TEXT PRIMARY KEY,
	first_seq  INTEGER NOT NULL,
	last_msg   TEXT NOT NULL,
	by_user    TEXT NOT NULL,
	due        INTEGER NOT NULL
);
`

func (h *Hub) cancelTL(channelID string) {
	h.must(h.db.Exec("DELETE FROM tl_pending WHERE channel_id = ?", channelID))
}

func (h *Hub) agentByIDOrHandle(s string) (agentView, bool) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "@")
	if s == "" {
		return agentView{}, false
	}
	if a, ok := h.agent(s); ok {
		return a, true
	}
	var id string
	if h.db.QueryRow("SELECT id FROM agents WHERE handle = ?", s).Scan(&id) == nil {
		return h.agent(id)
	}
	return agentView{}, false
}

func (h *Hub) clearAgentTL(agentID string) {
	rows, err := h.db.Query("SELECT id FROM channels WHERE tl_agent = ?", agentID)
	if err != nil {
		panic(err)
	}
	var cids []string
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		cids = append(cids, id)
	}
	rows.Close()
	if len(cids) == 0 {
		return
	}
	h.must(h.db.Exec("UPDATE channels SET tl_agent = '' WHERE tl_agent = ?", agentID))
	for _, cid := range cids {
		h.cancelTL(cid)
		h.channelChanged(cid)
	}
}

// onPostedTL schedules or extends the 20s merge window for unaddressed human top-level messages in a channel with a TL,
// A change of sender or an explicit mention ends the previous sender's window first.
func (h *Hub) onPostedTL(m messageView) {
	if m.Author.Kind != "user" || m.ThreadID != nil {
		return
	}
	var pending pendingTL
	err := h.db.QueryRow("SELECT channel_id, first_seq, last_msg, by_user FROM tl_pending WHERE channel_id = ?", m.ChannelID).
		Scan(&pending.channelID, &pending.firstSeq, &pending.lastMsg, &pending.byUser)
	if err == nil && (pending.byUser != m.Author.ID || len(m.Mentions) > 0) {
		h.cancelTL(m.ChannelID)
		h.fireTL(pending)
	}
	if len(m.Mentions) > 0 {
		return
	}
	c, ok := h.channel(m.ChannelID)
	if !ok || c.Archived || c.DMAgent != "" || c.TL == "" {
		return
	}
	tl, ok := h.agent(c.TL)
	if !ok || !h.isMember(c.ID, "agent", tl.ID) {
		return
	}
	if tl.Dispatch == "owner" && m.Author.ID != tl.OwnerID {
		return // sender has no permission to dispatch this agent: TL stays out of it
	}
	due := h.nowMs() + tlDebounce.Milliseconds()
	if h.count("SELECT COUNT(*) FROM tl_pending WHERE channel_id = ?", c.ID) > 0 {
		h.must(h.db.Exec("UPDATE tl_pending SET last_msg = ?, by_user = ?, due = ? WHERE channel_id = ?",
			m.ID, m.Author.ID, due, c.ID))
		return
	}
	h.must(h.db.Exec("INSERT INTO tl_pending (channel_id, first_seq, last_msg, by_user, due) VALUES (?, ?, ?, ?, ?)",
		c.ID, m.Seq, m.ID, m.Author.ID, due))
}

type pendingTL struct {
	channelID string
	firstSeq  int64
	lastMsg   string
	byUser    string
}

// tickTL wakes the TL for channels whose 20s merge window has elapsed. Called from Tick (with h.mu held).
func (h *Hub) tickTL() {
	rows, err := h.db.Query("SELECT channel_id, first_seq, last_msg, by_user FROM tl_pending WHERE due <= ? ORDER BY due", h.nowMs())
	if err != nil {
		panic(err)
	}
	var due []pendingTL
	for rows.Next() {
		var p pendingTL
		_ = rows.Scan(&p.channelID, &p.firstSeq, &p.lastMsg, &p.byUser)
		due = append(due, p)
	}
	rows.Close()
	for _, p := range due {
		h.cancelTL(p.channelID)
		h.fireTL(p)
	}
}

func (h *Hub) fireTL(p pendingTL) {
	c, ok := h.channel(p.channelID)
	if !ok || c.Archived || c.DMAgent != "" || c.TL == "" {
		return
	}
	tl, ok := h.agent(c.TL)
	if !ok || !h.isMember(c.ID, "agent", tl.ID) || (tl.Dispatch == "owner" && p.byUser != tl.OwnerID) {
		return
	}
	last, ok := h.message(p.lastMsg)
	if !ok {
		return
	}
	burst := scanMessages(h.db.Query("SELECT "+messageCols+` FROM messages m WHERE m.channel_id = ?
			AND m.thread_id IS NULL AND m.seq >= ? AND m.seq <= ? AND m.author_kind = 'user' AND m.author_id = ? ORDER BY m.seq`,
		c.ID, p.firstSeq, last.Seq, p.byUser))
	var lines []string
	for _, m := range burst {
		if len(m.Mentions) > 0 {
			continue
		}
		who := m.Author.ID
		if u, ok := h.user(m.Author.ID); ok {
			who = fmt.Sprintf("%s (@%s)", u.Name, u.Handle)
		}
		lines = append(lines, fmt.Sprintf("- %s: %s", who, clip(m.Text, 1000)))
	}
	h.createTaskWith(last, last.ID, tl.ID, false, false, taskOrigin{
		By:     p.byUser,
		Firing: &firingView{Kind: "tl", Text: strings.Join(lines, "\n")},
	})
}

// channelActiveTasks lists in-flight tasks in the channel so the TL can tell people when someone or an agent is already
// working on that area (Spec §4).
func (h *Hub) channelActiveTasks(channelID, excludeID string) string {
	ts := scanTasks(h.db.Query("SELECT "+taskCols+` FROM tasks_v1 WHERE channel_id = ? AND id != ?
		AND state NOT IN ('done', 'closed') AND (tracked = 1 OR state IN ('running', 'waiting', 'needs_decision', 'review'))
		ORDER BY updated DESC LIMIT 15`, channelID, excludeID))
	var lines []string
	for _, t := range ts {
		handle := t.AgentID
		if a, ok := h.agent(t.AgentID); ok {
			handle = "@" + a.Handle
		}
		extra := ""
		if t.Step != "" {
			extra = " — " + t.Step
		} else if t.PR != nil && t.PR.URL != "" {
			extra = " — PR " + t.PR.URL
		}
		lines = append(lines, fmt.Sprintf("- %s (%s, %s): %s%s", t.ID, handle, t.State, t.Title, extra))
	}
	return strings.Join(lines, "\n")
}
