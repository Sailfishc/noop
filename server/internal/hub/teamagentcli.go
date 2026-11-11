package hub

import (
	"fmt"
	"net/http"
	"strings"
	"time"
)

// More of what the agent's `remi` command does while its task runs (teamcontext.go has read, search and tasks):
// who is in a channel and what it is for, who someone is, a file someone attached, its own memory; and the few
// things it may do itself, all on its own task: say how it is going in the thread, hand over a file now.

// sayEvery: an agent says something in its thread at most this often while it runs (the result comes at the end).
const sayEvery = 5 * time.Minute

// v1AgentChannel: `remi channel [NAME]`: what a channel is for, its default repository, its people and agents.
func (h *Hub) v1AgentChannel(w http.ResponseWriter, q *request) {
	t, a, ok := h.reader(w, q)
	if !ok {
		return
	}
	c, ok := h.agentChannel(w, t, a, q.query("channel"))
	if !ok {
		return
	}
	var b strings.Builder
	fmt.Fprintf(&b, "#%s\n", c.Name)
	if c.Topic != "" {
		fmt.Fprintf(&b, "purpose: %s\n", c.Topic)
	}
	if c.Repo != "" {
		fmt.Fprintf(&b, "usual repository: %s\n", c.Repo)
	}
	if c.Conventions != "" {
		fmt.Fprintf(&b, "conventions (the members' rules for working here; follow them):\n%s\n", c.Conventions)
	}
	rows, err := h.db.Query("SELECT kind, member_id FROM channel_members WHERE channel_id = ? ORDER BY kind DESC, member_id", c.ID)
	if err != nil {
		panic(err)
	}
	var members [][2]string
	for rows.Next() {
		var k, id string
		_ = rows.Scan(&k, &id)
		members = append(members, [2]string{k, id})
	}
	rows.Close()
	b.WriteString("members:\n")
	for _, m := range members {
		b.WriteString("  " + h.whoLine(m[0], m[1]) + "\n")
	}
	writeText(w, b.String())
}

// whoLine: one person or agent in a line.
func (h *Hub) whoLine(kind, id string) string {
	if kind == "user" {
		if u, ok := h.user(id); ok {
			return fmt.Sprintf("%s (@%s), person, %s", u.Name, u.Handle, u.Role)
		}
		return id
	}
	ag, ok := h.agent(id)
	if !ok {
		return id
	}
	owner := ""
	if u, ok := h.user(ag.OwnerID); ok {
		owner = ", responsible: @" + u.Handle
	}
	desc := ""
	if ag.Description != "" {
		desc = ": " + clip(ag.Description, 200)
	}
	return fmt.Sprintf("%s (@%s), agent on %s%s%s", ag.Name, ag.Handle, ag.Runtime, owner, desc)
}

// v1AgentWho: `remi who @HANDLE`: who a person or an agent is, and (an agent) what it works on now. `remi who` alone:
// the agents this task's agent may turn to (teamreach.go).
func (h *Hub) v1AgentWho(w http.ResponseWriter, q *request) {
	t, _, ok := h.reader(w, q)
	if !ok {
		return
	}
	handle := strings.TrimPrefix(strings.TrimSpace(q.query("handle")), "@")
	if handle == "" {
		h.v1AgentWhoList(w, t)
		return
	}
	var id string
	if h.db.QueryRow("SELECT id FROM users WHERE handle = ? AND disabled = 0", handle).Scan(&id) == nil {
		writeText(w, h.whoLine("user", id)+"\n")
		return
	}
	if h.db.QueryRow("SELECT id FROM agents WHERE handle = ?", handle).Scan(&id) != nil {
		errJSON(w, 404, "没有 @"+handle)
		return
	}
	var b strings.Builder
	b.WriteString(h.whoLine("agent", id) + "\n")
	cond, args := readableBy("channel_id", t.CreatedBy) // not what it does in channels the asker cannot see
	for _, x := range scanTasks(h.db.Query("SELECT "+taskCols+` FROM tasks_v1 WHERE agent_id = ?
		AND state NOT IN ('done', 'closed') AND `+cond+` ORDER BY updated DESC LIMIT 10`, append([]any{id}, args...)...)) {
		b.WriteString("  " + h.taskLine(x) + "\n")
	}
	writeText(w, b.String())
}

// v1AgentFile: `remi file /media/…`: a file attached to a message in one of the channels the agent sees (agentSees).
func (h *Hub) v1AgentFile(w http.ResponseWriter, q *request) {
	t, a, ok := h.reader(w, q)
	if !ok {
		return
	}
	p := strings.TrimSpace(q.query("path"))
	if !attachmentRE.MatchString(p) {
		errJSON(w, 400, "path: an attachment as remi read shows it (/media/…)")
		return
	}
	like := "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(`"`+p+`"`) + "%"
	cond, args := readableBy("m.channel_id", t.CreatedBy)
	n := h.count(`SELECT COUNT(*) FROM messages m JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.kind = 'agent'
		AND cm.member_id = ? WHERE m.attachments LIKE ? ESCAPE '\' AND `+cond, append([]any{a.ID, like}, args...)...)
	if n == 0 {
		errJSON(w, 404, "没有这个附件，或者它不在 @"+a.Handle+" 的频道里")
		return
	}
	h.sendMedia(w, strings.TrimPrefix(p, "/media/"))
}

// v1AgentMemory: `remi memory`: the agent's memory.md as it is now.
func (h *Hub) v1AgentMemory(w http.ResponseWriter, q *request) {
	_, a, ok := h.reader(w, q)
	if !ok {
		return
	}
	if strings.TrimSpace(a.Memory) == "" {
		writeText(w, "(empty)\n")
		return
	}
	writeText(w, a.Memory+"\n")
}

// v1AgentSay: `remi say TEXT`: a word on how it goes, in the task's thread, at most every sayEvery.
func (h *Hub) v1AgentSay(w http.ResponseWriter, q *request) {
	t, a, ok := h.reader(w, q)
	if !ok {
		return
	}
	var b struct {
		Text string `json:"text"`
	}
	if strings.HasPrefix(q.r.Header.Get("content-type"), "text/plain") { // the remi command sends the words as they are
		b.Text = string(q.body)
	} else if q.json(&b) != nil {
		b.Text = ""
	}
	if strings.TrimSpace(b.Text) == "" {
		errJSON(w, 400, "text")
		return
	}
	since := h.nowMs() - sayEvery.Milliseconds()
	if h.count(`SELECT COUNT(*) FROM messages WHERE (thread_id = ? OR id = ?) AND author_kind = 'agent' AND author_id = ? AND created > ?`,
		t.ThreadID, t.ThreadID, a.ID, since) > 0 {
		errJSON(w, 429, "5 分钟内只能说一次；结果在最后一并报告")
		return
	}
	m := h.insertMessage(t.ChannelID, &t.ThreadID, member{"agent", a.ID}, trimmed(b.Text, 2000))
	writeText(w, "said: msg="+m.ID+"\n")
}

// v1AgentUpload: `remi upload FILE`: a file of the task's output, handed over now (the rest of out/ goes at the end).
func (h *Hub) v1AgentUpload(w http.ResponseWriter, q *request) {
	t, _, ok := h.reader(w, q)
	if !ok {
		return
	}
	h.storeOutput(w, q, t)
}
