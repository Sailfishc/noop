package hub

import (
	"strings"
	"testing"
	"time"
)

func TestRunHealth(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	m := e.post(e.wl.session, "@acha 修一下登录", "")
	id := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	agent := func() map[string]any {
		for _, a := range e.do("GET", "/api/v1/agents", e.wl.session, nil).body["agents"].([]any) {
			if a.(map[string]any)["id"] == e.aid {
				return a.(map[string]any)
			}
		}
		return nil
	}
	claim := func() resp { return e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil) }
	report := func(b map[string]any) resp { return e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, b) }

	r := claim()
	check(t, "claimed, run 1", r.status == 200 && r.body["task"].(map[string]any)["runs"] == float64(1), r)
	report(map[string]any{"usage": map[string]any{"input": 100, "cacheRead": 900, "output": 50}})
	r = report(map[string]any{"state": "review", "summary": "修好了", "run": 1, "usage": map[string]any{"input": 10, "cacheWrite": 5, "output": 1}})
	u := r.body["usage"].(map[string]any)
	check(t, "tokens add up", r.status == 200 && u["input"] == float64(110) && u["cache_read"] == float64(900) && u["cache_write"] == float64(5) && u["output"] == float64(51), r)
	r = report(map[string]any{"state": "review", "summary": "修好了", "run": 1})
	check(t, "the same report again is refused, nothing posted twice", r.status == 409, r)

	// a run of an earlier claim cannot end the current one
	e.post(e.wl.session, "再看下注册", m["id"].(string))
	check(t, "claimed again, run 2", claim().body["task"].(map[string]any)["runs"] == float64(2))
	check(t, "run 1's report is stale", report(map[string]any{"state": "failed", "summary": "x", "run": 1}).status == 409)

	// the daemon keeps dying on it: its own machine claims it again; the third time a person gets it
	r = claim()
	check(t, "a restart counts", r.status == 200 && e.task(id)["failures"] == float64(1) && e.task(id)["last_failure"] == "restart", r)
	check(t, "second restart", claim().status == 200)
	r = claim()
	tk := e.task(id)
	check(t, "third: handed to a person", r.status == 409 && tk["state"] == "blocked" && strings.Contains(tk["summary"].(string), "连续 3 次"), r)
	e.post(e.wl.session, "日志看了，再试试", m["id"].(string))
	check(t, "a reply queues it again", e.task(id)["state"] == "queued")
	check(t, "and it runs", claim().status == 200)
	r = report(map[string]any{"state": "review", "summary": "好了", "run": 3})
	check(t, "a good run clears the count", r.status == 200 && r.body["failures"] == float64(0), r)

	// logged out: the runtime on that machine is held back, its tasks wait in the queue instead of failing one after another
	e.post(e.wl.session, "还有个问题", m["id"].(string))
	claim()
	r = report(map[string]any{"state": "blocked", "summary": "codex 没登录", "failure": "auth", "run": 4})
	check(t, "a runtime failure counts", r.status == 200 && r.body["failures"] == float64(1) && r.body["last_failure"] == "auth", r)
	st := e.runtimeStatus(e.wl.session, "codex")
	check(t, "and holds back codex on that machine", st != nil && st["state"] == "blocked" && st["reason"] == "auth" && st["text"] == "没有登录", resp{body: st})
	check(t, "the agent itself is not paused any more", agent()["paused"] == nil)
	m2 := e.post(e.ll.session, "@acha 另一件事", "")
	id2 := e.do("GET", "/api/v1/tasks?thread="+m2["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	check(t, "a held-back runtime's new task stays queued", e.do("POST", "/api/v1/tasks/"+id2+"/claim", e.token, nil).status == 409 && e.task(id2)["state"] == "queued")
	check(t, "and the machine is not offered it", len(e.do("GET", "/api/v1/machine/tasks", e.token, nil).body["tasks"].([]any)) == 0)
	no, yes := false, true
	e.do("PUT", "/api/v1/machine", e.token, map[string]any{"runtimes": []any{"codex"}, "runtime_info": []any{map[string]any{"name": "codex", "installed": true, "logged_in": no}}})
	check(t, "still logged out: still held back", e.runtimeStatus(e.wl.session, "codex") != nil)
	e.do("PUT", "/api/v1/machine", e.token, map[string]any{"runtimes": []any{"codex"}, "runtime_info": []any{map[string]any{"name": "codex", "installed": true, "logged_in": yes}}})
	check(t, "logged in again: it goes on", e.runtimeStatus(e.wl.session, "codex") == nil)
	check(t, "and takes the queued task", e.do("POST", "/api/v1/tasks/"+id2+"/claim", e.token, nil).status == 200)

	// out of credit: no report can tell, so a person asking again lifts it
	r = e.do("POST", "/api/v1/tasks/"+id2+"/report", e.token, map[string]any{"state": "blocked", "summary": "余额不足", "failure": "billing", "run": 1})
	st = e.runtimeStatus(e.wl.session, "codex")
	check(t, "billing holds the runtime back", r.status == 200 && st != nil && st["reason"] == "billing", r)
	e.do("PUT", "/api/v1/machine", e.token, map[string]any{"runtimes": []any{"codex"}, "runtime_info": []any{map[string]any{"name": "codex", "installed": true, "logged_in": yes}}})
	check(t, "a login does not lift it", e.runtimeStatus(e.wl.session, "codex") != nil)
	e.advance(time.Second)
	e.post(e.ll.session, "充好了", m2["id"].(string))
	check(t, "a person's reply lets that task try", e.do("POST", "/api/v1/tasks/"+id2+"/claim", e.token, nil).status == 200)
	e.do("POST", "/api/v1/tasks/"+id2+"/report", e.token, map[string]any{"state": "review", "summary": "好了", "run": 2})
	check(t, "and its run getting through lifts it", e.runtimeStatus(e.wl.session, "codex") == nil)
}

// runtimeStatus: how the agent's machine says its runtime is ("" state: it takes work).
func (e *taskEnv) runtimeStatus(session, runtime string) map[string]any {
	for _, m := range e.do("GET", "/api/v1/machines", session, nil).body["machines"].([]any) {
		mm := m.(map[string]any)
		if mm["id"] != e.mid {
			continue
		}
		st, _ := mm["runtime_status"].(map[string]any)[runtime].(map[string]any)
		return st
	}
	return nil
}
