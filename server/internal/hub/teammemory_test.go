package hub

import (
	"strings"
	"testing"
)

func (e *taskEnv) memoryOf(session string) (string, bool) {
	for _, x := range e.do("GET", "/api/v1/agents", session, nil).body["agents"].([]any) {
		if a := x.(map[string]any); a["id"] == e.aid {
			m, ok := a["memory"].(string)
			return m, ok
		}
	}
	return "", false
}

// Rule one: an agent's memory is read by those who may change it (and its own machine), nobody else.
func TestAgentMemoryReaders(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	wlLive, llLive, zwLive := e.listen(e.wl.id), e.listen(e.ll.id), e.listen(e.zw.id)
	r := e.do("PATCH", "/api/v1/agents/"+e.aid, e.wl.session, map[string]any{"memory": "zebra: 王磊爱吃辣"})
	check(t, "its owner writes its memory", r.status == 200 && r.body["memory"] == "zebra: 王磊爱吃辣", r)
	m, ok := e.memoryOf(e.wl.session)
	check(t, "its owner reads it", ok && m == "zebra: 王磊爱吃辣")
	_, ok = e.memoryOf(e.ll.session)
	check(t, "a member gets the agent without it", !ok)
	_, ok = e.memoryOf(e.zw.session)
	check(t, "so does an admin, for a personal agent", !ok)
	r = e.do("GET", "/api/v1/me", e.token, nil)
	check(t, "its machine has it", strings.Contains(string(r.raw), "zebra"), r)
	check(t, "the owner's live frame has it", strings.Contains(wlLive.all(), "zebra"))
	check(t, "others' live frames don't", !strings.Contains(llLive.all(), "zebra") && !strings.Contains(zwLive.all(), "zebra"))
	check(t, "but they do hear that it changed", strings.Contains(llLive.all(), e.aid))

	// on a team machine: its responsible person and the admins
	e.do("PATCH", "/api/v1/machines/"+e.mid, e.zw.session, map[string]any{"team": true})
	_, ok = e.memoryOf(e.zw.session)
	check(t, "a team agent's memory: an admin reads it", ok)
	_, ok = e.memoryOf(e.ll.session)
	check(t, "a member still doesn't", !ok)
	e.do("PATCH", "/api/v1/agents/"+e.aid, e.wl.session, map[string]any{"memory": "zebra 2"})
	check(t, "its frame with the memory goes to the admin", strings.Contains(zwLive.all(), "zebra 2"))
	check(t, "and not to the member", !strings.Contains(llLive.all(), "zebra"))
}

// Rule two: in a private channel, only a personal agent whose owner is in it may change its memory; elsewhere the
// report's memory is dropped, and the claim says so.
func TestAgentMemoryInPrivateChannels(t *testing.T) {
	e := newTaskEnv(t, "team", false)
	run := func(session, channel, text, memory string) map[string]any {
		t.Helper()
		r := e.do("POST", "/api/v1/channels/"+channel+"/messages", session, map[string]any{"text": "@acha " + text})
		check(t, "posted", r.status == 200, r)
		ts := e.do("GET", "/api/v1/tasks?thread="+r.body["id"].(string), session, nil).body["tasks"].([]any)
		tid := ts[0].(map[string]any)["id"].(string)
		c := e.do("POST", "/api/v1/tasks/"+tid+"/claim", e.token, nil)
		check(t, "claimed", c.status == 200, c)
		e.do("POST", "/api/v1/tasks/"+tid+"/report", e.token, map[string]any{"state": "review", "summary": "好了", "memory": memory, "run": c.body["task"].(map[string]any)["runs"]})
		return c.body
	}
	mem := func() string { m, _ := e.memoryOf(e.wl.session); return m }
	c := run(e.zw.session, e.cid, "公开频道的活", "m-public")
	check(t, "a public channel: it may", c["memory_writable"] == true && mem() == "m-public")

	own := e.do("POST", "/api/v1/channels", e.wl.session, map[string]any{"name": "王磊的", "private": true, "members": []any{map[string]any{"kind": "agent", "id": e.aid}}}).body["id"].(string)
	c = run(e.wl.session, own, "私事", "m-own")
	check(t, "its owner's private channel: it may", c["memory_writable"] == true && mem() == "m-own")

	other := e.do("POST", "/api/v1/channels", e.zw.session, map[string]any{"name": "张伟的", "private": true, "members": []any{map[string]any{"kind": "agent", "id": e.aid}}}).body["id"].(string)
	c = run(e.zw.session, other, "张伟的私事", "m-zw")
	check(t, "someone else's private channel: it may not, and what it sends is dropped", c["memory_writable"] == false && mem() == "m-own")

	e.do("PATCH", "/api/v1/machines/"+e.mid, e.zw.session, map[string]any{"team": true})
	c = run(e.wl.session, own, "团队机器上", "m-team")
	check(t, "a team agent in a private channel: it may not", c["memory_writable"] == false && mem() == "m-own")
	c = run(e.zw.session, e.cid, "团队机器上，公开频道", "m-team-public")
	check(t, "a team agent in a public channel: it may", c["memory_writable"] == true && mem() == "m-team-public")
}

// 「我的偏好」: the person's own, given with the tasks they ask for.
func TestPreferences(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	llLive, zwLive := e.listen(e.ll.id), e.listen(e.zw.id)
	r := e.do("PATCH", "/api/v1/users/"+e.zw.id, e.zw.session, map[string]any{"preferences": "  回复用中文；zebra 先问我  "})
	check(t, "one writes one's own", r.status == 200, r)
	r = e.do("GET", "/api/v1/me", e.zw.session, nil)
	check(t, "and reads them back", r.body["preferences"] == "回复用中文；zebra 先问我", r)
	check(t, "someone else cannot change them, an admin's or a member's", e.do("PATCH", "/api/v1/users/"+e.zw.id, e.wl.session, map[string]any{"preferences": "x"}).status == 403 &&
		e.do("PATCH", "/api/v1/users/"+e.ll.id, e.zw.session, map[string]any{"preferences": "x"}).status == 403)
	for _, s := range []string{e.wl.session, e.ll.session} {
		check(t, "nor read them", !strings.Contains(string(e.do("GET", "/api/v1/users", s, nil).raw), "zebra") &&
			!strings.Contains(string(e.do("GET", "/api/v1/me", s, nil).raw), "zebra"))
	}
	check(t, "a machine's /me has nobody's", !strings.Contains(string(e.do("GET", "/api/v1/me", e.token, nil).raw), "zebra"))
	check(t, "nothing is broadcast", !strings.Contains(llLive.all(), "zebra") && !strings.Contains(zwLive.all(), "zebra"))
	long := strings.Repeat("偏", preferencesChars+10)
	e.do("PATCH", "/api/v1/users/"+e.ll.id, e.ll.session, map[string]any{"preferences": long})
	check(t, "kept to 4000 characters", len([]rune(e.do("GET", "/api/v1/me", e.ll.session, nil).body["preferences"].(string))) <= preferencesChars+1) // and a "…"

	claim := func(session string) map[string]any {
		m := e.post(session, "@acha 看看", "")
		tid := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
		c := e.do("POST", "/api/v1/tasks/"+tid+"/claim", e.token, nil)
		check(t, "claimed", c.status == 200, c)
		return c.body
	}
	check(t, "a task 张伟 asked for carries his", claim(e.zw.session)["requester_preferences"] == "回复用中文；zebra 先问我")
	check(t, "one 王磊 asked for carries none", claim(e.wl.session)["requester_preferences"] == "")
}
