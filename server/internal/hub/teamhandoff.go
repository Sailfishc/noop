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
//   - to another agent: a card in the thread that a person clicks (the requester, the person who takes the task, or
//     the other agent's owner). Only then does the other agent get a task, in the same thread, in the name of the
//     person who asked in the first place ("@who via @A"). A chain is at most maxHops agents long and never comes
//     back to an agent already in it; an agent's reminder can't @ another agent (that would be a handoff without the
//     card).
//
// `remi submit WHAT` counts the agent's submissions to outside services on the server: at most maxSubmits per task.

const (
	maxHops    = 3
	maxSubmits = 3
)

// holderView: who has the ball and why: confirm | handoff_card | answer | handoff | align | decide | accept | unblock | retry
// (a person), work | wait (the agent).
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
	for _, x := range t.Handoffs {
		if x.State == "proposed" {
			return user(takerOf(t), "handoff_card")
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
	if target.ID == a.ID {
		errJSON(w, 400, "不能交给自己")
		return
	}
	c := chain(t)
	for _, id := range c {
		if id == target.ID {
			errJSON(w, 400, "@"+target.Handle+" 已经在这条交接链里了，不能交回去；需要的话请人来决定")
			return
		}
	}
	if len(c) >= maxHops {
		errJSON(w, 429, fmt.Sprintf("这条交接链已经有 %d 个 Agent 了（最多 %d 个）：停下来，用 needs_decision 请人决定", len(c), maxHops))
		return
	}
	for _, x := range t.Handoffs {
		if x.To == target.ID && x.State == "proposed" {
			writeText(w, "already proposed to @"+target.Handle+"\n")
			return
		}
	}
	m := h.insertMessage(t.ChannelID, &t.ThreadID, member{"agent", a.ID}, "建议交给 @"+target.Handle+"："+what)
	x := handoffView{ID: newID("ho_"), To: target.ID, What: what, Message: m.ID, At: h.nowMs(), State: "proposed"}
	h.setTask(t.ID, map[string]any{"handoffs": jsonOrNil(append(t.Handoffs, x)), "tracked": 1})
	h.noteCall(t, "handoff_card", "")
	h.taskChanged(t.ID)
	writeText(w, "proposed: a person clicks the card in the thread to hand it to @"+target.Handle+" (id "+x.ID+").\n"+
		"Finish your own part; when it is done, end your turn with status review and say what you handed over.\n")
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
		t, _ = h.task(t.ID)
		writeJSON(w, 200, h.taskOut(q, t))
		return
	}
	if h.count("SELECT COUNT(*) FROM tasks_v1 WHERE thread_id = ? AND agent_id = ? AND state NOT IN ('done', 'closed')", t.ThreadID, to.ID) > 0 {
		errJSON(w, 409, "@"+to.Handle+" 在这个线程里已经有任务了：直接在线程里跟它说")
		return
	}
	joined := false
	if !h.isMember(t.ChannelID, "agent", to.ID) {
		if to.Dispatch != "team" {
			errJSON(w, 403, "@"+to.Handle+" 不在这个频道，也不接整个团队的活：请它的主人先把它加进来")
			return
		}
		h.addMember(t.ChannelID, member{"agent", to.ID})
		h.channelChanged(t.ChannelID)
		joined = true
	}
	// the request, as the person clicking says it, in the thread: "@B WHAT"
	m := h.insertMessage(t.ChannelID, &t.ThreadID, member{"user", me}, "@"+to.Handle+" "+x.What+"\n（"+from.Name+" 在 "+t.ID+" 里建议的交接）")
	id := h.createTaskWith(m, t.ThreadID, to.ID, joined, true, taskOrigin{By: t.CreatedBy, Via: chain(t), Parent: t.ID,
		Confirmed: me == to.OwnerID})
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
