package hub

import (
	"fmt"
	"net/url"
	"testing"
	"time"
)

// channelTexts: the texts of the channel's messages, oldest first (top level only).
func (e *taskEnv) channelTexts() []string {
	out := []string{}
	for _, m := range e.do("GET", "/api/v1/channels/"+e.cid+"/messages", e.zw.session, nil).body["messages"].([]any) {
		out = append(out, m.(map[string]any)["text"].(string))
	}
	return out
}

// dutyRuns: a duty's history (?channel&agent&duty or ?trigger), newest first.
func (e *taskEnv) dutyRuns(session, query string) []map[string]any {
	r := e.do("GET", "/api/v1/triggers/runs?"+query, session, nil)
	if r.status != 200 {
		return nil
	}
	out := []map[string]any{}
	for _, x := range r.body["runs"].([]any) {
		out = append(out, x.(map[string]any))
	}
	return out
}

func TestDutiesAndPatrols(t *testing.T) {
	e := newTaskEnv(t, "channel", true)
	// two read-only schedules under one duty, set up by @acha's owner (confirmed at once); readonly is the default
	mk := func(when, duty string, extra map[string]any) string {
		b := map[string]any{"channel_id": e.cid, "agent": "acha", "kind": "schedule", "when": when, "repeat": "daily", "text": "看一下主干的 CI", "duty": duty}
		for k, v := range extra {
			b[k] = v
		}
		r := e.do("POST", "/api/v1/triggers", e.wl.session, b)
		if r.status != 200 {
			t.Fatalf("trigger: %d %s", r.status, r.raw)
		}
		return r.body["id"].(string)
	}
	a1 := mk("9:00", "  看住   主干 ", nil)
	a2 := mk("15:00", "看住 主干", nil)
	tv := e.do("GET", "/api/v1/triggers?channel="+e.cid, e.zw.session, nil).body["triggers"].([]any)[0].(map[string]any)
	check(t, "a new trigger is read-only by default and has its duty's name, tidied", tv["readonly"] == true && tv["duty"] == "看住 主干", resp{raw: []byte(fmt.Sprint(tv))})
	before := len(e.channelTexts())

	// it fires: a task, but nothing in the channel yet, and not on the board
	e.advance(10 * time.Hour) // 10:00 UTC: past 9:00
	e.h.Tick()
	ts := e.do("GET", "/api/v1/tasks", e.zw.session, nil).body["tasks"].([]any)
	check(t, "one patrol task", len(ts) == 1, resp{raw: []byte(fmt.Sprint(ts))})
	task := ts[0].(map[string]any)
	id := task["id"].(string)
	check(t, "read-only, quiet, untracked", task["readonly"] == true && task["quiet"] == true && task["tracked"] == false, resp{raw: []byte(fmt.Sprint(task))})
	check(t, "no ⚡ message in the channel while it looks", len(e.channelTexts()) == before)
	check(t, "not on the task board (tracked)", len(e.do("GET", "/api/v1/tasks?tracked=1", e.zw.session, nil).body["tasks"].([]any)) == 0)
	cl := e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	th := cl.body["thread"].([]any)
	check(t, "the run reads the prompt text without a fake ⚡ user message", cl.status == 200 && len(th) == 1 &&
		th[0].(map[string]any)["text"].(string) == "看一下主干的 CI" && cl.body["firing"] != nil, cl)
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"reaction": "🔍"})
	r := e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"pr": map[string]any{"provider": "github", "url": "https://github.com/acme/pay/pull/9", "number": 9, "state": "open"}})
	check(t, "a patrol may not open a PR", r.status == 403, r)
	r = e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "nothing", "summary": "主干是绿的"})
	check(t, "nothing: the task is over", r.status == 200 && e.task(id)["state"] == "done" && e.task(id)["status"] == "done", r)
	check(t, "no message in the channel, nothing to read", len(e.channelTexts()) == before)
	check(t, "nobody's inbox has it", len(e.inbox(e.zw.session)) == 0 && len(e.inbox(e.wl.session)) == 0)
	runs := e.dutyRuns(e.zw.session, "channel="+e.cid+"&agent="+e.aid+"&duty="+url.QueryEscape("看住 主干"))
	check(t, "one line in the duty's history: nothing found", len(runs) == 1 && runs[0]["outcome"] == "nothing" && runs[0]["note"] == "主干是绿的" && runs[0]["task_id"] == id, resp{raw: []byte(fmt.Sprint(runs))})
	tv = e.do("GET", "/api/v1/triggers?channel="+e.cid, e.zw.session, nil).body["triggers"].([]any)[0].(map[string]any)
	check(t, "the panel counts the last seven days", fmt.Sprint(tv["recent"]) == "map[nothing:1]", resp{raw: []byte(fmt.Sprint(tv))})

	// the next one speaks: the agent's own words open the thread as root (never a fake ⚡ user message)
	e.advance(6 * time.Hour) // 16:00: the 15:00 one
	e.h.Tick()
	id2 := e.do("GET", "/api/v1/tasks?state=queued", e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	tok := e.do("POST", "/api/v1/tasks/"+id2+"/claim", e.token, nil).body["read_token"].(string)
	e.do("POST", "/api/v1/tasks/"+id2+"/report", e.token, map[string]any{"reaction": "🔍"})
	check(t, "a patrol may not hand work on", e.do("POST", "/api/v1/agent/handoff", tok, map[string]any{"text": "@liuli 看一下"}).status == 403)
	check(t, "nor delegate", e.do("POST", "/api/v1/agent/delegate", tok, map[string]any{"text": "@acha 修一下"}).status == 403)
	check(t, "still quiet", len(e.channelTexts()) == before && e.task(id2)["quiet"] == true)
	check(t, "it says something", e.do("POST", "/api/v1/agent/say", tok, map[string]any{"text": "主干红了，在查"}).status == 200)
	texts := e.channelTexts()
	check(t, "the agent's own message is in the channel now without ⚡", len(texts) == before+1 && texts[len(texts)-1] == "主干红了，在查", resp{raw: []byte(fmt.Sprint(texts))})
	root := e.task(id2)["thread_id"].(string)
	rs := e.do("GET", "/api/v1/messages/"+root+"/thread", e.zw.session, nil).body
	rootMsg := rs["root"].(map[string]any)
	check(t, "under the id the task had, authored by the agent", rootMsg["id"] == root && rootMsg["author"].(map[string]any)["kind"] == "agent" &&
		rootMsg["text"] == "主干红了，在查" && e.task(id2)["quiet"] == nil, resp{raw: []byte(fmt.Sprint(rs))})
	r = e.do("POST", "/api/v1/tasks/"+id2+"/report", e.token, map[string]any{"state": "review", "summary": "CI 红在 test_refund，原因是时区", "answer": true})
	check(t, "it reports in the thread", r.status == 200 && e.lastReply(root) == "CI 红在 test_refund，原因是时区", r)
	runs = e.dutyRuns(e.zw.session, "trigger="+a2)
	check(t, "its line: it spoke", len(runs) == 1 && runs[0]["outcome"] == "spoke", resp{raw: []byte(fmt.Sprint(runs))})
	check(t, "both triggers' lines in the duty's history, newest first", len(e.dutyRuns(e.zw.session, "channel="+e.cid+"&agent="+e.aid+"&duty="+url.QueryEscape("看住 主干"))) == 2)

	// a patrol that fails is not silent: its failure message opens the thread
	e.advance(18 * time.Hour) // next day 10:00
	e.h.Tick()
	id3 := e.do("GET", "/api/v1/tasks?state=queued", e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	e.do("POST", "/api/v1/tasks/"+id3+"/claim", e.token, nil)
	e.do("POST", "/api/v1/tasks/"+id3+"/report", e.token, map[string]any{"state": "failed", "summary": "运行失败：仓库打不开"})
	root3 := e.do("GET", "/api/v1/messages/"+e.task(id3)["thread_id"].(string)+"/thread", e.zw.session, nil).body["root"].(map[string]any)
	check(t, "a failed patrol is not silent", e.task(id3)["quiet"] == nil && root3["text"] == "运行失败：仓库打不开")
	runs = e.dutyRuns(e.zw.session, "trigger="+a1)
	check(t, "and counts as failed", runs[0]["outcome"] == "failed", resp{raw: []byte(fmt.Sprint(runs))})

	// pause the duty: both stop; resume: both go on
	check(t, "a bystander can't pause it", e.do("POST", "/api/v1/triggers/duty", e.ll.session, map[string]any{"channel_id": e.cid, "agent_id": e.aid, "duty": "看住 主干", "enabled": false}).status == 403)
	r = e.do("POST", "/api/v1/triggers/duty", e.zw.session, map[string]any{"channel_id": e.cid, "agent_id": e.aid, "duty": "看住 主干", "enabled": false})
	check(t, "an admin pauses the duty", r.status == 200 && len(r.body["triggers"].([]any)) == 2, r)
	for _, x := range e.do("GET", "/api/v1/triggers?channel="+e.cid, e.zw.session, nil).body["triggers"].([]any) {
		check(t, "every trigger of it is off", x.(map[string]any)["enabled"] == false)
	}
	n := len(e.do("GET", "/api/v1/tasks", e.zw.session, nil).body["tasks"].([]any))
	e.advance(24 * time.Hour)
	e.h.Tick()
	check(t, "paused: nothing fires", len(e.do("GET", "/api/v1/tasks", e.zw.session, nil).body["tasks"].([]any)) == n)
	e.do("POST", "/api/v1/triggers/duty", e.wl.session, map[string]any{"channel_id": e.cid, "agent_id": e.aid, "duty": "看住 主干", "enabled": true})
	e.advance(24 * time.Hour)
	e.h.Tick()
	check(t, "resumed: it fires again", len(e.do("GET", "/api/v1/tasks", e.zw.session, nil).body["tasks"].([]any)) > n)

	// a trigger that is not read-only also wakes silently (ADR 0003), may open PRs, and stays silent on nothing
	old := mk("11:00", "", map[string]any{"readonly": false})
	before = len(e.channelTexts())
	e.do("POST", "/api/v1/triggers/duty", e.zw.session, map[string]any{"channel_id": e.cid, "agent_id": e.aid, "duty": "看住 主干", "enabled": false})
	for _, x := range e.do("GET", "/api/v1/tasks?state=queued", e.zw.session, nil).body["tasks"].([]any) {
		e.do("POST", "/api/v1/tasks/"+x.(map[string]any)["id"].(string)+"/cancel", e.zw.session, nil)
	}
	e.advance(24 * time.Hour)
	e.h.Tick()
	ts = e.do("GET", "/api/v1/tasks?state=queued", e.zw.session, nil).body["tasks"].([]any)
	check(t, "the plain trigger fired once", len(ts) == 1 && ts[0].(map[string]any)["mandate"].(map[string]any)["trigger"] == old, resp{raw: []byte(fmt.Sprint(ts))})
	plain := ts[0].(map[string]any)
	check(t, "wakes quietly without a message, not read-only", len(e.channelTexts()) == before && plain["readonly"] == nil && plain["quiet"] == true)
	cl = e.do("POST", "/api/v1/tasks/"+plain["id"].(string)+"/claim", e.token, nil)
	r = e.do("POST", "/api/v1/tasks/"+plain["id"].(string)+"/report", e.token, map[string]any{"pr": map[string]any{"provider": "github", "url": "https://github.com/acme/pay/pull/10", "number": 10, "state": "open"}})
	check(t, "a non-readonly trigger may open a PR", cl.status == 200 && r.status == 200, cl, r)
	r = e.do("POST", "/api/v1/tasks/"+plain["id"].(string)+"/report", e.token, map[string]any{"state": "nothing", "summary": "无需发消息"})
	check(t, "and a silent firing may report nothing", r.status == 200, r)
	human := e.post(e.wl.session, "@acha 看一下", "")
	humanID := e.do("GET", "/api/v1/tasks?thread="+human["id"].(string), e.wl.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	check(t, "owner's request starts", e.do("POST", "/api/v1/tasks/"+humanID+"/claim", e.token, nil).status == 200)
	r = e.do("POST", "/api/v1/tasks/"+humanID+"/report", e.token, map[string]any{"state": "nothing"})
	check(t, "a human @ request cannot report nothing", r.status == 400, r)
	r = e.do("PATCH", "/api/v1/triggers/"+old, e.wl.session, map[string]any{"duty": "日常", "readonly": true})
	check(t, "a trigger's duty and read-only switch can be changed", r.status == 200 && r.body["duty"] == "日常" && r.body["readonly"] == true, r)
	check(t, "removing a trigger removes its history", e.do("DELETE", "/api/v1/triggers/"+old, e.wl.session, nil).status == 200 &&
		e.h.count("SELECT COUNT(*) FROM trigger_runs WHERE trigger_id = ?", old) == 0)
}

func TestDutyHistoryIsPrivate(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	e.do("PATCH", "/api/v1/channels/"+e.cid, e.zw.session, map[string]any{"private": true})
	e.do("DELETE", "/api/v1/channels/"+e.cid+"/members/user/"+e.ll.id, e.zw.session, nil)
	r := e.do("POST", "/api/v1/triggers", e.wl.session, map[string]any{"channel_id": e.cid, "agent": "acha", "kind": "schedule", "when": "9:00", "repeat": "daily", "text": "巡查", "duty": "巡查"})
	check(t, "a duty in a private channel", r.status == 200, r)
	trg := r.body["id"].(string)
	e.advance(10 * time.Hour)
	e.h.Tick()
	check(t, "its member reads the history", len(e.dutyRuns(e.wl.session, "trigger="+trg)) == 1)
	check(t, "someone outside can't", e.dutyRuns(e.ll.session, "trigger="+trg) == nil && e.dutyRuns(e.ll.session, "channel="+e.cid+"&agent="+e.aid+"&duty="+url.QueryEscape("巡查")) == nil)
	check(t, "nor pause it", e.do("POST", "/api/v1/triggers/duty", e.ll.session, map[string]any{"channel_id": e.cid, "agent_id": e.aid, "duty": "巡查", "enabled": false}).status == 404)
}
