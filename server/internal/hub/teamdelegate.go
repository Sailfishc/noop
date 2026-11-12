package hub

import (
	"fmt"
	"net/http"
	"strings"
)

// Delegating (design step 4 「Agent 之间协作」, 设计二). `remi delegate @B WHAT`: the task stays agent A's, and B does a
// part of it as a child task in the same thread (mandate.delegated), whose criteria are what A asked. A ends its run
// waiting for "delegates"; a child that comes back (done, failed or cancelled) goes to A, not to a person's
// acceptance, and the last one back wakes A once, in the same session, with a receipt: each child's state, summary,
// outputs, evidence and PR. A checks and either delivers its own task (the only thing a person accepts) or sends a
// child back with `remi delegate @B WHAT TO CHANGE` (maxRedos times). A child that needs a person to align or decide
// still asks the requester, like any task. Whether A may use B, and the cards, are a handoff's (teamreach.go); the
// fuses below are counted here, on the server.

const (
	maxDelegates = 5 // agents one task delegates to
	maxChildren  = 8 // delegated tasks under one first task, at any depth
	maxRedos     = 2 // times one delegated task is sent back
)

// returnedStates: a delegated task in one of these is back with the agent that delegated it.
var returnedStates = map[string]bool{taskDone: true, taskFailed: true, taskClosed: true}

// delegateView: one task the agent delegated, as its parent shows it.
type delegateView struct {
	Task   string `json:"task"`
	Agent  string `json:"agent"`
	State  string `json:"state"`
	Status string `json:"status"`
	Redos  int    `json:"redos,omitempty"`
}

// children: the tasks t's agent delegated, oldest first.
func (h *Hub) children(id string) []taskView {
	return scanTasks(h.db.Query("SELECT "+taskCols+` FROM tasks_v1 WHERE json_extract(mandate, '$.parent') = ?
		AND COALESCE(json_extract(mandate, '$.delegated'), 0) = 1 ORDER BY num`, id))
}

func (h *Hub) delegatesOf(id string) []delegateView {
	out := []delegateView{}
	for _, c := range h.children(id) {
		out = append(out, delegateView{Task: c.ID, Agent: c.AgentID, State: c.State, Status: c.Status, Redos: c.Mandate.Redos})
	}
	return out
}

// rootOf: the first task of t's chain (handoffs and delegations).
func (h *Hub) rootOf(t taskView) taskView {
	for i := 0; i < 20 && t.Mandate != nil && t.Mandate.Parent != ""; i++ {
		p, ok := h.task(t.Mandate.Parent)
		if !ok {
			break
		}
		t = p
	}
	return t
}

// descendants: the delegated tasks under this one, at any depth.
func (h *Hub) descendants(id string) int {
	n := 0
	for _, c := range h.children(id) {
		n += 1 + h.descendants(c.ID)
	}
	return n
}

// proposedDelegations: delegation cards on t still to click.
func proposedDelegations(t taskView) int {
	n := 0
	for _, x := range t.Handoffs {
		if x.Kind == "delegate" && x.State == "proposed" {
			n++
		}
	}
	return n
}

// v1AgentDelegate: `remi delegate @B WHAT`.
func (h *Hub) v1AgentDelegate(w http.ResponseWriter, q *request) {
	t, a, ok := h.reader(w, q)
	if !ok {
		return
	}
	if t.Readonly {
		errJSON(w, 403, readonlyRefusal)
		return
	}
	text := strings.TrimSpace(textBody(q))
	ms := h.mentions(text)
	if len(ms) == 0 || !strings.HasPrefix(text, "@"+ms[0].Handle) {
		errJSON(w, 400, "用法：remi delegate @某个Agent 要它做的事")
		return
	}
	if ms[0].Kind != "agent" {
		errJSON(w, 400, "只能委派给 Agent；要一个人做事用 remi handoff @人，问一个人用 remi ask @人")
		return
	}
	what := trimmed(strings.TrimSpace(strings.TrimPrefix(text, "@"+ms[0].Handle)), 2000)
	if what == "" {
		errJSON(w, 400, "说一下要 @"+ms[0].Handle+" 做什么，写成能检查的结果")
		return
	}
	b, _ := h.agent(ms[0].ID)
	for _, c := range h.children(t.ID) {
		if c.AgentID == b.ID {
			h.redo(w, t, a, b, c, what)
			return
		}
	}
	if why := structural(t, b); why != "" {
		code := 400
		if strings.Contains(why, "最多") {
			code = 429
		}
		errJSON(w, code, why)
		return
	}
	r := h.reach(t, b)
	if r.Refuse != "" {
		errJSON(w, 403, r.Refuse)
		return
	}
	for _, x := range t.Handoffs {
		if x.To == b.ID && x.State == "proposed" {
			writeText(w, "already proposed to @"+b.Handle+"\n")
			return
		}
	}
	direct := map[string]bool{}
	for _, c := range h.children(t.ID) {
		direct[c.AgentID] = true
	}
	if len(direct)+proposedDelegations(t) >= maxDelegates {
		errJSON(w, 429, fmt.Sprintf("这个任务已经委派给 %d 个 Agent 了（最多 %d 个）：自己做剩下的，或者用 needs_decision 请人决定", len(direct)+proposedDelegations(t), maxDelegates))
		return
	}
	root := h.rootOf(t)
	if n := h.descendants(root.ID) + proposedDelegations(t); n >= maxChildren {
		errJSON(w, 429, fmt.Sprintf("%s 下面已经有 %d 个委派的子任务了（最多 %d 个）：自己做剩下的，或者用 needs_decision 请人决定", root.ID, n, maxChildren))
		return
	}
	if h.count("SELECT COUNT(*) FROM tasks_v1 WHERE thread_id = ? AND agent_id = ? AND state NOT IN ('done', 'closed')", t.ThreadID, b.ID) > 0 {
		errJSON(w, 409, "@"+b.Handle+" 在这个线程里已经有任务了，不能再委派给它")
		return
	}
	if !r.Card {
		x := handoffView{ID: newID("ho_"), To: b.ID, What: what, At: h.nowMs(), State: "accepted", Auto: true, Kind: "delegate"}
		m, id := h.handOn(t, b, r, what, "（@"+a.Handle+" 在 "+t.ID+" 里委派，结果交回给它）", member{"agent", a.ID},
			taskOrigin{Delegated: true, Acceptance: what})
		x.Message, x.Task = m, id
		h.setTask(t.ID, map[string]any{"handoffs": jsonOrNil(append(t.Handoffs, x)), "tracked": 1})
		h.taskChanged(t.ID)
		writeText(w, "delegated to @"+b.Handle+": "+id+" in this thread, starting now; its result comes back to you, not to a person.\n"+
			"Delegate the other parts the same way, do what you can yourself meanwhile, then end your turn with status waiting and\n"+
			"wait {\"how\": \"delegates\"}: when every delegated task is back you are woken once, in this session, with the receipt.\n")
		return
	}
	m := h.insertMessage(t.ChannelID, &t.ThreadID, member{"agent", a.ID}, "建议委派给 @"+b.Handle+"："+what)
	x := handoffView{ID: newID("ho_"), To: b.ID, What: what, Message: m.ID, At: h.nowMs(), State: "proposed", Kind: "delegate"}
	h.setTask(t.ID, map[string]any{"handoffs": jsonOrNil(append(t.Handoffs, x)), "tracked": 1})
	h.noteCall(t, "handoff_card", b.OwnerID)
	h.taskChanged(t.ID)
	writeText(w, "proposed: @"+b.Handle+"'s owner clicks the card in the thread first (id "+x.ID+"); then its result comes back to you.\n"+
		"End your turn with status waiting and wait {\"how\": \"delegates\"} when you have nothing else to do: you are woken once\n"+
		"everything you delegated is back (a declined card counts as back, with nothing).\n")
}

// redo: A sends a delegated task back with what to change: it runs again in its own session, at most maxRedos times.
func (h *Hub) redo(w http.ResponseWriter, t taskView, a, b agentView, c taskView, what string) {
	if c.State == taskClosed {
		errJSON(w, 409, c.ID+" 被取消了（人取消的，或上级任务取消了），不能打回重做：自己做，或者用 needs_decision 请人决定")
		return
	}
	if !returnedStates[c.State] {
		errJSON(w, 409, "@"+b.Handle+" 还在做 "+c.ID+"：等它交回（回执会叫醒你），再决定要不要打回")
		return
	}
	if c.Mandate.Redos >= maxRedos {
		errJSON(w, 429, fmt.Sprintf("%s 已经打回重做 %d 次了（最多 %d 次）：不要再打回，带着现状用 needs_decision 请人决定", c.ID, c.Mandate.Redos, maxRedos))
		return
	}
	m := h.insertMessage(t.ChannelID, &t.ThreadID, member{"agent", a.ID}, "@"+b.Handle+" 重做 "+c.ID+"："+what)
	md := *c.Mandate
	md.Redos++
	h.setTask(c.ID, map[string]any{"state": taskQueued, "step": "", "mandate": jsonOrNil(md)})
	h.taskChanged(c.ID)
	writeText(w, fmt.Sprintf("sent back: %s runs again with what you said (msg=%s; redo %d of %d).\n"+
		"End your turn with status waiting and wait {\"how\": \"delegates\"}: you are woken when it is back.\n", c.ID, m.ID, md.Redos, maxRedos))
}

// childReturned: a task came to an end; when it was delegated, its parent may have everything back now.
func (h *Hub) childReturned(id string) {
	var parent string
	if h.db.QueryRow(`SELECT COALESCE(json_extract(mandate, '$.parent'), '') FROM tasks_v1 WHERE id = ?
		AND COALESCE(json_extract(mandate, '$.delegated'), 0) = 1`, id).Scan(&parent) != nil || parent == "" {
		return
	}
	h.checkReceipt(parent)
}

// checkReceipt: when the task waits for what it delegated and all of it is back (no card still to click either),
// it is woken once with the receipt, and the thread says so in a line.
func (h *Hub) checkReceipt(id string) {
	p, ok := h.task(id)
	if !ok || p.State != taskWaiting || p.Wait == nil || p.Wait.How != "delegates" || proposedDelegations(p) > 0 {
		return
	}
	cs := h.children(id)
	for _, c := range cs {
		if !returnedStates[c.State] {
			return
		}
	}
	a, _ := h.agent(p.AgentID)
	var line []string
	for _, c := range cs {
		line = append(line, "@"+h.agentHandle(c.AgentID)+" "+map[string]string{taskDone: "做完了", taskFailed: "失败了", taskClosed: "取消了"}[c.State])
	}
	if len(cs) > 0 {
		h.insertMessage(p.ChannelID, &p.ThreadID, member{"agent", a.ID}, fmt.Sprintf("委派的 %d 个都交回了：%s", len(cs), strings.Join(line, "，")))
	}
	h.wakeTask(id, p.Wait, "delegates", "", h.receipt(cs))
}

func (h *Hub) agentHandle(id string) string {
	if a, ok := h.agent(id); ok {
		return a.Handle
	}
	return "?"
}

// receipt: what came back from each delegated task, for the agent that delegated them.
func (h *Hub) receipt(cs []taskView) string {
	if len(cs) == 0 {
		return "Nothing came back: you delegated nothing that was taken up (a card may have been declined).\n"
	}
	var b strings.Builder
	for _, c := range cs {
		c, _ = h.task(c.ID) // with its outputs
		state := map[string]string{taskDone: "delivered", taskFailed: "failed", taskClosed: "cancelled"}[c.State]
		fmt.Fprintf(&b, "## %s @%s: %s", c.ID, h.agentHandle(c.AgentID), state)
		if c.Mandate.Redos > 0 {
			fmt.Fprintf(&b, " (sent back %d times)", c.Mandate.Redos)
		}
		fmt.Fprintf(&b, "\nYou asked: %s\nSummary: %s\n", clip(c.Acceptance, 1000), clip(strings.TrimSpace(c.Summary), 3000))
		if c.State == taskFailed && c.LastFailure != "" {
			fmt.Fprintf(&b, "Failure: %s\n", c.LastFailure)
		}
		for _, e := range c.Evidence {
			fmt.Fprintf(&b, "Evidence %d (%s): %s\n", e.Criterion, e.How, clip(e.Proof, 500))
		}
		if c.PR != nil {
			fmt.Fprintf(&b, "PR: %s (%s, checks %s), branch %s\n", c.PR.URL, c.PR.State, c.PR.Checks, c.Branch)
		} else if c.Repo != "" {
			fmt.Fprintf(&b, "Branch: %s in %s\n", c.Branch, c.Repo)
		}
		for _, o := range c.Outputs {
			if o.Kind == "pr" {
				continue
			}
			fmt.Fprintf(&b, "Output: %s %s\n", o.Title, o.URL)
		}
		b.WriteString("\n")
	}
	return b.String()
}

// cancelDelegates: the task was cancelled: what it delegated and is not back yet is cancelled too (and theirs).
func (h *Hub) cancelDelegates(id string) {
	for _, c := range h.children(id) {
		if returnedStates[c.State] {
			continue
		}
		h.setTask(c.ID, map[string]any{"state": taskClosed, "step": "", "summary": strings.TrimSpace(c.Summary + "\n上级任务取消了"), "cancelled_at": h.nowMs()})
		h.endThreadReminders(c)
		h.taskChanged(c.ID)
		h.cancelDelegates(c.ID)
	}
}

// delegated: t's agent delegated something (a child task, or a card for one), so what it delivers is the whole and a
// person accepts it, even when its own run changed nothing.
func (h *Hub) delegated(t taskView) bool {
	for _, x := range t.Handoffs {
		if x.Kind == "delegate" {
			return true
		}
	}
	return len(h.children(t.ID)) > 0
}

// delegatesDropped: t delivered (review or done) before everything it delegated was back. What still runs is
// cancelled (and theirs), cards not clicked yet are withdrawn, and the thread says so in a line: nobody would take
// those results any more.
func (h *Hub) delegatesDropped(id string) {
	t, ok := h.task(id)
	if !ok {
		return
	}
	var gone []string
	hs, changed := append([]handoffView{}, t.Handoffs...), false
	for i, x := range hs {
		if x.Kind == "delegate" && x.State == "proposed" {
			hs[i].State, changed = "declined", true
			gone = append(gone, "给 @"+h.agentHandle(x.To)+" 的委派卡片")
		}
	}
	if changed {
		h.setTask(id, map[string]any{"handoffs": jsonOrNil(hs)})
	}
	for _, c := range h.children(id) {
		if !returnedStates[c.State] {
			gone = append(gone, c.ID+" @"+h.agentHandle(c.AgentID))
		}
	}
	h.cancelDelegates(id)
	if len(gone) > 0 {
		h.insertMessage(t.ChannelID, &t.ThreadID, member{"agent", t.AgentID}, "已经交付，没交回的委派不再需要，取消了："+strings.Join(gone, "，"))
		h.taskChanged(id)
	}
}
