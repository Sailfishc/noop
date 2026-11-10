package hub

import (
	"testing"
	"time"
)

func TestMetrics(t *testing.T) {
	e := newTaskEnv(t, "channel", true)
	first := func(m map[string]any) string {
		return e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	}
	// 张伟 asks @acha (owned by 王磊, who must confirm): 10 minutes to confirm, 3 runs, accepted 2 hours after review
	m := e.post(e.zw.session, "@acha 看下慢查询", "")
	id := first(m)
	e.advance(10 * time.Minute)
	e.do("POST", "/api/v1/tasks/"+id+"/confirm", e.wl.session, nil)
	for i := 0; i < 3; i++ {
		e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
		e.advance(time.Minute)
		e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "好了"})
		if i < 2 {
			e.advance(30 * time.Minute)
			e.post(e.zw.session, "再改改", m["id"].(string))
		}
	}
	e.advance(2 * time.Hour)
	check(t, "accepted", e.do("POST", "/api/v1/tasks/"+id+"/accept", e.zw.session, nil).status == 200)

	// 刘丽 cancels hers and asks again the same afternoon; another cancelled one is not asked again
	m2 := e.post(e.ll.session, "@acha 写个周报", "")
	e.do("POST", "/api/v1/tasks/"+first(m2)+"/cancel", e.ll.session, nil)
	e.advance(time.Hour)
	e.post(e.ll.session, "@acha 写个周报，只列上线的", "")
	m3 := e.post(e.zw.session, "@acha 算了", "")
	e.do("POST", "/api/v1/tasks/"+first(m3)+"/cancel", e.zw.session, nil)

	r := e.do("GET", "/api/v1/metrics?days=7", e.ll.session, nil)
	check(t, "anyone in the team reads them", r.status == 200, r)
	reply := r.body["reply"].(map[string]any)
	by := r.body["reply_by"].(map[string]any)
	confirm := by["confirm"].(map[string]any)
	accept := by["accept"].(map[string]any)
	// the two cancelled while they waited for the owner count as answered at once (the asker took the ball back)
	check(t, "confirm: 10 minutes once; one still waits (刘丽's second ask)", confirm["count"] == float64(3) && confirm["p90"] == float64(10*time.Minute/time.Millisecond) && confirm["open"] == float64(1), r)
	check(t, "review answered three times: twice in 30 minutes, once in 2 hours", accept["count"] == float64(3) &&
		accept["median"] == float64(30*time.Minute/time.Millisecond) && accept["p90"] == float64(2*time.Hour/time.Millisecond), r)
	check(t, "all kinds together", reply["count"] == float64(6) && reply["open"] == float64(1), r)
	runs := r.body["runs"].(map[string]any)
	check(t, "runs per task", runs["tasks"] == float64(1) && runs["median"] == float64(3) && runs["three_plus"] == float64(1), r)
	check(t, "two cancelled, one asked again", r.body["cancelled"] == float64(2) && r.body["redone"] == float64(1), r)
	ag := r.body["agents"].([]any)[0].(map[string]any)
	check(t, "per agent: tasks and the people who asked", ag["tasks"] == float64(4) && ag["people"] == float64(2) && ag["others"] == float64(4) && ag["team"] == false, r)

	e.advance(8 * 24 * time.Hour)
	r = e.do("GET", "/api/v1/metrics", e.ll.session, nil)
	check(t, "a week later the window is empty (the open one still counts as waiting)", r.body["cancelled"] == float64(0) &&
		r.body["runs"].(map[string]any)["tasks"] == float64(0), r)
	check(t, "machines don't read them", e.do("GET", "/api/v1/metrics", e.token, nil).status >= 400)
}
