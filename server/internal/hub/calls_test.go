package hub

import (
	"testing"
	"time"
)

// Each time a task needs a person is recorded with who and why; the task carries its calls, each counted as one of
// the three moments or outside them; the metrics page counts them for the reader and, without private channels, for
// the team.
func TestCalls(t *testing.T) {
	e := newTaskEnv(t, "channel", true) // @acha is 王磊's and he confirms work others ask of it
	m := e.post(e.zw.session, "@acha 重写退款对账", "")
	root := m["id"].(string)
	id := e.do("GET", "/api/v1/tasks?thread="+root, e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	e.do("POST", "/api/v1/tasks/"+id+"/confirm", e.wl.session, nil)
	run := func(report map[string]any) string {
		r := e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
		if r.status != 200 {
			t.Fatalf("claim: %d %s", r.status, r.raw)
		}
		tok := r.body["read_token"].(string)
		if report != nil {
			report["run"] = e.task(id)["runs"]
			if r := e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, report); r.status != 200 {
				t.Fatalf("report: %d %s", r.status, r.raw)
			}
		}
		return tok
	}
	tok := run(nil)
	e.do("POST", "/api/v1/agent/ask", tok, map[string]any{"text": "@liuli 对账以哪边为准？"})
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "needs_decision", "summary": "两种做法",
		"decision": map[string]any{"question": "全量还是增量？", "options": []any{"全量", "增量"}}, "run": e.task(id)["runs"]})
	check(t, "decided", e.do("POST", "/api/v1/tasks/"+id+"/decide", e.zw.session, map[string]any{"choice": "增量"}).status == 200)
	run(map[string]any{"state": "blocked", "summary": "没有对账库的权限"})
	e.post(e.zw.session, "权限给你了", root)
	run(map[string]any{"state": "review", "summary": "好了"})
	e.post(e.zw.session, "金额要按分算", root)
	run(map[string]any{"state": "review", "summary": "改了"})

	tk := e.task(id)
	calls := tk["calls"].([]any)
	type c struct{ who, kind, class string }
	want := []c{{e.wl.id, "confirm", "decide"}, {e.ll.id, "ask", "decide"}, {e.zw.id, "decide", "decide"}, {e.zw.id, "unblock", "outside"},
		{e.zw.id, "accept", "accept"}, {e.zw.id, "accept", "outside"}}
	checkv(t, "six calls", len(calls) == len(want), calls)
	for i, w := range want {
		x := calls[i].(map[string]any)
		checkv(t, "call "+w.kind, x["who"] == w.who && x["kind"] == w.kind && x["class"] == w.class, x)
	}
	for _, ev := range tk["events"].([]any) {
		n := ev.(map[string]any)["needs"]
		checkv(t, "the status timeline has no side calls and no accept kind", n != "ask" && n != "accept", ev)
	}

	// a private channel of 张伟's with his own agent: a task there needs him to accept it
	zwa := e.zwAgent("bei")
	pr := e.do("POST", "/api/v1/channels", e.zw.session, map[string]any{"name": "我的", "private": true,
		"members": []any{map[string]any{"kind": "agent", "id": zwa}}})
	pm := e.do("POST", "/api/v1/channels/"+pr.body["id"].(string)+"/messages", e.zw.session, map[string]any{"text": "@bei 整理周报"})
	pid := e.do("GET", "/api/v1/tasks?thread="+pm.body["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	zwTok := e.otherToken // 张伟's machine
	check(t, "claimed", e.do("POST", "/api/v1/tasks/"+pid+"/claim", zwTok, nil).status == 200)
	e.do("POST", "/api/v1/tasks/"+pid+"/report", zwTok, map[string]any{"state": "review", "summary": "好了", "run": 1})

	e.advance(time.Hour)
	r := e.do("GET", "/api/v1/metrics?days=7", e.zw.session, nil)
	mine, team := r.body["mine"].(map[string]any), r.body["team"].(map[string]any)
	byClass := mine["by_class"].(map[string]any)
	checkv(t, "张伟's own: decide, unblock, two accepts here and one accept in his private channel", mine["calls"] == float64(5) &&
		mine["tasks"] == float64(2) && mine["outside"] == float64(2) && byClass["accept"] == float64(2) && byClass["decide"] == float64(1), mine)
	checkv(t, "the team's: the public task's six calls, nothing from the private channel", team["calls"] == float64(6) &&
		team["tasks"] == float64(1) && team["outside"] == float64(2), team)
	r = e.do("GET", "/api/v1/metrics?days=7", e.wl.session, nil)
	checkv(t, "王磊 sees his own (one confirm), not 张伟's", r.body["mine"].(map[string]any)["calls"] == float64(1), r.body["mine"])

	e.advance(8 * 24 * time.Hour)
	r = e.do("GET", "/api/v1/metrics?days=7", e.zw.session, nil)
	checkv(t, "a week later the window is empty", r.body["mine"].(map[string]any)["calls"] == float64(0), r.body["mine"])
}

// checkv: check, showing a value when it fails.
func checkv(t *testing.T, name string, ok bool, v any) {
	t.Helper()
	if !ok {
		t.Errorf("%s — %v", name, v)
	}
}
