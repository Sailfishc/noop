package hub

import (
	"encoding/json"
	"net/http"
	"strings"
)

// One way in for everything that reaches an agent (the collaboration plan, stage 1). A person's reply, an answer to
// the agent's question, a repository it asked for: each is news for the task. A task that is not running is queued
// again (as before); a running one is marked (tasks_v1.news) and its machine stops the run after the tool call in
// flight and resumes the same session with what is new, instead of letting the run finish first.
//
// Who wakes an agent is one rule (wakes): in a task's thread only the people who have a stake in it reach the agent
// by just replying (its creator, the person named to take it, the agent's owner, someone it asked a question);
// anyone else @-mentions it, as they would anywhere. People can talk to each other in a task's thread without
// restarting the agent.
//
// The agent declares what the server used to guess, with its `remi` command: `remi ask @x QUESTION` puts a question
// to someone without ending its turn (the answer arrives as news), `remi repo owner/name` asks for a repository to
// change (its machine prepares a worktree and resumes it there). The server checks the few boundaries and records.

// askedView: a question the agent put to someone while it worked, and whether they answered.
type askedView struct {
	User     string `json:"user"`
	Question string `json:"question"`
	Message  string `json:"message"` // the agent's message in the thread
	At       int64  `json:"at"`
	Answered int64  `json:"answered,omitempty"` // when they replied in the thread (0: not yet)
	Kind     string `json:"kind,omitempty"`     // "" a question (remi ask) | handoff: the ball is theirs (remi handoff @person)
}

// openQuestion: the question to this person still waiting for their answer, if any.
func openQuestion(t taskView, userID string) int {
	for i, q := range t.Asked {
		if q.User == userID && q.Answered == 0 {
			return i
		}
	}
	return -1
}

// wakes: does this person's message in the task's thread reach the task's agent?
func (h *Hub) wakes(t taskView, m messageView) bool {
	if m.Author.Kind != "user" {
		return false
	}
	me := m.Author.ID
	a, _ := h.agent(t.AgentID)
	if me == t.CreatedBy || me == t.Handler || me == a.OwnerID || openQuestion(t, me) >= 0 {
		return true
	}
	for _, mm := range m.Mentions {
		if mm.Kind == "agent" && mm.ID == t.AgentID {
			return a.Dispatch != "owner" // an owner-only agent takes words only from its owner
		}
	}
	return false
}

// answered: the person's reply answers the question the agent put to them.
func (h *Hub) answered(t taskView, m messageView) {
	i := openQuestion(t, m.Author.ID)
	if i < 0 {
		return
	}
	t.Asked[i].Answered = m.Created
	h.setTask(t.ID, map[string]any{"asked": jsonOrNil(t.Asked)})
}

// news: something new for the task's agent. A running task is marked for its machine; one that stopped goes back to
// its machine's queue; a waiting one wakes.
func (h *Hub) news(t taskView) {
	switch {
	case t.State == taskRunning:
		h.setTask(t.ID, map[string]any{"news": 1})
		h.taskChanged(t.ID)
	default:
		h.followUp(t)
	}
}

// textBody: the words a `remi` command sent (text/plain as they are, or {"text": …}).
func textBody(q *request) string {
	if strings.HasPrefix(q.r.Header.Get("content-type"), "text/plain") {
		return string(q.body)
	}
	var b struct {
		Text string `json:"text"`
	}
	_ = q.json(&b)
	return b.Text
}

// maxAsked: questions a task may have open at once.
const maxAsked = 5

// v1AgentAsk: `remi ask @x QUESTION`: the agent asks someone in the channel, in the task's thread, and goes on with
// what does not depend on the answer. The question is on their 待你处理 until they reply in the thread; the reply
// reaches the agent at once (news), or starts its next turn when it already stopped.
func (h *Hub) v1AgentAsk(w http.ResponseWriter, q *request) {
	t, a, ok := h.reader(w, q)
	if !ok {
		return
	}
	text := strings.TrimSpace(textBody(q))
	var target mention
	for _, m := range h.mentions(text) {
		if m.Kind == "user" {
			target = m
			break
		}
	}
	question := strings.TrimSpace(strings.Replace(text, "@"+target.Handle, "", 1))
	if target.ID == "" || question == "" {
		errJSON(w, 400, "用法：remi ask @某人 问题")
		return
	}
	if !h.memberOrAdmin(t.ChannelID, target.ID) {
		errJSON(w, 400, "@"+target.Handle+" 不在这个频道里")
		return
	}
	open := 0
	for _, x := range t.Asked {
		if x.Answered == 0 {
			open++
		}
	}
	if open >= maxAsked {
		errJSON(w, 429, "已经有 5 个问题在等回答了；等他们回答，或者结束这一轮")
		return
	}
	m := h.insertMessage(t.ChannelID, &t.ThreadID, member{"agent", a.ID}, "@"+target.Handle+" "+trimmed(question, 2000))
	asked := append(t.Asked, askedView{User: target.ID, Question: trimmed(question, 300), Message: m.ID, At: h.nowMs()})
	h.setTask(t.ID, map[string]any{"asked": jsonOrNil(asked)})
	h.taskChanged(t.ID)
	writeText(w, "asked @"+target.Handle+": msg="+m.ID+"\nGo on with what does not depend on the answer; it reaches you in this session when they reply.\n"+
		"If nothing else is left, end your turn with status waiting and wait {\"how\": \"answer\", \"what\": \"@"+target.Handle+"'s answer\"}.\n")
}

// v1AgentRepo: `remi repo owner/name`: the agent will change this repository. Its machine must have it or be able to
// clone it; the machine prepares a worktree on the task's branch and resumes the agent there (news).
func (h *Hub) v1AgentRepo(w http.ResponseWriter, q *request) {
	t, a, ok := h.reader(w, q)
	if !ok {
		return
	}
	arg := strings.TrimSpace(textBody(q))
	remote := normRemote(arg)
	if remote == "" && arg != "" { // owner/name of a repository a machine reported
		remote = h.repoInText(" " + arg + " ")
	}
	if remote == "" {
		errJSON(w, 400, "用法：remi repo owner/name，或者仓库地址（https://github.com/owner/name）")
		return
	}
	if remote == t.Repo || contains(t.Repos, remote) {
		writeText(w, "already: "+remote+"\n")
		return
	}
	if len(t.Repos) >= 5 {
		errJSON(w, 429, "一个任务最多声明 5 个仓库")
		return
	}
	if a.MachineID == nil || !h.machineReaches(*a.MachineID, remote) {
		errJSON(w, 403, "这台机器上没有 "+remote+"，也没有它所在平台的凭证；请人把仓库放到这台机器上，或者换一台机器")
		return
	}
	h.setTask(t.ID, map[string]any{"repos": jsonOrNil(append(t.Repos, remote)), "news": 1, "tracked": 1})
	h.taskChanged(t.ID)
	writeText(w, "ok: "+remote+"\nYour machine prepares a worktree of it on your task branch and resumes you there in a moment, in this session. Finish this step and wait for that.\n")
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// machineReaches: the machine has a checkout of the remote, or credentials for its host (it can clone it).
func (h *Hub) machineReaches(machineID, remote string) bool {
	var info string
	if h.db.QueryRow("SELECT COALESCE(info, '') FROM machines WHERE id = ?", machineID).Scan(&info) != nil {
		return false
	}
	var mi machineInfo
	_ = json.Unmarshal([]byte(info), &mi)
	for _, r := range mi.Repos {
		if r.Remote == remote {
			return true
		}
	}
	host := remote[:strings.IndexByte(remote, '/')]
	for _, g := range mi.Git {
		if strings.EqualFold(g.Host, host) && g.Configured {
			return true
		}
	}
	return false
}
