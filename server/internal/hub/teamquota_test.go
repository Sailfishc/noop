package hub

import (
	"testing"
	"time"
)

func TestQuotaWait(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	newTask := func(text string) (string, string) {
		m := e.post(e.wl.session, text, "")
		return e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string), m["id"].(string)
	}
	claim := func(id string) resp { return e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil) }
	report := func(id string, b map[string]any) resp { return e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, b) }
	offered := func(id string) bool {
		for _, x := range e.do("GET", "/api/v1/machine/tasks", e.token, nil).body["tasks"].([]any) {
			if x.(map[string]any)["id"] == id {
				return true
			}
		}
		return false
	}
	replies := func(thread string) int {
		n := 0
		for _, m := range e.do("GET", "/api/v1/channels/"+e.cid+"/messages?thread="+thread, e.wl.session, nil).body["messages"].([]any) {
			if m.(map[string]any)["author"].(map[string]any)["kind"] == "agent" {
				n++
			}
		}
		return n
	}

	// the limit names a time: the task waits for it, and nobody is called
	id, thread := newTask("@acha 改一下订单导出")
	claim(id)
	report(id, map[string]any{"session": "thr_1"})
	now := e.h.nowMs()
	at := now + 2*time.Hour.Milliseconds()
	r := report(id, map[string]any{"state": "waiting", "failure": "quota", "retry_at": at, "note": "You've hit your 5-hour limit · resets 3pm"})
	w, _ := r.body["wait"].(map[string]any)
	check(t, "it waits for the runtime's limit", r.status == 200 && r.body["state"] == "waiting" && w["how"] == "quota" &&
		w["expect"] == float64(at) && w["next_at"] == float64(at+quotaMargin.Milliseconds()) && w["machine"] == e.mid && w["runtime"] == "codex", r)
	check(t, "no failure counted, the session kept", r.body["failures"] == float64(0) && r.body["session"] == "thr_1", r)
	check(t, "nothing said in the thread", replies(thread) == 0)
	check(t, "nobody's inbox, no call on a person", len(e.inbox(e.wl.session)) == 0 && len(r.body["calls"].([]any)) == 0, r)
	e.advance(time.Second) // what follows happens after the run hit the limit
	st := e.runtimeStatus(e.wl.session, "codex")
	check(t, "the machine card says codex waits for its limit", st != nil && st["state"] == "quota" && st["until"] == float64(at) && st["text"] == "等额度恢复", resp{body: st})

	// the runtime's other tasks on that machine wait too, without trying
	id2, _ := newTask("@acha 再看下退款")
	check(t, "another task is not offered", !offered(id2) && claim(id2).status == 409)

	e.advance(time.Hour)
	e.h.Tick()
	check(t, "before the time nothing wakes", e.task(id)["state"] == "waiting")
	e.advance(time.Hour + 2*time.Minute)
	e.h.Tick()
	tk := e.task(id)
	check(t, "at the time, the waiting task tries first", tk["state"] == "queued" && offered(id) && !offered(id2), resp{body: tk})
	r = claim(id)
	check(t, "in the same session, told why it woke", r.status == 200 && r.body["wake"].(map[string]any)["reason"] == "quota" && r.body["task"].(map[string]any)["session"] == "thr_1", r)
	check(t, "the other one still waits for it", claim(id2).status == 409)
	report(id, map[string]any{"state": "review", "summary": "改好了"})
	check(t, "it got through: the runtime takes work again", e.runtimeStatus(e.wl.session, "codex") == nil && offered(id2) && claim(id2).status == 200)

	// no time given: 5 minutes, 15 minutes, an hour, then every hour
	steps := []time.Duration{5 * time.Minute, 15 * time.Minute, time.Hour, time.Hour}
	for _, d := range steps {
		now = e.h.nowMs()
		r = report(id2, map[string]any{"state": "waiting", "failure": "quota"})
		w = r.body["wait"].(map[string]any)
		check(t, "tries again after "+d.String(), r.status == 200 && w["expect"] == nil && w["next_at"] == float64(now+d.Milliseconds()), r)
		e.advance(d)
		e.h.Tick()
		check(t, "and wakes then", e.task(id2)["state"] == "queued" && claim(id2).status == 200)
	}

	// 「现在就试」 and a reply both try at once; cancel ends it
	r = report(id2, map[string]any{"state": "waiting", "failure": "quota"})
	check(t, "only its people press it", e.do("POST", "/api/v1/tasks/"+id2+"/retry", e.zw.session, nil).status == 200) // admin
	check(t, "it tries now", e.task(id2)["state"] == "queued" && claim(id2).status == 200)
	report(id2, map[string]any{"state": "waiting", "failure": "quota"})
	e.advance(time.Second)
	e.post(e.wl.session, "我换了个账号，再试试", e.task(id2)["thread_id"].(string))
	check(t, "a reply wakes it and lets it try", e.task(id2)["state"] == "queued" && claim(id2).status == 200)
	report(id2, map[string]any{"state": "waiting", "failure": "quota"})
	check(t, "「现在就试」 is only for a limit", e.do("POST", "/api/v1/tasks/"+id+"/retry", e.wl.session, nil).status == 409)

	// a day without getting through: its people are told once, in their inbox; it keeps waiting
	for range 26 {
		e.advance(time.Hour)
		e.h.Tick()
		if e.task(id2)["state"] == "queued" {
			claim(id2)
			report(id2, map[string]any{"state": "waiting", "failure": "quota"})
		}
	}
	tk = e.task(id2)
	check(t, "still waiting, marked as waited long", tk["state"] == "waiting" && tk["wait"].(map[string]any)["stale"] == true, resp{body: tk})
	inbox := func(s string) bool {
		for _, x := range e.inbox(s) {
			if x.(map[string]any)["id"] == id2 {
				return true
			}
		}
		return false
	}
	check(t, "in the inbox of the person who asked and the agent's owner, nobody else's", inbox(e.wl.session) && !inbox(e.ll.session))
	check(t, "cancel ends it", e.do("POST", "/api/v1/tasks/"+id2+"/cancel", e.wl.session, nil).status == 200 && e.task(id2)["state"] == "closed")
}
