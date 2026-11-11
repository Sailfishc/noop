package hub

import (
	"strings"
	"testing"
	"time"
)

// A personal agent on two of its owner's computers: new work goes to the first that can take it, a task stays on the
// one that took it, the list holds only the owner's own computers.
func TestAgentOnSeveralMachines(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	laptop, laptopToken := e.mid, e.token
	r := e.do("POST", "/api/v1/machines", e.wl.session, map[string]any{"name": "王磊的台式机"})
	desk, deskToken := r.body["machine"].(map[string]any)["id"].(string), r.body["token"].(string)
	report := func(token string) {
		e.do("PUT", "/api/v1/machine", token, map[string]any{"runtimes": []any{"codex"}, "max_sessions": 2,
			"runtime_info": []any{map[string]any{"name": "codex", "installed": true, "logged_in": true}}})
	}
	report(laptopToken)
	report(deskToken)
	offered := func(token, id string) bool {
		for _, x := range e.do("GET", "/api/v1/machine/tasks", token, nil).body["tasks"].([]any) {
			if x.(map[string]any)["id"] == id {
				return true
			}
		}
		return false
	}
	claim := func(token, id string) resp { return e.do("POST", "/api/v1/tasks/"+id+"/claim", token, nil) }
	report2 := func(token, id string, b map[string]any) resp {
		return e.do("POST", "/api/v1/tasks/"+id+"/report", token, b)
	}
	newTask := func(text string) (string, string) {
		m := e.post(e.wl.session, text, "")
		ts := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.wl.session, nil).body["tasks"].([]any)
		return ts[0].(map[string]any)["id"].(string), m["id"].(string)
	}

	// the list: the owner's own computers, in order
	r = e.do("PATCH", "/api/v1/agents/"+e.aid, e.wl.session, map[string]any{"machines": []any{laptop, desk}})
	check(t, "two computers, the laptop first", r.status == 200 && r.body["machine_id"] == laptop &&
		len(r.body["machines"].([]any)) == 2 && r.body["machines"].([]any)[1] == desk, r)
	zwMac := e.do("GET", "/api/v1/machines", e.zw.session, nil).body["machines"].([]any)
	var other string
	for _, m := range zwMac {
		if mm := m.(map[string]any); mm["owner_id"] == e.zw.id {
			other = mm["id"].(string)
		}
	}
	r = e.do("PATCH", "/api/v1/agents/"+e.aid, e.wl.session, map[string]any{"machines": []any{laptop, other}})
	check(t, "not someone else's computer", r.status == 400, r)
	check(t, "and the list is as it was", len(e.do("GET", "/api/v1/agents", e.wl.session, nil).body["agents"].([]any)[0].(map[string]any)["machines"].([]any)) == 2)

	// both on: the first one takes new work
	id1, thread1 := newTask("@acha 第一件事")
	check(t, "the laptop sees it, the desktop does not", offered(laptopToken, id1) && !offered(deskToken, id1))
	check(t, "the desktop cannot take it", claim(deskToken, id1).status == 409)

	// the laptop closed: after it counts as offline, the desktop takes new work
	e.advance(machineOnlineSpan + time.Minute)
	report(deskToken)
	check(t, "the laptop's task, unclaimed, now goes to the desktop", offered(deskToken, id1))
	r = claim(deskToken, id1)
	check(t, "the desktop takes it", r.status == 200, r)
	report2(deskToken, id1, map[string]any{"state": "review", "summary": "好了"})

	// the laptop back: a follow-up on that task stays on the desktop
	report(laptopToken)
	e.post(e.wl.session, "再改一下标题", thread1)
	check(t, "the follow-up is queued", e.task(id1)["state"] == "queued")
	check(t, "for the desktop only", offered(deskToken, id1) && !offered(laptopToken, id1))
	check(t, "the laptop cannot take it", claim(laptopToken, id1).status == 409)
	check(t, "the desktop can", claim(deskToken, id1).status == 200)
	report2(deskToken, id1, map[string]any{"state": "review", "summary": "改好了"})

	// the laptop's codex waits for its limit: new work goes to the desktop
	id2, _ := newTask("@acha 第二件事")
	check(t, "the laptop first again", offered(laptopToken, id2) && !offered(deskToken, id2))
	claim(laptopToken, id2)
	report2(laptopToken, id2, map[string]any{"state": "waiting", "failure": "quota", "retry_at": e.h.nowMs() + time.Hour.Milliseconds()})
	id3, _ := newTask("@acha 第三件事")
	check(t, "the laptop is out of quota: the desktop takes new work", offered(deskToken, id3) && !offered(laptopToken, id3) && claim(deskToken, id3).status == 200)
	check(t, "the waiting task stays on the laptop", e.task(id2)["claimed_by"] == laptop && e.task(id2)["state"] == "waiting")

	// neither can: queued; whichever comes back first takes it, once
	report2(deskToken, id3, map[string]any{"state": "waiting", "failure": "quota", "retry_at": e.h.nowMs() + 2*time.Hour.Milliseconds()})
	id4, _ := newTask("@acha 第四件事")
	check(t, "both out: nobody is offered it", !offered(laptopToken, id4) && !offered(deskToken, id4))
	check(t, "it waits in the queue", e.task(id4)["state"] == "queued")
	e.do("POST", "/api/v1/tasks/"+id3+"/cancel", e.wl.session, nil)
	e.h.putRuntimeStatus(desk, "codex", nil) // the desktop's account got its quota back
	check(t, "the desktop came back first: it takes it", offered(deskToken, id4) && !offered(laptopToken, id4))
	check(t, "once", claim(deskToken, id4).status == 200 && claim(laptopToken, id4).status == 409)

	// a private channel: every computer of the agent reads it, no other machine does
	r = e.do("POST", "/api/v1/channels", e.wl.session, map[string]any{"name": "私房 okapi", "private": true, "members": []any{map[string]any{"kind": "agent", "id": e.aid}}})
	pid := r.body["id"].(string)
	for name, tok := range map[string]string{"laptop": laptopToken, "desktop": deskToken} {
		check(t, "the "+name+" reads the private channel", e.do("GET", "/api/v1/channels/"+pid+"/messages", tok, nil).status == 200)
	}
	check(t, "another machine does not", e.do("GET", "/api/v1/channels/"+pid+"/messages", e.otherToken, nil).status != 200)

	// the desktop removed: the agent is on the laptop alone
	e.do("DELETE", "/api/v1/machines/"+desk, e.wl.session, nil)
	a := e.do("GET", "/api/v1/agents", e.wl.session, nil).body["agents"].([]any)[0].(map[string]any)
	check(t, "the removed computer leaves the list", len(a["machines"].([]any)) == 1 && a["machine_id"] == laptop, resp{body: a})
}

// A team machine's agent has that one machine; several are for a person's own computers.
func TestTeamAgentStaysOnOne(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	r := e.do("POST", "/api/v1/machines", e.zw.session, map[string]any{"name": "团队机器"})
	box := r.body["machine"].(map[string]any)["id"].(string)
	e.do("PATCH", "/api/v1/machines/"+box, e.zw.session, map[string]any{"team": true})
	r = e.do("POST", "/api/v1/agents", e.zw.session, map[string]any{"handle": "bot", "name": "机器人", "machines": []any{box}})
	check(t, "a team agent on the team machine", r.status == 200 && r.body["machine_id"] == box && r.body["dispatch"] == "team", r)
	own := ""
	for _, m := range e.do("GET", "/api/v1/machines", e.zw.session, nil).body["machines"].([]any) {
		if mm := m.(map[string]any); mm["owner_id"] == e.zw.id && mm["id"] != box {
			own = mm["id"].(string)
		}
	}
	r = e.do("PATCH", "/api/v1/agents/"+r.body["id"].(string), e.zw.session, map[string]any{"machines": []any{box, own}})
	check(t, "no second computer for it", r.status == 400 && strings.Contains(r.body["error"].(string), "团队机器"), r)
	r = e.do("PATCH", "/api/v1/agents/"+e.aid, e.wl.session, map[string]any{"machines": []any{e.mid, e.mid}})
	check(t, "a computer once", r.status == 400, r)
}
