package hub

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// Asking another agent (design step 4 「Agent 之间协作」, 设计四). `remi ask @B QUESTION` from agent A's run: B answers
// in one read-only run on one of its computers, and A goes on meanwhile. It is not a task: nothing on the task page or
// in anyone's inbox, nothing to accept; the thread keeps the question and the answer, and the answer reaches A the way
// a person's answer does (news for a running task, a wake for a waiting one). It is only allowed where the requester
// may use B without its owner's yes (reach): a question is not worth a card, A asks a person instead. B's run gets no
// `remi` token, so it can neither ask, delegate nor hand anything on; the run is read-only where the runtime has a
// mode for it, and whatever it changed anyway is thrown away (src/teamwork.ts runAsk). A question no computer of B's
// starts within askQueue is given up, and A hears 「没问到」.

const (
	maxAsks   = 3                // questions to other agents per task
	askQueue  = 10 * time.Minute // a question not started by then is given up
	askLonger = 30 * time.Minute // a run that has not answered by then is given up (its computer went away)
)

const asksSchema = `
CREATE TABLE IF NOT EXISTS agent_asks (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL, from_agent TEXT NOT NULL,
  channel_id TEXT NOT NULL, thread_id TEXT NOT NULL, question TEXT NOT NULL, message TEXT NOT NULL, state TEXT NOT NULL,
  machine_id TEXT, answer_msg TEXT, created INTEGER NOT NULL, started INTEGER, ended INTEGER);
CREATE INDEX IF NOT EXISTS agent_asks_task ON agent_asks (task_id);
CREATE INDEX IF NOT EXISTS agent_asks_state ON agent_asks (state, agent_id);
`

// askView: one question to an agent. State: queued | running | answered | failed | expired.
type askView struct {
	ID       string `json:"id"`
	Task     string `json:"task"`
	Agent    string `json:"agent_id"`
	From     string `json:"from_agent"`
	Channel  string `json:"channel_id"`
	Thread   string `json:"thread_id"`
	Question string `json:"question"`
	Message  string `json:"message"`
	State    string `json:"state"`
	Machine  string `json:"machine_id,omitempty"`
	Created  int64  `json:"created"`
	Started  int64  `json:"started,omitempty"`
}

const askCols = "id, task_id, agent_id, from_agent, channel_id, thread_id, question, message, state, COALESCE(machine_id, ''), created, COALESCE(started, 0)"

func (h *Hub) asks(where string, args ...any) []askView {
	rows, err := h.db.Query("SELECT "+askCols+" FROM agent_asks WHERE "+where+" ORDER BY created", args...)
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []askView{}
	for rows.Next() {
		var x askView
		if err := rows.Scan(&x.ID, &x.Task, &x.Agent, &x.From, &x.Channel, &x.Thread, &x.Question, &x.Message, &x.State, &x.Machine, &x.Created, &x.Started); err != nil {
			panic(err)
		}
		out = append(out, x)
	}
	return out
}

// askAgent: A's run asks agent b (the `remi ask` endpoint, when the one named is an agent).
func (h *Hub) askAgent(w http.ResponseWriter, t taskView, a, b agentView, question string) {
	if s := structural(t, b); s != "" {
		errJSON(w, 400, s)
		return
	}
	r := h.reach(t, b)
	if r.Refuse != "" {
		errJSON(w, 403, r.Refuse)
		return
	}
	if r.Card {
		errJSON(w, 403, "用 @"+b.Handle+" 要它的主人先同意，询问不出卡片：改为问人（remi ask @某人），或者把这部分委派给它（remi delegate）")
		return
	}
	if n := h.count("SELECT COUNT(*) FROM agent_asks WHERE task_id = ?", t.ID); n >= maxAsks {
		errJSON(w, 429, "这个任务已经问过别的 Agent 3 次了（最多 3 次）：自己查，或者问人（remi ask @某人）")
		return
	}
	if r.Join {
		h.addMember(t.ChannelID, member{"agent", b.ID})
		h.channelChanged(t.ChannelID)
	}
	m := h.insertMessage(t.ChannelID, &t.ThreadID, member{"agent", a.ID}, "@"+b.Handle+" "+trimmed(question, 2000))
	x := askView{ID: newID("ask_"), Task: t.ID, Agent: b.ID, From: a.ID, Channel: t.ChannelID, Thread: t.ThreadID,
		Question: trimmed(question, 4000), Message: m.ID, State: "queued", Created: h.nowMs()}
	h.must(h.db.Exec(`INSERT INTO agent_asks (id, task_id, agent_id, from_agent, channel_id, thread_id, question, message, state, created)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, x.ID, x.Task, x.Agent, x.From, x.Channel, x.Thread, x.Question, x.Message, x.State, x.Created))
	h.askChanged(x)
	writeText(w, "asked @"+b.Handle+": msg="+m.ID+"\nIt answers in one read-only run on its computer (not a task); the answer reaches you in this session.\n"+
		"Go on with what does not depend on it. If nothing else is left, end your turn with status waiting and wait {\"how\": \"answer\", \"what\": \"@"+b.Handle+"'s answer\"}.\n")
}

// askChanged: B's computers hear of the question at once (they also see it in their poll).
func (h *Hub) askChanged(x askView) {
	b, _ := json.Marshal(obj{"type": "ask", "ask": obj{"id": x.ID, "agent_id": x.Agent, "state": x.State}})
	for _, id := range h.agentMachineList(x.Agent) {
		h.socks.send("m:"+id, b)
	}
}

// askPickable: whether machineID is the computer for a queued question: the first of the agent's computers that can
// take work now (those above it cannot), as for a new task.
func (h *Hub) askPickable(x askView, runtime, machineID string) bool {
	for _, id := range h.agentMachineList(x.Agent) {
		if id == machineID {
			return true
		}
		if h.canTake(id, runtime) {
			return false
		}
	}
	return false
}

// machineAsks: the questions waiting for this machine.
func (h *Hub) machineAsks(machineID string) []askView {
	out := []askView{}
	for _, x := range h.asks("state = 'queued' AND "+onMachine("agent_id"), machineID) {
		if b, ok := h.agent(x.Agent); ok && h.askPickable(x, b.Runtime, machineID) {
			out = append(out, x)
		}
	}
	return out
}

func (h *Hub) machineAsk(w http.ResponseWriter, q *request) (askView, agentView, bool) {
	xs := h.asks("id = ?", q.r.PathValue("id"))
	if len(xs) == 0 {
		errJSON(w, 404, "not found")
		return askView{}, agentView{}, false
	}
	b, _ := h.agent(xs[0].Agent)
	if !h.agentOn(b.ID, q.who.machineID) {
		errJSON(w, 403, "这个问题问的 Agent 不在这台机器上")
		return xs[0], b, false
	}
	return xs[0], b, true
}

// v1AskClaim: B's computer takes the question (the first claim wins) and gets what the run needs: the question, who
// asks, the thread, and the repository A's task works in (B's computer may have it).
func (h *Hub) v1AskClaim(w http.ResponseWriter, q *request) {
	x, b, ok := h.machineAsk(w, q)
	if !ok {
		return
	}
	if x.State != "queued" {
		errJSON(w, 409, "这个问题现在是 "+x.State+"，不能认领")
		return
	}
	h.must(h.db.Exec("UPDATE agent_asks SET state = 'running', machine_id = ?, started = ? WHERE id = ?", q.who.machineID, h.nowMs(), x.ID))
	t, _ := h.task(x.Task)
	thread := scanMessages(h.db.Query("SELECT "+messageCols+" FROM messages m WHERE m.id = ? OR m.thread_id = ? ORDER BY m.seq DESC LIMIT 30", x.Thread, x.Thread))
	for i, j := 0, len(thread)-1; i < j; i, j = i+1, j-1 {
		thread[i], thread[j] = thread[j], thread[i]
	}
	for i := range thread {
		thread[i].Text = clip(thread[i].Text, 2000)
	}
	names := map[string]string{}
	for _, m := range thread {
		if m.Author.Kind == "user" {
			if u, ok := h.user(m.Author.ID); ok {
				names[u.ID] = u.Name + " (@" + u.Handle + ")"
			}
		} else if ag, ok := h.agent(m.Author.ID); ok {
			names[ag.ID] = ag.Name + " (@" + ag.Handle + ")"
		}
	}
	from, _ := h.agent(x.From)
	creator, _ := h.user(t.CreatedBy)
	c, _ := h.channel(x.Channel)
	writeJSON(w, 200, obj{"ask": obj{"id": x.ID, "question": x.Question, "task": x.Task, "repo": t.Repo},
		"agent": b, "from": obj{"handle": from.Handle, "name": from.Name}, "requester": obj{"handle": creator.Handle, "name": creator.Name},
		"channel": obj{"name": c.Name, "topic": c.Topic}, "thread": thread, "names": names})
}

// v1AskAnswer: B's computer brings the answer ({text, discarded, error}): it goes in the thread as B's message to A,
// and to A's run.
func (h *Hub) v1AskAnswer(w http.ResponseWriter, q *request) {
	x, b, ok := h.machineAsk(w, q)
	if !ok {
		return
	}
	if x.State != "running" || x.Machine != q.who.machineID {
		errJSON(w, 409, "这个问题现在是 "+x.State+"，不收答案")
		return
	}
	var body struct {
		Text      string `json:"text"`
		Discarded bool   `json:"discarded"`
		Error     string `json:"error"`
	}
	_ = q.json(&body)
	from := "@" + h.agentHandle(x.From) + " "
	text, state := strings.TrimSpace(body.Text), "answered"
	if text == "" {
		state = "failed"
		why := trimmed(body.Error, 300)
		if why == "" {
			why = "它没有给出答案"
		}
		text = "没问到：" + why
	}
	text = from + trimmed(text, 6000)
	if body.Discarded {
		text += "\n\n（这次只读运行改了文件，改动已经丢弃）"
	}
	h.endAsk(x, state, member{"agent", b.ID}, text)
	writeJSON(w, 200, obj{"state": state})
}

// endAsk: the question is over (answered, failed or given up): the message goes in the thread and reaches A.
func (h *Hub) endAsk(x askView, state string, author member, text string) {
	m := h.insertMessage(x.Channel, &x.Thread, author, text)
	h.must(h.db.Exec("UPDATE agent_asks SET state = ?, answer_msg = ?, ended = ? WHERE id = ?", state, m.ID, h.nowMs(), x.ID))
	x.State = state
	h.askChanged(x)
	t, ok := h.task(x.Task)
	if !ok {
		return
	}
	switch t.State { // a task that went on to something else (delivered, cancelled) keeps the answer in its thread only
	case taskRunning:
		h.news(t)
	case taskWaiting:
		h.followUp(t)
	}
}

// tickAsks: questions no computer started within askQueue, and runs that never answered, are given up.
func (h *Hub) tickAsks() {
	now := h.nowMs()
	for _, x := range h.asks("state = 'queued' AND created < ?", now-askQueue.Milliseconds()) {
		h.endAsk(x, "expired", member{"agent", x.From}, "没问到 @"+h.agentHandle(x.Agent)+"：10 分钟内它的电脑没能开始（不在线或都忙）")
	}
	for _, x := range h.asks("state = 'running' AND started < ?", now-askLonger.Milliseconds()) {
		h.endAsk(x, "failed", member{"agent", x.From}, "没问到 @"+h.agentHandle(x.Agent)+"：它的运行半小时没有回音")
	}
}
