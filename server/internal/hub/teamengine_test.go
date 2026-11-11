package hub

import (
	"strings"
	"testing"
	"time"
)

// 换引擎继续: Codex's limit resets in two hours and Claude Code on the same computer can take work: after a while the
// agent's owner gets one card; keeping waits; switching runs this task (only) with Claude Code, its default model, in a
// fresh session on the same computer. A limit that resets soon asks nobody; the runtime back withdraws the card.
func TestEngineCard(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	both := func(claudeOK bool) {
		e.do("PUT", "/api/v1/machine", e.token, map[string]any{"runtimes": []any{"codex", "claude"}, "max_sessions": 2,
			"runtime_info": []any{map[string]any{"name": "codex", "installed": true, "logged_in": true}, map[string]any{"name": "claude", "installed": true, "logged_in": claudeOK}}})
	}
	both(true)
	e.do("PATCH", "/api/v1/agents/"+e.aid, e.wl.session, map[string]any{"model": "gpt-5.5"})
	newTask := func(text string) (string, string) {
		m := e.post(e.wl.session, text, "")
		return e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.wl.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string), m["id"].(string)
	}
	card := func(id string) map[string]any { c, _ := e.task(id)["engine"].(map[string]any); return c }
	limit := func(id string, in time.Duration) {
		e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
		e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"session": "thr_1"})
		at := int64(0)
		if in > 0 {
			at = e.h.nowMs() + in.Milliseconds()
		}
		r := e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "waiting", "failure": "quota", "retry_at": at})
		check(t, "waiting for Codex's limit", r.status == 200 && r.body["state"] == "waiting", r)
	}

	// a limit that resets in 20 minutes: nobody is asked
	soon, _ := newTask("@acha 改一下订单导出")
	limit(soon, 20*time.Minute)
	e.advance(time.Minute)
	both(true)
	e.h.Tick()
	check(t, "a reset soon: no card", card(soon) == nil)
	e.do("POST", "/api/v1/tasks/"+soon+"/cancel", e.wl.session, nil)
	e.h.putRuntimeStatus(e.mid, "codex", nil)

	// two hours: asked at once (the wait is long), of the agent's owner, outside the three moments
	id, thread := newTask("@acha 改一下订单索引")
	limit(id, 2*time.Hour)
	e.advance(time.Minute)
	both(true)
	e.h.Tick()
	c := card(id)
	check(t, "one card: Claude Code on the same computer", c != nil && c["state"] == "proposed" && c["from"] == "codex" && c["to"] == "claude" && c["machine"] == e.mid && c["reason"] == "quota")
	check(t, "the owner has the ball", e.task(id)["holder"].(map[string]any)["why"] == "engine")
	calls := e.task(id)["calls"].([]any)
	check(t, "a call outside align, decide, accept", len(calls) == 1 && calls[0].(map[string]any)["kind"] == "engine" && calls[0].(map[string]any)["class"] == "outside")
	found := false
	for _, x := range e.inbox(e.wl.session) {
		found = found || x.(map[string]any)["id"] == id
	}
	check(t, "on the owner's inbox", found)
	e.h.Tick()
	check(t, "one stop, one card", len(e.task(id)["calls"].([]any)) == 1)
	check(t, "not someone else", e.do("POST", "/api/v1/tasks/"+id+"/engine", e.ll.session, map[string]any{}).status == 403)
	check(t, "not an admin either", e.do("POST", "/api/v1/tasks/"+id+"/engine", e.zw.session, map[string]any{}).status == 403)
	check(t, "not a runtime the computer has not", e.do("POST", "/api/v1/tasks/"+id+"/engine", e.wl.session, map[string]any{"to": "pi"}).status == 400)

	// keep waiting: the card goes; this stop asks no more
	r := e.do("POST", "/api/v1/tasks/"+id+"/engine", e.wl.session, map[string]any{"keep": true})
	check(t, "kept", r.status == 200 && card(id)["state"] == "kept", r)
	e.advance(10 * time.Minute)
	both(true)
	e.h.Tick()
	check(t, "not asked again for this stop", card(id)["state"] == "kept")

	// switch after all: this task runs with Claude Code, the agent stays on Codex
	r = e.do("POST", "/api/v1/tasks/"+id+"/engine", e.wl.session, map[string]any{"to": "claude"})
	check(t, "switched", r.status == 200 && r.body["runtime"] == "claude" && r.body["state"] == "queued" && r.body["session"] == "" && r.body["claimed_by"] == e.mid && card(id)["state"] == "switched", r)
	r = e.do("GET", "/api/v1/messages/"+thread+"/thread", e.wl.session, nil)
	check(t, "the thread says so", strings.Contains(string(r.raw), "这个任务换用 Claude Code 接着做"), r)
	r = e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	ag := r.body["agent"].(map[string]any)
	check(t, "the claim runs it with Claude Code and its default model", r.status == 200 && ag["runtime"] == "claude" && ag["model"] == "", r)
	a, _ := e.h.agent(e.aid)
	check(t, "the agent keeps Codex and its model", a.Runtime == "codex" && a.Model == "gpt-5.5")
	r = e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "Claude Code 做完了"})
	check(t, "its report counts for Claude Code: Codex still waits for its limit", r.status == 200 && e.h.runtimeStatus(e.mid, "codex") != nil && e.h.runtimeStatus(e.mid, "claude") == nil, r)

	// no other runtime can take work: no card; the runtime back: the card withdrawn
	other, _ := newTask("@acha 再看一下退款")
	e.h.putRuntimeStatus(e.mid, "codex", nil)
	limit(other, 0)
	e.advance(6 * time.Minute)
	both(false)
	e.h.Tick() // a limit with no time: tried again after 5 minutes, and it hits the limit again
	check(t, "woken to try", e.task(other)["state"] == "queued")
	e.h.Tick()
	check(t, "trying again is no reason to withdraw or ask", card(other) == nil)
	r = e.do("POST", "/api/v1/tasks/"+other+"/claim", e.token, nil)
	r = e.do("POST", "/api/v1/tasks/"+other+"/report", e.token, map[string]any{"state": "waiting", "failure": "quota"})
	check(t, "waiting again", r.body["state"] == "waiting", r)
	e.advance(10 * time.Minute)
	both(false)
	e.h.Tick()
	check(t, "Claude Code logged out: no card", card(other) == nil)
	both(true)
	e.h.Tick()
	check(t, "then a card (a limit with no time, 15 minutes on)", card(other) != nil && card(other)["state"] == "proposed")
	e.h.runtimeWorked(e.mid, "codex")
	e.h.Tick()
	check(t, "Codex back: the card is withdrawn", card(other)["state"] == "withdrawn" && e.task(other)["runtime"] == "")
	check(t, "and no switch then", e.do("POST", "/api/v1/tasks/"+other+"/engine", e.wl.session, map[string]any{"to": "claude"}).status == 409)
}
