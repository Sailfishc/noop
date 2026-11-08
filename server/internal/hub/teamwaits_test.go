package hub

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestTaskWaits(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	m := e.post(e.wl.session, "@acha 用云端服务建一个底座模型", "")
	id := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	r := e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	cb := r.body["callback_url"].(string)
	check(t, "a run gets its callback address", strings.Contains(cb, "/api/v1/hooks/wait/"), r)
	check(t, "and no wake the first time", r.body["wake"] == nil, r)

	// a wait needs a way to wake
	check(t, "waiting without how", e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "waiting", "summary": "x"}).status == 400)
	r = e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "waiting", "summary": "已提交云端建模，预计 2 小时",
		"wait": map[string]any{"how": "poll", "every": 10, "expect": 7200, "deadline": 6 * 3600, "what": "云端建模"}})
	check(t, "waiting", r.status == 200 && r.body["state"] == "waiting", r)
	wt := r.body["wait"].(map[string]any)
	check(t, "polls at least a minute apart", wt["every"] == float64(60) && wt["how"] == "poll")
	check(t, "nobody is told", len(e.inbox(e.wl.session)) == 0 && len(e.inbox(e.zw.session)) == 0)
	r = e.do("GET", "/api/v1/machine/tasks?waiting=1", e.token, nil)
	check(t, "its machine sees what to check", len(r.body["tasks"].([]any)) == 1, r)
	r = e.do("GET", "/api/v1/machine/tasks", e.token, nil)
	check(t, "and it holds no slot", len(r.body["tasks"].([]any)) == 0, r)

	// checks: still going (the next one later), errors, then done wakes it
	r = e.do("POST", "/api/v1/tasks/"+id+"/wait", e.token, map[string]any{"state": "pending", "note": "排队第 3"})
	check(t, "still waiting, checks spread out", r.body["woke"] == false && e.task(id)["wait"].(map[string]any)["every"] == float64(90), r)
	e.do("POST", "/api/v1/tasks/"+id+"/wait", e.token, map[string]any{"error": "timeout"})
	e.do("POST", "/api/v1/tasks/"+id+"/wait", e.token, map[string]any{"error": "timeout"})
	check(t, "two errors: still waiting", e.task(id)["state"] == "waiting")
	r = e.do("POST", "/api/v1/tasks/"+id+"/wait", e.token, map[string]any{"state": "done", "note": "模型好了"})
	check(t, "done wakes it", r.body["woke"] == true && e.task(id)["state"] == "queued" && e.task(id)["step"] == "外部结果好了", r)
	r = e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	wk := r.body["wake"].(map[string]any)
	check(t, "the next run learns why", wk["reason"] == "done" && wk["note"] == "模型好了", r)
	check(t, "and the wait is over", r.body["task"].(map[string]any)["wait"] == nil, r)
	r = e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "模型好了", "result": "confirmed"})
	check(t, "confirmed", r.body["result"] == "confirmed", r)

	// a callback wakes it with what was posted
	e.post(e.wl.session, "再出一个带纹理的版本", m["id"].(string))
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "waiting", "summary": "已提交", "wait": map[string]any{"how": "callback"}})
	r = e.do("POST", strings.TrimPrefix(cb, "http://"+strings.SplitN(strings.TrimPrefix(cb, "http://"), "/", 2)[0]), "", bytes.NewBufferString(`{"job":"job-2","status":"succeeded"}`))
	check(t, "the callback is taken", r.status == 200 && e.task(id)["state"] == "queued", r)
	r = e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	check(t, "with its body", r.body["wake"].(map[string]any)["payload"] == `{"job":"job-2","status":"succeeded"}`, r)
	check(t, "a wrong token", e.do("POST", "/api/v1/hooks/wait/"+strings.Repeat("0", 40), "", nil).status == 404)

	// a timer, then the deadline; a person's word wakes it too
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "waiting", "summary": "已提交", "wait": map[string]any{"how": "timer", "expect": 600, "deadline": 3600}})
	e.h.Tick()
	check(t, "not yet", e.task(id)["state"] == "waiting")
	e.advance(11 * time.Minute)
	e.h.Tick()
	check(t, "the timer wakes it", e.task(id)["state"] == "queued" && e.task(id)["step"] == "到时间了，去看结果")
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "waiting", "summary": "还没好", "wait": map[string]any{"how": "callback", "deadline": 600}})
	e.advance(11 * time.Minute)
	e.h.Tick()
	check(t, "the deadline wakes it", e.task(id)["state"] == "queued" && e.task(id)["step"] == "等到截止时间了，最后确认一次")
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "waiting", "summary": "等", "wait": map[string]any{"how": "callback"}})
	e.post(e.wl.session, "不用等了", m["id"].(string))
	r = e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	check(t, "a person's word wakes it", r.status == 200 && r.body["wake"].(map[string]any)["reason"] == "message" && len(r.body["new"].([]any)) == 1, r)
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "waiting", "summary": "等", "wait": map[string]any{"how": "callback"}})
	check(t, "a waiting task can be cancelled", e.do("POST", "/api/v1/tasks/"+id+"/cancel", e.wl.session, nil).status == 200)
}
