package hub

import (
	"crypto/subtle"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// What an agent looks up for itself while it runs (as in Raft, where agents read and search the chat with a CLI):
// the claim pushes the least (the request, its thread, a few recent messages), and the `teamagent` command on its
// machine pulls the rest from here: a channel's or a thread's messages, a search, the tasks, one task. It sees what
// its agent sees: the channels the agent is in. The credential is the run's read token, good only while that task
// runs; the agent never holds the machine's token.

// readToken: the task's read token (made once, given with each claim).
func (h *Hub) readToken(id string) string {
	var tok string
	_ = h.db.QueryRow("SELECT read_token FROM tasks_v1 WHERE id = ?", id).Scan(&tok)
	if tok == "" {
		tok = "rt_" + randHex(20)
		h.must(h.db.Exec("UPDATE tasks_v1 SET read_token = ? WHERE id = ?", tok, id))
	}
	return tok
}

// reader: the running task whose read token the request carries, and its agent.
func (h *Hub) reader(w http.ResponseWriter, q *request) (taskView, agentView, bool) {
	tok := strings.TrimSpace(strings.TrimPrefix(q.r.Header.Get("Authorization"), "Bearer "))
	if !strings.HasPrefix(tok, "rt_") {
		errJSON(w, 401, "unauthorized")
		return taskView{}, agentView{}, false
	}
	var id, stored string
	if h.db.QueryRow("SELECT id, read_token FROM tasks_v1 WHERE read_token = ?", tok).Scan(&id, &stored) != nil ||
		subtle.ConstantTimeCompare([]byte(stored), []byte(tok)) != 1 {
		errJSON(w, 401, "unauthorized")
		return taskView{}, agentView{}, false
	}
	t, _ := h.task(id)
	if t.State != taskRunning {
		errJSON(w, 403, "这个任务现在没有在运行，读不了")
		return t, agentView{}, false
	}
	a, _ := h.agent(t.AgentID)
	return t, a, true
}

// agentChannel: a channel the agent is in, by id, slug or name (a leading # is fine); "" = the task's channel.
func (h *Hub) agentChannel(w http.ResponseWriter, t taskView, a agentView, ref string) (channelView, bool) {
	ref = strings.TrimPrefix(strings.TrimSpace(ref), "#")
	if ref == "" {
		ref = t.ChannelID
	}
	c, ok := h.channel(ref)
	if !ok {
		var id string
		if h.db.QueryRow("SELECT id FROM channels WHERE name = ?", ref).Scan(&id) == nil {
			c, ok = h.channel(id)
		}
	}
	if !ok || !h.isMember(c.ID, "agent", a.ID) {
		errJSON(w, 404, "没有这个频道，或者 @"+a.Handle+" 不在里面")
		return c, false
	}
	return c, true
}

// agentChannels: the ids of the channels the agent is in.
func (h *Hub) agentChannels(agentID string) []string {
	rows, err := h.db.Query("SELECT channel_id FROM channel_members WHERE kind = 'agent' AND member_id = ?", agentID)
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		out = append(out, id)
	}
	return out
}

// lines: messages as an agent reads them, one per message: where, when, who, what.
func (h *Hub) lines(ms []messageView, names map[string]string) string {
	var b strings.Builder
	chans := map[string]string{}
	for _, m := range ms {
		if _, ok := chans[m.ChannelID]; !ok {
			c, _ := h.channel(m.ChannelID)
			chans[m.ChannelID] = c.Name
		}
		who, ok := names[m.Author.ID]
		if !ok {
			if m.Author.Kind == "user" {
				if u, ok := h.user(m.Author.ID); ok {
					who = u.Name + " (@" + u.Handle + ")"
				}
			} else if ag, ok := h.agent(m.Author.ID); ok {
				who = ag.Name + " (@" + ag.Handle + ")"
			}
			names[m.Author.ID] = who
		}
		where := "#" + chans[m.ChannelID]
		if m.ThreadID != nil {
			where += " thread=" + *m.ThreadID
		}
		extra := ""
		if m.ReplyCount > 0 {
			extra = fmt.Sprintf(" [%d replies: remi read --thread %s]", m.ReplyCount, m.ID)
		}
		if ts := scanTasks(h.db.Query("SELECT "+taskCols+" FROM tasks_v1 WHERE thread_id = ? AND tracked = 1", m.ID)); m.ThreadID == nil && len(ts) > 0 {
			extra += fmt.Sprintf(" [task %s %s]", ts[0].ID, ts[0].Status)
		}
		fmt.Fprintf(&b, "[%s msg=%s] %s %s: %s%s\n", where, m.ID, time.UnixMilli(m.Created).Format("2006-01-02 15:04"), who,
			strings.ReplaceAll(clip(m.Text, 2000), "\n", "\n  "), extra)
		for _, f := range m.Attachments {
			fmt.Fprintf(&b, "  attachment: %s\n", f)
		}
	}
	return b.String()
}

func writeText(w http.ResponseWriter, s string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte(s))
}

// v1AgentRead: `remi read [--channel X] [--thread MSG] [--limit N] [--before SEQ]`: a thread whole (oldest first),
// or a channel's latest top-level messages (oldest first).
func (h *Hub) v1AgentRead(w http.ResponseWriter, q *request) {
	t, a, ok := h.reader(w, q)
	if !ok {
		return
	}
	limit := clampInt(q.query("limit"), 30, 1, 200)
	var ms []messageView
	if th := q.query("thread"); th != "" {
		root, ok := h.message(th)
		if !ok || !h.isMember(root.ChannelID, "agent", a.ID) {
			errJSON(w, 404, "没有这个线程，或者 @"+a.Handle+" 不在它的频道里")
			return
		}
		if root.ThreadID != nil {
			th = *root.ThreadID
		}
		ms = scanMessages(h.db.Query("SELECT "+messageCols+" FROM messages m WHERE m.id = ? OR m.thread_id = ? ORDER BY m.seq LIMIT ?", th, th, limit))
	} else {
		c, ok := h.agentChannel(w, t, a, q.query("channel"))
		if !ok {
			return
		}
		before := clampInt(q.query("before"), 1<<62, 1, 1<<62)
		ms = scanMessages(h.db.Query("SELECT "+messageCols+` FROM messages m WHERE m.channel_id = ? AND m.thread_id IS NULL AND m.seq < ?
			ORDER BY m.seq DESC LIMIT ?`, c.ID, before, limit))
		for i, j := 0, len(ms)-1; i < j; i, j = i+1, j-1 {
			ms[i], ms[j] = ms[j], ms[i]
		}
		if len(ms) == limit {
			defer fmt.Fprintf(w, "(older: remi read --channel %q --before %d)\n", c.Name, ms[0].Seq)
		}
	}
	if len(ms) == 0 {
		writeText(w, "(no messages)\n")
		return
	}
	writeText(w, h.lines(ms, map[string]string{}))
}

// v1AgentSearch: `teamagent search WORDS [--channel X]`: messages with all the words, newest first.
func (h *Hub) v1AgentSearch(w http.ResponseWriter, q *request) {
	t, a, ok := h.reader(w, q)
	if !ok {
		return
	}
	words := strings.Fields(q.query("q"))
	if len(words) == 0 {
		errJSON(w, 400, "要搜什么？")
		return
	}
	chans := h.agentChannels(a.ID)
	if c := q.query("channel"); c != "" {
		ch, ok := h.agentChannel(w, t, a, c)
		if !ok {
			return
		}
		chans = []string{ch.ID}
	}
	if len(chans) == 0 {
		writeText(w, "(no channels)\n")
		return
	}
	where, args := []string{"m.channel_id IN (?" + strings.Repeat(", ?", len(chans)-1) + ")"}, []any{}
	for _, c := range chans {
		args = append(args, c)
	}
	for _, wd := range words[:min(len(words), 8)] {
		where = append(where, "m.text LIKE ? ESCAPE '\\'")
		args = append(args, "%"+strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(wd)+"%")
	}
	limit := clampInt(q.query("limit"), 20, 1, 100)
	ms := scanMessages(h.db.Query("SELECT "+messageCols+" FROM messages m WHERE "+strings.Join(where, " AND ")+" ORDER BY m.seq DESC LIMIT ?", append(args, limit)...))
	if len(ms) == 0 {
		writeText(w, "(nothing found)\n")
		return
	}
	writeText(w, h.lines(ms, map[string]string{}))
}

// v1AgentTasks: `teamagent tasks [--status S] [--channel X]`: the tracked tasks in the agent's channels, newest first.
func (h *Hub) v1AgentTasks(w http.ResponseWriter, q *request) {
	t, a, ok := h.reader(w, q)
	if !ok {
		return
	}
	chans := h.agentChannels(a.ID)
	if c := q.query("channel"); c != "" {
		ch, ok := h.agentChannel(w, t, a, c)
		if !ok {
			return
		}
		chans = []string{ch.ID}
	}
	if len(chans) == 0 {
		writeText(w, "(no channels)\n")
		return
	}
	where, args := []string{"tracked = 1", "channel_id IN (?" + strings.Repeat(", ?", len(chans)-1) + ")"}, []any{}
	for _, c := range chans {
		args = append(args, c)
	}
	if s := q.query("status"); s != "" {
		states := statesOf(s)
		if len(states) == 0 {
			errJSON(w, 400, "status 只能是 todo、in_progress、in_review、done 或 closed")
			return
		}
		where = append(where, "state IN (?"+strings.Repeat(", ?", len(states)-1)+")")
		for _, st := range states {
			args = append(args, st)
		}
	}
	limit := clampInt(q.query("limit"), 50, 1, 200)
	ts := scanTasks(h.db.Query("SELECT "+taskCols+" FROM tasks_v1 WHERE "+strings.Join(where, " AND ")+" ORDER BY updated DESC LIMIT ?", append(args, limit)...))
	if len(ts) == 0 {
		writeText(w, "(no tasks)\n")
		return
	}
	var b strings.Builder
	for _, x := range ts {
		b.WriteString(h.taskLine(x) + "\n")
	}
	writeText(w, b.String())
}

func (h *Hub) taskLine(x taskView) string {
	c, _ := h.channel(x.ChannelID)
	ag, _ := h.agent(x.AgentID)
	needs := ""
	if x.Needs != "" {
		needs = " needs=" + x.Needs
	}
	return fmt.Sprintf("%s [%s%s] %s — @%s in #%s, thread=%s, updated %s", x.ID, x.Status, needs, x.Title, ag.Handle, c.Name, x.ThreadID,
		time.UnixMilli(x.Updated).Format("2006-01-02 15:04"))
}

// v1AgentTask: `teamagent task T-0001`: one task in the agent's channels, with its acceptance criteria, summary and PR.
func (h *Hub) v1AgentTask(w http.ResponseWriter, q *request) {
	_, a, ok := h.reader(w, q)
	if !ok {
		return
	}
	x, ok := h.task(q.r.PathValue("id"))
	if !ok || !h.isMember(x.ChannelID, "agent", a.ID) {
		errJSON(w, 404, "没有这个任务，或者 @"+a.Handle+" 不在它的频道里")
		return
	}
	var b strings.Builder
	b.WriteString(h.taskLine(x) + "\n")
	if x.Acceptance != "" {
		b.WriteString("Acceptance:\n  " + strings.ReplaceAll(x.Acceptance, "\n", "\n  ") + "\n")
	}
	if x.Summary != "" {
		b.WriteString("Summary:\n  " + strings.ReplaceAll(clip(x.Summary, 4000), "\n", "\n  ") + "\n")
	}
	if x.PR != nil {
		fmt.Fprintf(&b, "PR: %s (%s, checks %s)\n", x.PR.URL, x.PR.State, x.PR.Checks)
	}
	fmt.Fprintf(&b, "Thread: remi read --thread %s\n", x.ThreadID)
	writeText(w, b.String())
}
