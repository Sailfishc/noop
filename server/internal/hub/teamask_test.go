package hub

import (
	"strings"
	"testing"
	"time"
)

func (e *taskEnv) ask(tok, text string) resp {
	return e.do("POST", "/api/v1/agent/ask", tok, map[string]any{"text": text})
}

func TestAskAgent(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	e.zwAgent("bei")
	e.agentOf(e.wl.session, e.mid, "wu", "channel", true, true) // 王磊's, his yes first
	id, tok, m := e.claimed("@acha 查一下订单接口")
	root := m["id"].(string)

	r := e.ask(tok, "@bei 订单接口返回什么格式？")
	check(t, "asked", r.status == 200 && strings.Contains(string(r.raw), "read-only run"), r)
	check(t, "the question is in the thread", strings.Contains(e.lastReply(root), "@bei 订单接口返回什么格式"))
	ms := e.do("GET", "/api/v1/machine/tasks", e.otherToken, nil)
	asks := ms.body["asks"].([]any)
	check(t, "@bei's computer sees it, not as a task", len(asks) == 1 && len(ms.body["tasks"].([]any)) == 0, ms)
	aid := asks[0].(map[string]any)["id"].(string)
	check(t, "another computer can't take it", e.do("POST", "/api/v1/asks/"+aid+"/claim", e.token, nil).status == 403)
	c := e.do("POST", "/api/v1/asks/"+aid+"/claim", e.otherToken, nil)
	check(t, "claimed with the question and the thread", c.status == 200 && c.body["ask"].(map[string]any)["question"] == "订单接口返回什么格式？" &&
		c.body["from"].(map[string]any)["handle"] == "acha" && len(c.body["thread"].([]any)) >= 2, c)
	check(t, "once", e.do("POST", "/api/v1/asks/"+aid+"/claim", e.otherToken, nil).status == 409)
	r = e.do("POST", "/api/v1/asks/"+aid+"/answer", e.otherToken, map[string]any{"text": "JSON：id、amount、state", "discarded": true})
	check(t, "answered", r.status == 200 && r.body["state"] == "answered", r)
	last := e.lastReply(root)
	check(t, "the answer is in the thread, to @acha, with what was thrown away", strings.HasPrefix(last, "@acha JSON：id、amount、state") && strings.Contains(last, "改动已经丢弃"), resp{raw: []byte(last)})
	check(t, "@acha's run hears it", e.task(id)["news"] == true)
	cl := e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	news := cl.body["new"].([]any)
	check(t, "the claim brings the answer", len(news) == 1 && strings.Contains(news[0].(map[string]any)["text"].(string), "id、amount"), cl)
	tok = cl.body["read_token"].(string)
	check(t, "no task, nothing in an inbox, no call", len(e.do("GET", "/api/v1/tasks?thread="+root, e.zw.session, nil).body["tasks"].([]any)) == 1 &&
		!hasTask(e.inbox(e.zw.session), id) && len(e.task(id)["calls"].([]any)) == 0)

	r = e.ask(tok, "@wu 网关日志在哪？")
	check(t, "an agent behind a card is not asked", r.status == 403 && strings.Contains(string(r.raw), "询问不出卡片"), r)
	r = e.ask(tok, "@acha 你好")
	check(t, "not itself", r.status == 400, r)
	check(t, "a second", e.ask(tok, "@bei 金额是分还是元？").status == 200)
	check(t, "a third", e.ask(tok, "@bei 状态有哪些？").status == 200)
	r = e.ask(tok, "@bei 还有一个问题")
	check(t, "the fourth is refused", r.status == 429 && strings.Contains(string(r.raw), "最多 3 次"), r)

	// nobody starts them: after ten minutes they are given up, and @acha (waiting for the answer) is woken
	r = e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "waiting", "summary": "等 @bei", "wait": map[string]any{"how": "answer", "what": "@bei 的回答"},
		"run": int(cl.body["task"].(map[string]any)["runs"].(float64))})
	check(t, "waits", r.status == 200 && r.body["state"] == "waiting", r)
	e.advance(11 * time.Minute)
	e.h.Tick()
	check(t, "given up, said in the thread", strings.Contains(e.lastReply(root), "没问到 @bei"), resp{raw: []byte(e.lastReply(root))})
	check(t, "@acha is woken", e.task(id)["state"] == "queued")
	check(t, "and the questions are no longer offered", len(e.do("GET", "/api/v1/machine/tasks", e.otherToken, nil).body["asks"].([]any)) == 0)
}

func TestAskAgentChain(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	e.zwAgent("bei")
	_, tok, _ := e.claimed("@acha 写文档")
	b, _ := e.delegate(tok, "@bei 写一节")
	btok := e.claimChild(b, e.otherToken)
	r := e.ask(btok, "@acha 你想要多长？")
	check(t, "a delegated agent can't ask the one waiting on it", r.status == 400 && strings.Contains(string(r.raw), "已经在这条链上"), r)
}
