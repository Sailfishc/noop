package hub

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// Channel answers, "continue talking with @x" (to_agent), and channel TL (Spec §1–§4, ADR 0002).
func TestChannelAnswerContinueAndTL(t *testing.T) {
	e := newTaskEnv(t, "channel", false)

	// 1. Plain answer in a regular channel lands as a top-level message (thread_id == nil).
	m1 := e.post(e.zw.session, "@acha /orders 的超时设的是多少？", "")
	t1 := e.do("GET", "/api/v1/tasks?thread="+m1["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	e.do("POST", "/api/v1/tasks/"+t1+"/claim", e.token, nil)
	e.do("POST", "/api/v1/tasks/"+t1+"/report", e.token, map[string]any{"state": "review", "summary": "默认是 3 秒。", "answer": true, "session": "ses_ch_1", "run": 1})
	top := e.do("GET", "/api/v1/channels/"+e.cid+"/messages", e.zw.session, nil).body["messages"].([]any)
	last := top[len(top)-1].(map[string]any)
	check(t, "channel answer identifies its requester", last["text"] == "默认是 3 秒。" && last["thread_id"] == nil && last["answer_to"] == e.zw.id, resp{raw: []byte(fmt.Sprint(top))})

	// 2. Posting with to_agent ("继续和 @acha 聊") addresses @acha without writing @acha in text, and shares the session.
	e.advance(30 * time.Second)
	m2 := e.do("POST", "/api/v1/channels/"+e.cid+"/messages", e.zw.session, map[string]any{"text": "重试几次？", "to_agent": e.aid}).body
	check(t, "text stays clean, mention recorded", m2["text"] == "重试几次？" && len(m2["mentions"].([]any)) == 1, resp{raw: []byte(fmt.Sprint(m2))})
	t2 := e.do("GET", "/api/v1/tasks?thread="+m2["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	c2 := e.do("POST", "/api/v1/tasks/"+t2+"/claim", e.token, nil).body
	check(t, "reuses conversation session", c2["task"].(map[string]any)["session"] == "ses_ch_1", resp{raw: []byte(fmt.Sprint(c2["task"]))})
	e.do("POST", "/api/v1/tasks/"+t2+"/report", e.token, map[string]any{"state": "review", "summary": "最多 2 次。", "answer": true, "session": "ses_ch_1", "run": 1})

	// 3. Configure @acha as the channel's TL; two unaddressed messages within 20s merge into one wake.
	r := e.do("PATCH", "/api/v1/channels/"+e.cid, e.zw.session, map[string]any{"tl": e.aid})
	check(t, "channel TL set", r.status == 200 && r.body["tl"] == e.aid, r)

	u1 := e.post(e.wl.session, "今天预发环境是不是有点慢", "")
	e.advance(5 * time.Second)
	e.h.Tick()
	check(t, "before 20s: TL not woken yet", len(e.do("GET", "/api/v1/tasks?state=queued", e.zw.session, nil).body["tasks"].([]any)) == 0)

	u2 := e.post(e.wl.session, "刚点了两次结算都转圈", "")
	_ = u1
	e.advance(20 * time.Second)
	e.h.Tick()
	qs := e.do("GET", "/api/v1/tasks?state=queued", e.zw.session, nil).body["tasks"].([]any)
	check(t, "after 20s: one merged TL wake", len(qs) == 1, resp{raw: []byte(fmt.Sprint(qs))})
	tlTask := qs[0].(map[string]any)["id"].(string)
	cl := e.do("POST", "/api/v1/tasks/"+tlTask+"/claim", e.token, nil).body
	firing := cl["firing"].(map[string]any)
	check(t, "TL firing carries both burst lines", firing["kind"] == "tl" &&
		strings.Contains(firing["text"].(string), "预发环境") &&
		strings.Contains(firing["text"].(string), "转圈") &&
		cl["task"].(map[string]any)["thread_id"] == u2["id"], resp{raw: []byte(fmt.Sprint(cl))})

	// 4. TL chooses silence ("nothing"): nothing appears in the channel stream.
	beforeCount := len(e.channelTexts())
	r = e.do("POST", "/api/v1/tasks/"+tlTask+"/report", e.token, map[string]any{"state": "nothing", "summary": "闲聊，不插话", "session": "ses_tl_1", "run": 1})
	check(t, "TL silent nothing accepted", r.status == 200 && r.body["state"] == "done" && len(e.channelTexts()) == beforeCount, r)

	// 5. Explicit @agent does not discard the earlier unaddressed message.
	e.post(e.wl.session, "等一下我问问", "")
	e.advance(5 * time.Second)
	e.post(e.wl.session, "@acha 帮看下预发日志", "")
	e.advance(25 * time.Second)
	e.h.Tick()
	qs2 := e.do("GET", "/api/v1/tasks?state=queued", e.zw.session, nil).body["tasks"].([]any)
	check(t, "explicit @agent preserves pending TL", len(qs2) == 2, resp{raw: []byte(fmt.Sprint(qs2))})
}

func TestTLSeparatesSendersAndIgnoresHumanMentions(t *testing.T) {
	e := newTaskEnv(t, "owner", false)
	e.do("PATCH", "/api/v1/channels/"+e.cid, e.wl.session, map[string]any{"tl": e.aid})
	first := e.post(e.wl.session, "主人第一句", "")
	e.post(e.zw.session, "无权限的人要求删除文件", "")
	second := e.post(e.wl.session, "主人第二句", "")
	e.post(e.wl.session, "@zhangwei 这是给你的", "")
	e.advance(25 * time.Second)
	e.h.Tick()
	qs := e.do("GET", "/api/v1/tasks?state=queued", e.wl.session, nil).body["tasks"].([]any)
	check(t, "only owner's separate messages wake TL", len(qs) == 2, resp{raw: []byte(fmt.Sprint(qs))})
	for _, x := range qs {
		task := x.(map[string]any)
		f := task["firing"].(map[string]any)
		text := f["text"].(string)
		check(t, "only authorized sender's message in firing", !strings.Contains(text, "删除文件") && !strings.Contains(text, "给你的"), resp{raw: []byte(fmt.Sprint(task))})
		check(t, "firing belongs to one owner's message", task["thread_id"] == first["id"] || task["thread_id"] == second["id"], resp{raw: []byte(fmt.Sprint(task))})
	}
}

func TestEmptyPlanClearsTaskChecklist(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	m := e.post(e.wl.session, "@acha 检查计划", "")
	id := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.wl.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	r := e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"plan": []any{map[string]any{"text": "检查", "status": "in_progress"}}})
	check(t, "initial plan accepted", r.status == 200, r)
	r = e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"plan": []any{}})
	check(t, "empty plan accepted", r.status == 200, r)
	task := e.task(id)
	plan, ok := task["plan"].([]any)
	check(t, "empty plan persisted", !ok || len(plan) == 0)
}
