package hub

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// zwAgent: an agent of 张伟's on his own machine, in the channel.
func (e *taskEnv) zwAgent(handle string) string {
	var mid string
	for _, m := range e.do("GET", "/api/v1/machines", e.zw.session, nil).body["machines"].([]any) {
		if m.(map[string]any)["name"] == "张伟的 Mac" {
			mid = m.(map[string]any)["id"].(string)
		}
	}
	r := e.do("POST", "/api/v1/agents", e.zw.session, map[string]any{"handle": handle, "machine_id": mid, "dispatch": "channel", "confirm": true})
	id := r.body["id"].(string)
	e.do("POST", "/api/v1/channels/"+e.cid+"/members", e.zw.session, map[string]any{"kind": "agent", "id": id})
	return id
}

func TestHandoffAndHolder(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	bei, san := e.zwAgent("bei"), e.zwAgent("san")
	e.zwAgent("si")
	id, tok, m := e.claimed("@acha 修一下退款")
	root := m["id"].(string)
	holder := func(id string) map[string]any { h, _ := e.task(id)["holder"].(map[string]any); return h }
	check(t, "while it works the agent has the ball", holder(id)["kind"] == "agent" && holder(id)["why"] == "work")

	r := e.do("POST", "/api/v1/agent/handoff", tok, map[string]any{"text": "@bei 改完后写发布说明"})
	check(t, "an agent proposes handing on to another agent", r.status == 200, r)
	tk := e.task(id)
	x := tk["handoffs"].([]any)[0].(map[string]any)
	check(t, "a card waits for a person; the requester has the ball", x["state"] == "proposed" && holder(id)["id"] == e.zw.id && holder(id)["why"] == "handoff_card")
	check(t, "on the requester's list", len(e.inbox(e.zw.session)) == 1)
	check(t, "a bystander can't click it", e.do("POST", "/api/v1/tasks/"+id+"/handoff", e.ll.session, map[string]any{"id": x["id"], "accept": true}).status == 403)
	r = e.do("POST", "/api/v1/tasks/"+id+"/handoff", e.zw.session, map[string]any{"id": x["id"], "accept": true})
	check(t, "the requester accepts it", r.status == 200, r)
	x = r.body["handoffs"].([]any)[0].(map[string]any)
	nt := e.task(x["task"].(string))
	md := nt["mandate"].(map[string]any)
	check(t, "the other agent has a task in the same thread, in the requester's name, via the first agent", nt["agent_id"] == bei &&
		nt["thread_id"] == root && nt["created_by"] == e.zw.id && md["via"].([]any)[0] == e.aid && md["parent"] == id && nt["state"] == "queued", resp{raw: []byte(nt["id"].(string))})

	// the second agent runs, and tries to hand back: no cycles
	nr := e.do("POST", "/api/v1/tasks/"+nt["id"].(string)+"/claim", e.otherToken, nil)
	btok := nr.body["read_token"].(string)
	check(t, "not back to an agent in the chain", e.do("POST", "/api/v1/agent/handoff", btok, map[string]any{"text": "@acha 你再看看"}).status == 400)
	r = e.do("POST", "/api/v1/agent/handoff", btok, map[string]any{"text": "@san 帮忙测一下"})
	check(t, "on to a third", r.status == 200, r)
	ho := e.task(nt["id"].(string))["handoffs"].([]any)[0].(map[string]any)
	r = e.do("POST", "/api/v1/tasks/"+nt["id"].(string)+"/handoff", e.zw.session, map[string]any{"id": ho["id"], "accept": true})
	third := e.task(r.body["handoffs"].([]any)[0].(map[string]any)["task"].(string))
	check(t, "the third knows the chain", len(third["mandate"].(map[string]any)["via"].([]any)) == 2 && third["agent_id"] == san)
	tr := e.do("POST", "/api/v1/tasks/"+third["id"].(string)+"/claim", e.otherToken, nil)
	r = e.do("POST", "/api/v1/agent/handoff", tr.body["read_token"].(string), map[string]any{"text": "@si 再交给你"})
	check(t, "three agents is the longest chain", r.status == 429, r)

	// to a person: the ball is theirs until they reply
	r = e.do("POST", "/api/v1/agent/handoff", tok, map[string]any{"text": "@liuli 请你在测试环境点一下退款"})
	check(t, "handed to a person", r.status == 200, r)
	check(t, "the ball is hers", holder(id)["id"] == e.ll.id && holder(id)["why"] == "handoff")
	check(t, "on her list", len(e.inbox(e.ll.session)) == 1)
	e.post(e.ll.session, "点过了，没问题", root)
	tk = e.task(id)
	check(t, "her reply reaches the agent and the ball goes back", tk["news"] == true && holder(id)["kind"] == "agent")

	check(t, "an agent can't @ another agent through a reminder", e.do("POST", "/api/v1/agent/remind", tok,
		bytes.NewBufferString("2h @bei 写发布说明"), "content-type", "text/plain").status == 400)
	r = e.do("POST", "/api/v1/agent/remind", tok, bytes.NewBufferString("1m 请 @bei 写发布说明"), "content-type", "text/plain")
	check(t, "nor by reminding itself with the other agent's @ in the text", r.status == 400 && strings.Contains(string(r.raw), "remi handoff @bei"), r)
	r = e.do("POST", "/api/v1/agent/remind", tok, bytes.NewBufferString("1m 问 @liuli 发布说明写好没"), "content-type", "text/plain")
	check(t, "a person's @ in its own reminder is fine", r.status == 200, r)
}

func TestRemiSubmit(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	id, tok, _ := e.claimed("@acha 渲染一下视频")
	for i := 0; i < 3; i++ {
		check(t, "a submission is counted", e.do("POST", "/api/v1/agent/submit", tok, map[string]any{"text": "render job"}).status == 200)
	}
	r := e.do("POST", "/api/v1/agent/submit", tok, map[string]any{"text": "render job"})
	check(t, "the fourth is refused", r.status == 429 && strings.Contains(string(r.raw), "needs_decision"), r)
	check(t, "on the task", len(e.task(id)["submits"].([]any)) == 3)
}

func TestTriggers(t *testing.T) {
	e := newTaskEnv(t, "channel", true) // @acha asks its owner (王磊) first
	r := e.do("POST", "/api/v1/triggers", e.zw.session, map[string]any{"channel_id": e.cid, "agent": "acha", "kind": "schedule", "when": "9:00", "repeat": "weekdays", "text": "看一下昨晚的告警"})
	check(t, "张伟 sets a schedule for @acha", r.status == 200 && r.body["confirmed_by"] == nil, r)
	trg := r.body["id"].(string)
	msgs := e.do("GET", "/api/v1/channels/"+e.cid+"/messages", e.zw.session, nil).body["messages"].([]any)
	check(t, "its owner is asked to confirm once", strings.Contains(msgs[len(msgs)-1].(map[string]any)["text"].(string), "@wanglei"))
	e.advance(6 * time.Hour) // 10:00 UTC: past 9:00
	e.h.Tick()
	check(t, "unconfirmed: nothing runs", len(e.do("GET", "/api/v1/tasks", e.zw.session, nil).body["tasks"].([]any)) == 0)
	check(t, "only the owner confirms", e.do("POST", "/api/v1/triggers/"+trg+"/confirm", e.ll.session, nil).status == 403)
	check(t, "the owner confirms", e.do("POST", "/api/v1/triggers/"+trg+"/confirm", e.wl.session, nil).status == 200)
	e.advance(24 * time.Hour)
	e.h.Tick()
	ts := e.do("GET", "/api/v1/tasks", e.zw.session, nil).body["tasks"].([]any)
	check(t, "it fires: a task at once, in 张伟's name", len(ts) == 1 && ts[0].(map[string]any)["state"] == "queued" &&
		ts[0].(map[string]any)["created_by"] == e.zw.id && ts[0].(map[string]any)["mandate"].(map[string]any)["trigger"] == trg, resp{raw: []byte(time.Now().String())})
	tv := e.do("GET", "/api/v1/triggers?channel="+e.cid, e.zw.session, nil).body["triggers"].([]any)[0].(map[string]any)
	check(t, "and goes again next time", tv["fires"] == float64(1) && int64(tv["due"].(float64)) > e.now().UnixMilli())
	check(t, "a bystander can't remove it", e.do("DELETE", "/api/v1/triggers/"+trg, e.ll.session, nil).status == 403)
	check(t, "nonsense is refused", e.do("POST", "/api/v1/triggers", e.zw.session, map[string]any{"channel_id": e.cid, "agent": "acha", "kind": "schedule", "when": "9:00", "text": "x"}).status == 400)

	// pull requests and pushes (the owner sets these up: confirmed at once)
	r = e.do("POST", "/api/v1/triggers", e.wl.session, map[string]any{"channel_id": e.cid, "agent": "acha", "kind": "pr", "repo": "https://github.com/acme/pay", "text": "review 这个 PR"})
	check(t, "a PR trigger", r.status == 200 && r.body["confirmed_by"] == e.wl.id, r)
	e.do("POST", "/api/v1/triggers", e.wl.session, map[string]any{"channel_id": e.cid, "agent": "acha", "kind": "push", "repo": "https://code.corp.com/fin/ledger", "branch": "main", "text": "跑一下冒烟测试"})
	e.h.cfg.GitWebhookSecret = "s3cret"
	gh := func(event string, body any) resp {
		j, _ := json.Marshal(body)
		mac := hmac.New(sha256.New, []byte("s3cret"))
		mac.Write(j)
		return e.do("POST", "/api/v1/hooks/github", "", bytes.NewBuffer(j), "X-GitHub-Event", event, "X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	}
	pr := func(head string) map[string]any {
		return map[string]any{"action": "opened", "repository": map[string]any{"html_url": "https://github.com/acme/pay"},
			"pull_request": map[string]any{"number": 7, "title": "退款加重试", "html_url": "https://github.com/acme/pay/pull/7", "state": "open", "head": map[string]any{"ref": head}, "base": map[string]any{"ref": "main"}}}
	}
	check(t, "a forged GitHub hook is refused", e.do("POST", "/api/v1/hooks/github", "", map[string]any{}, "X-GitHub-Event", "push").status == 401)
	r = gh("pull_request", pr("feature/retry"))
	check(t, "a person's PR fires it", r.status == 200 && r.body["fired"] == float64(1), r)
	r = gh("pull_request", pr("agent/T-0009"))
	check(t, "an agent's own PR does not", r.status == 200 && r.body["fired"] == nil, r)
	r = e.do("POST", "/api/v1/hooks/gitlab", "", map[string]any{"object_kind": "push", "ref": "refs/heads/main", "after": "abc123",
		"project": map[string]any{"web_url": "https://code.corp.com/fin/ledger"}, "commits": []any{map[string]any{"message": "fix ledger", "url": "https://code.corp.com/fin/ledger/-/commit/abc123"}}}, "X-Gitlab-Token", "s3cret")
	check(t, "a push to main fires the push trigger", r.body["fired"] == float64(1), r)
	r = e.do("POST", "/api/v1/hooks/gitlab", "", map[string]any{"object_kind": "push", "ref": "refs/heads/dev", "after": "abc124",
		"project": map[string]any{"web_url": "https://code.corp.com/fin/ledger"}}, "X-Gitlab-Token", "s3cret")
	check(t, "not a push to another branch", r.body["fired"] == float64(0), r)
	ts = e.do("GET", "/api/v1/tasks", e.zw.session, nil).body["tasks"].([]any)
	check(t, "three tasks in all", len(ts) == 3, resp{raw: []byte(time.Now().String())})
}
