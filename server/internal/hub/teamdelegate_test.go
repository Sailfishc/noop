package hub

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// delegate: @A's run (read token) delegates WHAT to @handle; the child task's id ("" when refused) and the answer.
func (e *taskEnv) delegate(tok, text string) (string, resp) {
	r := e.do("POST", "/api/v1/agent/delegate", tok, map[string]any{"text": text})
	if r.status != 200 {
		return "", r
	}
	if i := strings.Index(string(r.raw), "T-"); i >= 0 {
		return string(r.raw)[i : i+6], r
	}
	return "", r
}

// waitDelegates: the run ends waiting for what it delegated.
func (e *taskEnv) waitDelegates(id, machineToken string, run int) resp {
	return e.do("POST", "/api/v1/tasks/"+id+"/report", machineToken, map[string]any{"state": "waiting", "summary": "等委派的交回", "wait": map[string]any{"how": "delegates"}, "run": run})
}

// claimChild: a machine claims a task; its read token.
func (e *taskEnv) claimChild(id, machineToken string) string {
	r := e.do("POST", "/api/v1/tasks/"+id+"/claim", machineToken, nil)
	if r.status != 200 {
		e.t.Fatalf("claim %s: %d %s", id, r.status, r.raw)
	}
	return r.body["read_token"].(string)
}

func hasTask(ts []any, id string) bool {
	for _, x := range ts {
		if x.(map[string]any)["id"] == id {
			return true
		}
	}
	return false
}

func TestDelegateAndReceipt(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	e.zwAgent("bei")
	e.zwAgent("san")
	id, tok, m := e.claimed("@acha 把退款流程整理成文档并补测试")
	root := m["id"].(string)

	b, r := e.delegate(tok, "@bei 写退款流程文档：覆盖全额和部分退款")
	check(t, "delegated to 张伟's own agent: no card, a child task at once", r.status == 200 && b != "" && strings.Contains(string(r.raw), "not to a person"), r)
	s, r := e.delegate(tok, "@san 补退款的单测：部分退款至少 3 个用例")
	check(t, "and to another", r.status == 200 && s != "", r)
	bt := e.task(b)
	md := bt["mandate"].(map[string]any)
	check(t, "the child: same thread, the requester's name, via @acha, delegated, its criteria what @acha asked", bt["thread_id"] == root &&
		bt["created_by"] == e.zw.id && md["delegated"] == true && md["parent"] == id && md["via"].([]any)[0] == e.aid &&
		bt["acceptance"] == "写退款流程文档：覆盖全额和部分退款" && bt["state"] == "queued", resp{raw: []byte(fmt.Sprint(bt))})
	pt := e.task(id)
	check(t, "the parent lists them", len(pt["delegates"].([]any)) == 2 && pt["delegates"].([]any)[0].(map[string]any)["task"] == b, resp{raw: []byte(fmt.Sprint(pt["delegates"]))})
	check(t, "no call on anyone", len(pt["calls"].([]any)) == 0)
	r = e.waitDelegates(id, e.token, 1)
	check(t, "@acha waits for them", r.status == 200 && r.body["state"] == "waiting" && r.body["wait"].(map[string]any)["deadline"] == float64(0), r)

	// a child asks the requester to decide: it goes to him; @acha is not disturbed
	e.claimChild(s, e.otherToken)
	e.do("POST", "/api/v1/tasks/"+s+"/report", e.otherToken, map[string]any{"state": "needs_decision", "summary": "两种写法", "decision": map[string]any{"question": "用表驱动吗？", "options": []any{"A: 用", "B: 不用"}}, "run": 1})
	check(t, "the child's decision is on the requester's list", hasTask(e.inbox(e.zw.session), s))
	r = e.do("POST", "/api/v1/tasks/"+s+"/decide", e.zw.session, map[string]any{"choice": "A: 用"})
	check(t, "he decides", r.status == 200, r)
	check(t, "the child goes on, @acha still waits", e.task(s)["state"] == "queued" && e.task(id)["state"] == "waiting", resp{raw: []byte(e.task(id)["state"].(string))})

	// the watchdog does not count a wait for delegates
	e.advance(8 * 24 * time.Hour)
	e.h.Tick()
	check(t, "a week later it still waits", e.task(id)["state"] == "waiting")

	// one comes back done: not on anyone's list, @acha not woken yet
	e.claimChild(b, e.otherToken)
	r = e.do("POST", "/api/v1/tasks/"+b+"/report", e.otherToken, map[string]any{"state": "review", "summary": "文档写好了，见 docs/refund.md", "run": 1,
		"evidence": []any{map[string]any{"criterion": 1, "how": "saw", "proof": "两种退款都写了"}}})
	check(t, "delivered back: done, not in review", r.status == 200 && r.body["state"] == "done", r)
	check(t, "not on the requester's list", !hasTask(e.inbox(e.zw.session), b))
	check(t, "@acha still waits", e.task(id)["state"] == "waiting")

	// the other fails: the last one back wakes @acha once, with the receipt
	e.claimChild(s, e.otherToken)
	e.do("POST", "/api/v1/tasks/"+s+"/report", e.otherToken, map[string]any{"state": "failed", "summary": "测试环境起不来", "run": 2})
	check(t, "a failed child is not the requester's to retry", !hasTask(e.inbox(e.zw.session), s) && e.task(s)["holder"].(map[string]any)["why"] == "receipt")
	pt = e.task(id)
	wk := pt["wait"].(map[string]any)["wake"].(map[string]any)
	pay := wk["payload"].(string)
	check(t, "@acha is woken with the receipt", pt["state"] == "queued" && wk["reason"] == "delegates" && strings.Contains(pay, b+" @bei: delivered") &&
		strings.Contains(pay, s+" @san: failed") && strings.Contains(pay, "测试环境起不来") && strings.Contains(pay, "两种退款都写了"), resp{raw: []byte(pay)})
	check(t, "the thread says so in a line", strings.Contains(e.lastReply(root), "委派的 2 个都交回了：@bei 做完了，@san 失败了"), resp{raw: []byte(e.lastReply(root))})
	check(t, "no call on anyone for the receipt", len(e.task(id)["calls"].([]any)) == 0)
	c := e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	check(t, "the claim brings it", c.body["wake"].(map[string]any)["reason"] == "delegates", c)

	// @acha sends @bei back twice; the third time is refused
	tok = c.body["read_token"].(string)
	for i := 1; i <= 2; i++ {
		_, r = e.delegate(tok, "@bei 补上退款失败的情况")
		check(t, "sent back", r.status == 200 && strings.Contains(string(r.raw), fmt.Sprintf("redo %d of 2", i)), r)
		check(t, "it runs again", e.task(b)["state"] == "queued")
		bc := e.do("POST", "/api/v1/tasks/"+b+"/claim", e.otherToken, nil)
		news := bc.body["new"].([]any)
		check(t, "with what @acha said", len(news) > 0 && strings.Contains(news[len(news)-1].(map[string]any)["text"].(string), "补上退款失败的情况"), bc)
		_, r = e.delegate(tok, "@bei 再改改")
		check(t, "not while it is still at it", r.status == 409, r)
		e.do("POST", "/api/v1/tasks/"+b+"/report", e.otherToken, map[string]any{"state": "review", "summary": "补好了", "run": int(bc.body["task"].(map[string]any)["runs"].(float64))})
	}
	_, r = e.delegate(tok, "@bei 还是不对")
	check(t, "the third time is refused: take it to a person", r.status == 429 && strings.Contains(string(r.raw), "needs_decision"), r)

	// @acha delivers: only now does the requester have something to accept
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "文档和测试都在了", "run": 2})
	ib := e.inbox(e.zw.session)
	check(t, "one acceptance for the requester: @acha's", hasTask(ib, id) && !hasTask(ib, b) && !hasTask(ib, s))
}

func TestDelegateRules(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	e.zwAgent("bei")
	e.zwAgent("san")
	e.zwAgent("si")
	wu := e.agentOf(e.wl.session, e.mid, "wu", "channel", true, true) // 王磊's, his yes first
	id, tok, _ := e.claimed("@acha 整理退款")

	_, r := e.delegate(tok, "@liuli 帮忙看看")
	check(t, "only to agents", r.status == 400, r)
	_, r = e.delegate(tok, "@acha 自己做")
	check(t, "not to itself", r.status == 400, r)

	// a card for 王磊's agent; once he clicks it, it is a delegated child
	_, r = e.delegate(tok, "@wu 查一下退款日志")
	check(t, "a card", r.status == 200 && strings.Contains(string(r.raw), "proposed"), r)
	x := e.task(id)["handoffs"].([]any)[0].(map[string]any)
	check(t, "a delegation card, the ball with 王磊", x["kind"] == "delegate" && e.task(id)["holder"].(map[string]any)["id"] == e.wl.id)
	r = e.do("POST", "/api/v1/tasks/"+id+"/handoff", e.wl.session, map[string]any{"id": x["id"], "accept": true})
	check(t, "he says yes", r.status == 200, r)
	wt := e.task(r.body["handoffs"].([]any)[0].(map[string]any)["task"].(string))
	check(t, "a delegated child of @wu", wt["agent_id"] == wu && wt["mandate"].(map[string]any)["delegated"] == true && wt["state"] == "queued", resp{raw: []byte(fmt.Sprint(wt))})

	// the chain: @bei (delegated by @acha) may not come back to @acha; three deep is the end
	b, _ := e.delegate(tok, "@bei 写文档")
	btok := e.claimChild(b, e.otherToken)
	for _, verb := range []string{"delegate", "handoff"} {
		r = e.do("POST", "/api/v1/agent/"+verb, btok, map[string]any{"text": "@acha 你来"})
		check(t, "the child can't "+verb+" back to the one waiting on it", r.status == 400 && strings.Contains(string(r.raw), "已经在这条链上"), r)
	}
	s, r := e.delegate(btok, "@san 帮我画个流程图")
	check(t, "one level down", r.status == 200 && s != "", r)
	stok := e.claimChild(s, e.otherToken)
	_, r = e.delegate(stok, "@si 再往下")
	check(t, "a fourth level is refused, and says which limit", r.status == 429 && strings.Contains(string(r.raw), "最多 3 个"), r)

	// cancelling the first task cancels what is not back yet
	r = e.do("POST", "/api/v1/tasks/"+id+"/cancel", e.zw.session, nil)
	check(t, "cancelled", r.status == 200, r)
	check(t, "its children and theirs go too", e.task(b)["state"] == "closed" && e.task(s)["state"] == "closed" && e.task(wt["id"].(string))["state"] == "closed")
}

func TestDelegateFuses(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	e.do("PATCH", "/api/v1/machines/"+e.zwMachine(), e.zw.session, map[string]any{"max_sessions": 16})
	for i := 1; i <= 9; i++ {
		e.zwAgent(fmt.Sprintf("d%d", i))
	}
	_, tok, _ := e.claimed("@acha 大活")
	var first string
	for i := 1; i <= 5; i++ {
		c, r := e.delegate(tok, fmt.Sprintf("@d%d 第 %d 块", i, i))
		check(t, "a direct delegation", r.status == 200, r)
		if i == 1 {
			first = c
		}
	}
	_, r := e.delegate(tok, "@d6 第 6 块")
	check(t, "the sixth direct one is refused", r.status == 429 && strings.Contains(string(r.raw), "最多 5 个"), r)
	ftok := e.claimChild(first, e.otherToken)
	for i := 6; i <= 8; i++ {
		_, r = e.delegate(ftok, fmt.Sprintf("@d%d 再拆", i))
		check(t, "below it, up to eight in all", r.status == 200, r)
	}
	_, r = e.delegate(ftok, "@d9 再拆")
	check(t, "the ninth under one first task is refused", r.status == 429 && strings.Contains(string(r.raw), "最多 8 个"), r)
}
