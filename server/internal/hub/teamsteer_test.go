package hub

import (
	"testing"
	"time"
)

// claimed: 张伟 asks @acha (it needs no confirmation), the Mac claims it; the task and the run's read token.
func (e *taskEnv) claimed(text string) (string, string, map[string]any) {
	m := e.post(e.zw.session, text, "")
	id := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	r := e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	if r.status != 200 {
		e.t.Fatalf("claim: %d %s", r.status, r.raw)
	}
	return id, r.body["read_token"].(string), m
}

func TestWakeRuleAndNews(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	id, _, m := e.claimed("@acha 看下慢查询")
	root := m["id"].(string)

	e.post(e.ll.session, "这个我上周也遇到过", root)
	check(t, "a bystander talking in the thread does not reach the running agent", e.task(id)["news"] == false)
	e.post(e.zw.session, "先别动索引", root)
	tk := e.task(id)
	check(t, "the creator's words are news for the running agent", tk["state"] == "running" && tk["news"] == true)
	r := e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	fresh := r.body["new"].([]any)
	check(t, "the machine takes the news (the bystander's words come along, as context), same run", len(fresh) == 2 &&
		r.body["task"].(map[string]any)["runs"] == float64(1) && r.body["task"].(map[string]any)["news"] == false, r)
	for i := 0; i < maxFailures+1; i++ {
		e.post(e.zw.session, "再补一句", root)
		r = e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
		check(t, "taking up news again and again is not the daemon dying", r.status == 200 && r.body["task"].(map[string]any)["failures"] == float64(0), r)
	}
	r = e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	check(t, "claiming it again with nothing new is a restart, and counts", r.status == 200 && r.body["task"].(map[string]any)["failures"] == float64(1), r)
	r = e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "好了"})
	check(t, "nothing new since: it stops", r.body["state"] == "review", r)

	e.post(e.ll.session, "我觉得还行", root)
	check(t, "a bystander's reply does not reopen it", e.task(id)["state"] == "review")
	e.post(e.ll.session, "@acha 顺便把 /refunds 也看了", root)
	check(t, "an @ does", e.task(id)["state"] == "queued")
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	e.post(e.wl.session, "注意别锁表", root)
	check(t, "the agent's owner reaches it too", e.task(id)["news"] == true)
	r = e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "好了"})
	check(t, "news the machine did not take: the next run takes it", r.body["state"] == "queued", r)

	// an owner-only agent takes words only from its owner, @ or not
	e.do("PATCH", "/api/v1/agents/"+e.aid, e.wl.session, map[string]any{"dispatch": "owner"})
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	e.post(e.ll.session, "@acha 也看看 /pay", root)
	check(t, "owner-only: a bystander's @ does not reach it", e.task(id)["news"] == false)
}

func TestRemiAsk(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	id, tok, m := e.claimed("@acha 写一下发版说明")
	r := e.do("POST", "/api/v1/agent/ask", tok, map[string]any{"text": "@liuli 这次的版本号是 3.2 还是 4.0？"})
	check(t, "the agent asks someone in the channel", r.status == 200, r)
	th := e.do("GET", "/api/v1/messages/"+m["id"].(string)+"/thread", e.zw.session, nil).body["replies"].([]any)
	last := th[len(th)-1].(map[string]any)
	check(t, "in the thread, as the agent, @-ing them", last["text"] == "@liuli 这次的版本号是 3.2 还是 4.0？" && last["author"].(map[string]any)["kind"] == "agent", resp{raw: []byte(last["text"].(string))})
	tk := e.task(id)
	asked := tk["asked"].([]any)
	check(t, "recorded on the task", len(asked) == 1 && asked[0].(map[string]any)["user"] == e.ll.id && tk["state"] == "running", resp{raw: []byte(id)})
	check(t, "on their 待你处理", len(e.inbox(e.ll.session)) == 1)
	check(t, "someone not in the channel cannot be asked", e.do("POST", "/api/v1/agent/ask", tok, map[string]any{"text": "@nobody 你好"}).status == 400)

	// it ran out of other work: it waits for the answer
	r = e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "waiting", "summary": "等 @liuli 回答版本号", "wait": map[string]any{"how": "answer", "what": "版本号"}})
	check(t, "waits for the answer", r.body["state"] == "waiting" && r.body["wait"].(map[string]any)["deadline"] == float64(e.now().Add(24*time.Hour).UnixMilli()), r)
	e.post(e.ll.session, "4.0", m["id"].(string))
	tk = e.task(id)
	check(t, "their reply wakes it (刘丽 is no party to the task, but she was asked)", tk["state"] == "queued" &&
		tk["wait"].(map[string]any)["wake"].(map[string]any)["reason"] == "message", resp{raw: []byte(tk["state"].(string))})
	check(t, "answered: off their 待你处理", len(e.inbox(e.ll.session)) == 0 && tk["asked"].([]any)[0].(map[string]any)["answered"] != nil)
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	e.post(e.ll.session, "对了还有个事", m["id"].(string))
	check(t, "once answered, her chatter no longer reaches it", e.task(id)["news"] == false)
}

func TestRemiRepo(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	e.do("PUT", "/api/v1/machine", e.token, map[string]any{"os": "darwin", "runtimes": []string{"codex"},
		"repos": []any{map[string]any{"remote": "git@github.com:acme/pay.git"}},
		"git":   []any{map[string]any{"provider": "gitlab", "host": "code.corp.com", "configured": true, "user": "bot"}}})
	e.do("PATCH", "/api/v1/channels/"+e.cid, e.wl.session, map[string]any{"repo": "https://github.com/acme/pay"})
	id, tok, _ := e.claimed("@acha 退款按钮点了没反应")
	r := e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	check(t, "it starts general; the channel's default comes as a hint", r.body["task"].(map[string]any)["repo"] == "" &&
		r.body["channel"].(map[string]any)["repo"] == "github.com/acme/pay", r)

	r = e.do("POST", "/api/v1/agent/repo", tok, map[string]any{"text": "acme/pay"})
	check(t, "the agent declares a repository its machine has", r.status == 200, r)
	tk := e.task(id)
	check(t, "recorded, tracked, and news for the machine", len(tk["repos"].([]any)) == 1 && tk["repos"].([]any)[0] == "github.com/acme/pay" &&
		tk["news"] == true && tk["tracked"] == true, resp{raw: []byte(id)})
	check(t, "declaring it again changes nothing", e.do("POST", "/api/v1/agent/repo", tok, map[string]any{"text": "https://github.com/acme/pay"}).status == 200 &&
		len(e.task(id)["repos"].([]any)) == 1)
	r = e.do("POST", "/api/v1/agent/repo", tok, map[string]any{"text": "https://code.corp.com/fin/ledger"})
	check(t, "one it can clone (credentials for the host)", r.status == 200, r)
	r = e.do("POST", "/api/v1/agent/repo", tok, map[string]any{"text": "https://github.com/other/secret"})
	check(t, "not one its machine cannot reach", r.status == 403, r)
	check(t, "nonsense is refused", e.do("POST", "/api/v1/agent/repo", tok, map[string]any{"text": "pay"}).status == 400)
}
