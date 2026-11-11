package hub

import "testing"

// A delivery carries evidence per criterion; what the agent left out shows as unstated; nothing is refused.
func TestEvidence(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	m := e.post(e.zw.session, "@acha 看下慢查询\n验收：\n- P99 低于 200ms\n2. 不锁表\n有压测对比", "")
	id := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	r := e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "好了", "run": 1, "evidence": []any{
		map[string]any{"criterion": 1, "how": "ran", "proof": "bench: p99 180ms", "file": "out/bench.png"},
		map[string]any{"criterion": 2, "how": "guess", "proof": "线上才能看"},
		map[string]any{"criterion": 9, "how": "ran"},
	}})
	check(t, "delivered, not refused", r.status == 200 && r.body["state"] == "review", r)
	ev := e.task(id)["evidence"].([]any)
	checkv(t, "three entries, one per criterion", len(ev) == 3, ev)
	e1, e2, e3 := ev[0].(map[string]any), ev[1].(map[string]any), ev[2].(map[string]any)
	checkv(t, "the first ran, its screenshot under out/", e1["how"] == "ran" && e1["proof"] == "bench: p99 180ms" && e1["file"] == "bench.png", e1)
	checkv(t, "an unknown way is not verified", e2["how"] == "not_verified" && e2["criterion"] == float64(2), e2)
	checkv(t, "the third, never mentioned, is unstated", e3["how"] == "unstated" && e3["criterion"] == float64(3), e3)

	// a task with no criteria keeps none, whatever the agent says
	m = e.post(e.zw.session, "@acha 几点了", "")
	id = e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "三点", "run": 1, "answer": true,
		"evidence": []any{map[string]any{"criterion": 1, "how": "ran"}}})
	checkv(t, "no criteria, no evidence", len(e.task(id)["evidence"].([]any)) == 0, e.task(id)["evidence"])
}

func TestCriteriaOf(t *testing.T) {
	got := criteriaOf("- a\n\n2. b\n（3）c\n* d\n  e  ")
	checkv(t, "bullets and numbers go", len(got) == 5 && got[0] == "a" && got[1] == "b" && got[2] == "c" && got[3] == "d" && got[4] == "e", got)
}
