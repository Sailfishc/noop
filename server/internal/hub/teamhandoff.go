package hub

import (
	"fmt"
	"net/http"
	"strings"
)

// Who has the ball, and passing it on (the collaboration plan, stage 3).
//
// Every open task has one holder: the one whose move it is. It folds together what used to be separate marks (needs
// you, the handler, what it waits on): the agent's owner while it waits for a yes, the person it asked or handed the
// ball to, the person who decides or accepts, or the agent itself while it works or waits for an outside result.
//
// An agent passes the ball with `remi handoff @x WHAT`:
//   - to a person: the ball is theirs (on their 待你处理) until they reply in the thread; the reply reaches the agent;
//   - to another agent: as if the person who asked in the first place @-ed it (teamreach.go). Where they may use it
//     without its owner's yes, it gets a task in the same thread at once, in their name ("@who via @A"); else a card
//     in the thread that only its owner clicks, and only then. A chain is at most maxHops agents long and never comes
//     back to an agent already in it (structural); an agent's reminder can't @ another agent (that would be a
//     handoff past the rule).
//
// `remi submit WHAT` counts the agent's submissions to outside services on the server: at most maxSubmits per task.

const (
	maxHops    = 3
	maxSubmits = 3
)

// holderView: who has the ball and why: confirm | handoff_card | answer | handoff | align | decide | accept | unblock | retry
// (a person), work | wait | receipt (an agent: receipt, a delegated task that failed is back with the agent that
// delegated it).
type holderView struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
	Why  string `json:"why"`
}

// handoffView: the agent proposed to hand the work on to another agent.
type handoffView struct {
	ID        string `json:"id"`
	To        string `json:"to"` // the agent
	What      string `json:"what"`
	Message   string `json:"message"` // the agent's message in the thread (the card)
	At        int64  `json:"at"`
	State     string `json:"state"` // proposed | accepted | declined
	Task      string `json:"task,omitempty"`
	DecidedBy string `json:"decided_by,omitempty"`
	// Auto: no card: the requester may use the other agent without its owner's yes (teamreach.go), so it went at once
	Auto bool `json:"auto,omitempty"`
	// Kind: "" a handoff (the work is the other agent's now) | delegate (a part of it, back to this task: teamdelegate.go)
	Kind string `json:"kind,omitempty"`
}

type submitView struct {
	What string `json:"what"`
	At   int64  `json:"at"`
}

func (h *Hub) holderOf(t taskView) *holderView {
	user := func(id, why string) *holderView { return &holderView{"user", id, why} }
	switch t.State {
	case taskDone, taskClosed:
		return nil
	case taskPending:
		a, _ := h.agent(t.AgentID)
		return user(a.OwnerID, "confirm")
	}
	if t.Move != nil && t.Move.State == "proposed" { // its computer is gone: the agent's owner says where it goes on
		a, _ := h.agent(t.AgentID)
		return user(a.OwnerID, "move")
	}
	if t.Engine != nil && t.Engine.State == "proposed" { // its runtime is held back: the agent's owner says whether another goes on
		a, _ := h.agent(t.AgentID)
		return user(a.OwnerID, "engine")
	}
	for _, x := range t.Handoffs {
		if x.State == "proposed" {
			if b, ok := h.agent(x.To); ok {
				return user(b.OwnerID, "handoff_card") // only the other agent's owner says yes
			}
		}
	}
	for _, q := range t.Asked {
		if q.Answered == 0 {
			if q.Kind == "handoff" {
				return user(q.User, "handoff")
			}
			return user(q.User, "answer")
		}
	}
	switch t.State {
	case taskNeedsDecision:
		if t.Decision != nil && t.Decision.Kind == "align" {
			return user(takerOf(t), "align")
		}
		return user(takerOf(t), "decide")
	case taskReview:
		return user(takerOf(t), "accept")
	case taskBlocked:
		return user(t.CreatedBy, "unblock")
	case taskFailed:
		if t.Mandate != nil && t.Mandate.Delegated && len(t.Mandate.Via) > 0 {
			var ps string
			h.db.QueryRow("SELECT state FROM tasks_v1 WHERE id = ?", t.Mandate.Parent).Scan(&ps)
			if ps == taskDone || ps == taskClosed {
				return nil // the task that delegated it is over: nobody owes it anything
			}
			return &holderView{"agent", t.Mandate.Via[len(t.Mandate.Via)-1], "receipt"} // back to the agent that delegated it
		}
		return user(t.CreatedBy, "retry")
	case taskWaiting:
		return &holderView{"agent", t.AgentID, "wait"}
	}
	return &holderView{"agent", t.AgentID, "work"}
}

// chain: the agents a task came through, and the task's own agent at the end.
func chain(t taskView) []string {
	var via []string
	if t.Mandate != nil {
		via = append(via, t.Mandate.Via...)
	}
	return append(via, t.AgentID)
}

// v1AgentHandoff: `remi handoff @x WHAT`.
func (h *Hub) v1AgentHandoff(w http.ResponseWriter, q *request) {
	t, a, ok := h.reader(w, q)
	if !ok {
		return
	}
	text := strings.TrimSpace(textBody(q))
	ms := h.mentions(text)
	if len(ms) == 0 || !strings.HasPrefix(text, "@"+ms[0].Handle) {
		errJSON(w, 400, "用法：remi handoff @某人或某个Agent 交给他的事")
		return
	}
	target := ms[0]
	what := trimmed(strings.TrimSpace(strings.TrimPrefix(text, "@"+target.Handle)), 2000)
	if what == "" {
		errJSON(w, 400, "说一下交给 @"+target.Handle+" 什么事")
		return
	}
	if target.Kind == "user" {
		if !h.memberOrAdmin(t.ChannelID, target.ID) {
			errJSON(w, 400, "@"+target.Handle+" 不在这个频道里")
			return
		}
		m := h.insertMessage(t.ChannelID, &t.ThreadID, member{"agent", a.ID}, "@"+target.Handle+" 交给你："+what)
		asked := append(t.Asked, askedView{User: target.ID, Question: trimmed(what, 300), Message: m.ID, At: h.nowMs(), Kind: "handoff"})
		h.setTask(t.ID, map[string]any{"asked": jsonOrNil(asked), "tracked": 1})
		h.noteCall(t, "handoff", target.ID)
		h.taskChanged(t.ID)
		writeText(w, "handed to @"+target.Handle+": msg="+m.ID+"\nThe ball is theirs now (it is on their list). Their reply in the thread reaches you.\n"+
			"If your part is done, end your turn (status review, and say what you handed over); if you need their result to go on, end with status waiting and wait {\"how\": \"answer\", \"what\": \"@"+target.Handle+"\"}.\n")
		return
	}
	b, _ := h.agent(target.ID)
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
	if h.count("SELECT COUNT(*) FROM tasks_v1 WHERE thread_id = ? AND agent_id = ? AND state NOT IN ('done', 'closed')", t.ThreadID, b.ID) > 0 {
		errJSON(w, 409, "@"+b.Handle+" 在这个线程里已经有任务了，不能再交给它")
		return
	}
	if !r.Card { // the requester could @ it without anyone's yes: so can the agent working for them; no card
		x := handoffView{ID: newID("ho_"), To: b.ID, What: what, At: h.nowMs(), State: "accepted", Auto: true}
		m, id := h.handOn(t, b, r, x.What, "（@"+a.Handle+" 在 "+t.ID+" 里转交，免确认）", member{"agent", a.ID}, taskOrigin{})
		x.Message, x.Task = m, id
		h.setTask(t.ID, map[string]any{"handoffs": jsonOrNil(append(t.Handoffs, x)), "tracked": 1})
		h.taskChanged(t.ID)
		writeText(w, "handed to @"+b.Handle+": it has "+id+" in this thread and starts now (no card: the requester may use it directly).\n"+
			"Finish your own part; when it is done, end your turn with status review and say what you handed over.\n")
		return
	}
	m := h.insertMessage(t.ChannelID, &t.ThreadID, member{"agent", a.ID}, "建议交给 @"+b.Handle+"："+what)
	x := handoffView{ID: newID("ho_"), To: b.ID, What: what, Message: m.ID, At: h.nowMs(), State: "proposed"}
	h.setTask(t.ID, map[string]any{"handoffs": jsonOrNil(append(t.Handoffs, x)), "tracked": 1})
	h.noteCall(t, "handoff_card", b.OwnerID)
	h.taskChanged(t.ID)
	writeText(w, "proposed: @"+b.Handle+"'s owner clicks the card in the thread to hand it over (id "+x.ID+").\n"+
		"Finish your own part; when it is done, end your turn with status review and say what you handed over.\n")
}

// handOn: agent b gets a task in t's thread, in the name of t's requester and via t's chain: the request said as
// `author` in the thread ("@B WHAT" and a note on where it came from), b brought into the channel when reach says so.
// o: Confirmed (b's owner already said yes), Delegated and Acceptance (a delegated part). The message and the new task.
func (h *Hub) handOn(t taskView, b agentView, r reachView, what, note string, author member, o taskOrigin) (string, string) {
	if r.Join {
		h.addMember(t.ChannelID, member{"agent", b.ID})
		h.channelChanged(t.ChannelID)
	}
	m := h.insertMessage(t.ChannelID, &t.ThreadID, author, "@"+b.Handle+" "+what+"\n"+note)
	o.By, o.Via, o.Parent = t.CreatedBy, chain(t), t.ID
	id := h.createTaskWith(m, t.ThreadID, b.ID, r.Join, true, o)
	return m.ID, id
}

// v1TaskHandoff: a person decides a handoff card: {id, accept}. Accepted, the other agent gets a task in the thread,
// in the name of the person who asked first.
func (h *Hub) v1TaskHandoff(w http.ResponseWriter, q *request) {
	t, ok := h.task(q.r.PathValue("id"))
	if !ok {
		errJSON(w, 404, "not found")
		return
	}
	var b struct {
		ID     string `json:"id"`
		Accept bool   `json:"accept"`
	}
	_ = q.json(&b)
	i := -1
	for j, x := range t.Handoffs {
		if x.ID == b.ID {
			i = j
		}
	}
	if i < 0 {
		errJSON(w, 404, "没有这个交接")
		return
	}
	x := t.Handoffs[i]
	to, okTo := h.agent(x.To)
	me := q.who.userID
	from, _ := h.agent(t.AgentID)
	reads := h.userCanRead(me, t.ChannelID)
	if !reads && me != t.CreatedBy && me != t.Handler && me != from.OwnerID && me != to.OwnerID {
		errJSON(w, 404, "not found")
		return
	}
	if me != t.CreatedBy && me != t.Handler && me != from.OwnerID && me != to.OwnerID && !(h.isAdmin(me) && reads) {
		errJSON(w, 403, "只有发起人、处理人或两个 Agent 的主人能决定交接")
		return
	}
	if x.State != "proposed" {
		errJSON(w, 409, "这个交接已经处理过了")
		return
	}
	if !okTo {
		errJSON(w, 404, "那个 Agent 已经不在了")
		return
	}
	x.DecidedBy = me
	if !b.Accept {
		x.State = "declined"
		t.Handoffs[i] = x
		h.setTask(t.ID, map[string]any{"handoffs": jsonOrNil(t.Handoffs)})
		h.insertMessage(t.ChannelID, &t.ThreadID, member{"user", me}, "不用交给 @"+to.Handle)
		h.taskChanged(t.ID)
		h.checkReceipt(t.ID) // a declined delegation is one thing less it waits for
		t, _ = h.task(t.ID)
		writeJSON(w, 200, h.taskOut(q, t))
		return
	}
	if me != to.OwnerID { // a card is there because @B's owner says yes first: only they hand it over
		errJSON(w, 403, "只有 @"+to.Handle+" 的主人能把这件事交给它")
		return
	}
	if h.count("SELECT COUNT(*) FROM tasks_v1 WHERE thread_id = ? AND agent_id = ? AND state NOT IN ('done', 'closed')", t.ThreadID, to.ID) > 0 {
		errJSON(w, 409, "@"+to.Handle+" 在这个线程里已经有任务了：直接在线程里跟它说")
		return
	}
	r := h.reach(t, to)
	if r.Refuse != "" {
		errJSON(w, 403, r.Refuse)
		return
	}
	// the request, as the person clicking says it, in the thread: "@B WHAT"
	o, note := taskOrigin{Confirmed: true}, "（"+from.Name+" 在 "+t.ID+" 里建议的交接）"
	if x.Kind == "delegate" {
		o.Delegated, o.Acceptance, note = true, x.What, "（"+from.Name+" 在 "+t.ID+" 里委派，结果交回给它）"
	}
	_, id := h.handOn(t, to, r, x.What, note, member{"user", me}, o)
	x.State, x.Task = "accepted", id
	t.Handoffs[i] = x
	h.setTask(t.ID, map[string]any{"handoffs": jsonOrNil(t.Handoffs)})
	h.taskChanged(t.ID)
	t, _ = h.task(t.ID)
	writeJSON(w, 200, h.taskOut(q, t))
}

// v1AgentSubmit: `remi submit WHAT` before each submission to an outside service (a deployment, a render, a form):
// counted here, at most maxSubmits per task; failures and timeouts count too.
func (h *Hub) v1AgentSubmit(w http.ResponseWriter, q *request) {
	t, _, ok := h.reader(w, q)
	if !ok {
		return
	}
	what := trimmed(strings.TrimSpace(textBody(q)), 300)
	if what == "" {
		errJSON(w, 400, "用法：remi submit 提交了什么（比如：渲染任务 job-123）")
		return
	}
	if len(t.Submits) >= maxSubmits {
		errJSON(w, 429, fmt.Sprintf("这个任务已经向外部提交了 %d 次（失败、超时都算），不能再提交：停下来，用 needs_decision 问发起人要不要再试", len(t.Submits)))
		return
	}
	h.setTask(t.ID, map[string]any{"submits": jsonOrNil(append(t.Submits, submitView{What: what, At: h.nowMs()}))})
	h.taskChanged(t.ID)
	writeText(w, fmt.Sprintf("ok: submission %d of %d\n", len(t.Submits)+1, maxSubmits))
}
