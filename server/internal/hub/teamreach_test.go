package hub

import (
	"fmt"
	"strings"
	"testing"
)

// `remi who` with no handle: the agents the running agent may turn to, as the requester may use them.
func TestWhoList(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	e.zwAgent("bei")                                                // 张伟's own: no card for his task
	e.agentOf(e.wl.session, e.mid, "wu", "channel", true, true)     // 王磊's, his yes first
	e.agentOf(e.wl.session, e.mid, "away", "channel", false, false) // not in the channel, 张伟 can't bring it
	e.agentOf(e.wl.session, e.mid, "tm", "team", false, false)      // anyone's: comes when called
	_, tok, _ := e.claimed("@acha 修一下退款")
	r := e.do("GET", "/api/v1/agent/who", tok, nil)
	got := string(r.raw)
	lines := strings.Split(strings.TrimSpace(got), "\n")
	check(t, "three agents, not itself and not one the requester could not use", r.status == 200 && len(lines) == 3 &&
		!strings.Contains(got, "@acha") && !strings.Contains(got, "@away"), r)
	check(t, "free ones first, then the one behind its owner's card", strings.HasPrefix(lines[0], "@bei") && strings.HasPrefix(lines[1], "@tm") &&
		strings.HasPrefix(lines[2], "@wu") && strings.Contains(lines[2], "needs a card (@wanglei says yes first)") && strings.Contains(lines[0], "no card"), r)
	check(t, "where each one is", strings.Contains(lines[0], "in this channel") && strings.Contains(lines[1], "joins this channel"), r)
	check(t, "and whether it can work now", strings.Contains(lines[0], "cannot take work now") && strings.Contains(lines[0], "0 running"), r)

	// the claim brings the same list for the start prompt
	m := e.post(e.zw.session, "@acha 再看一下对账", "")
	id := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	c := e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	check(t, "in the claim", strings.HasPrefix(c.body["agents"].(string), "@bei"), c)
	check(t, "a person still looks one up by handle", strings.Contains(string(e.do("GET", "/api/v1/agent/who?handle=wanglei", tok, nil).raw), "person"))
}

// In a private channel an agent brings in only its requester's own agent: anyone else's waits for a member to add it.
func TestReachPrivate(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	bei := e.zwAgent("bei") // 张伟's, in the public channel only
	e.do("DELETE", "/api/v1/channels/"+e.cid+"/members/agent/"+bei, e.zw.session, nil)
	tm := e.agentOf(e.zw.session, e.zwMachine(), "tm", "team", false, false)
	own := e.agentOf(e.wl.session, e.mid, "wu", "channel", true, false) // 王磊's own, not in it yet
	r := e.do("POST", "/api/v1/channels", e.wl.session, map[string]any{"name": "私房菜", "private": true,
		"members": []any{map[string]any{"kind": "agent", "id": e.aid}}})
	pid := r.body["id"].(string)
	m := e.do("POST", "/api/v1/channels/"+pid+"/messages", e.wl.session, map[string]any{"text": "@acha 整理一下菜谱"}).body
	id := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.wl.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	c := e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	tok := c.body["read_token"].(string)

	who := string(e.do("GET", "/api/v1/agent/who", tok, nil).raw)
	check(t, "the list has only the requester's own agent outside it", !strings.Contains(who, "@bei") && !strings.Contains(who, "@tm") && strings.Contains(who, "@wu"), resp{raw: []byte(who)})
	r = e.do("POST", "/api/v1/agent/handoff", tok, map[string]any{"text": "@bei 帮忙看看"})
	check(t, "someone else's agent: refused, and it says what to do", r.status == 403 && strings.Contains(string(r.raw), "请频道成员先把它加进来"), r)
	check(t, "and it did not come in", !e.h.isMember(pid, "agent", bei))
	r = e.do("POST", "/api/v1/agent/handoff", tok, map[string]any{"text": "@tm 帮忙看看"})
	check(t, "a team-wide agent of someone else's too: no agent brings it in for a person", r.status == 403 && !e.h.isMember(pid, "agent", tm), r)
	r = e.do("POST", "/api/v1/agent/handoff", tok, map[string]any{"text": "@wu 帮忙看看"})
	check(t, "the requester's own agent comes in, no card (his confirm is for others' work)", r.status == 200 && e.h.isMember(pid, "agent", own) &&
		strings.Contains(string(r.raw), "no card"), r)
	e.do("POST", "/api/v1/channels/"+pid+"/members", e.wl.session, map[string]any{"kind": "agent", "id": tm})
	r = e.do("POST", "/api/v1/agent/handoff", tok, map[string]any{"text": "@tm 帮忙看看"})
	check(t, "once a member brought it in, it may be used as anywhere", r.status == 200 && strings.Contains(string(r.raw), "no card"), r)
}

// zwMachine: 张伟's machine.
func (e *taskEnv) zwMachine() string {
	for _, m := range e.do("GET", "/api/v1/machines", e.zw.session, nil).body["machines"].([]any) {
		if m.(map[string]any)["name"] == "张伟的 Mac" {
			return m.(map[string]any)["id"].(string)
		}
	}
	return ""
}

// An answer-only run that left a handoff card is not over: the card still waits for its owner.
func TestHandoffCardKeepsTaskOpen(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	e.agentOf(e.wl.session, e.mid, "wu", "channel", true, true)
	id, tok, _ := e.claimed("@acha 看一下退款日志")
	check(t, "a card", e.do("POST", "/api/v1/agent/handoff", tok, map[string]any{"text": "@wu 后面交给你"}).status == 200)
	r := e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "交给 @wu 了", "answer": true, "run": 1})
	check(t, "reported", r.status == 200, r)
	tk := e.task(id)
	check(t, "not done: the card's owner has the ball", tk["state"] == "review" && tk["holder"].(map[string]any)["id"] == e.wl.id &&
		tk["holder"].(map[string]any)["why"] == "handoff_card", resp{raw: []byte(tk["state"].(string))})
	check(t, "on his list", len(e.inbox(e.wl.session)) == 1)
}

// A card for an agent whose owner is not in the private channel: he sees only a redacted row, but it carries the
// card's id and the agent (not its words), he can click it, and he hears of it live.
func TestHandoffCardOwnerOutsidePrivate(t *testing.T) {
	e := newTaskEnv(t, "team", true) // @acha: 王磊's, takes anyone's work, with his yes
	wlLive := e.listen(e.wl.id)
	bei := e.zwAgent("bei")
	r := e.do("POST", "/api/v1/channels", e.zw.session, map[string]any{"name": "zebra 小组", "private": true,
		"members": []any{map[string]any{"kind": "agent", "id": bei}, map[string]any{"kind": "agent", "id": e.aid}}})
	check(t, "张伟 brings 王磊's team-wide agent into his private channel himself", r.status == 200, r)
	pid := r.body["id"].(string)
	m := e.do("POST", "/api/v1/channels/"+pid+"/messages", e.zw.session, map[string]any{"text": "@bei 整理 zebra 菜谱"}).body
	id := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	tok := e.do("POST", "/api/v1/tasks/"+id+"/claim", e.otherToken, nil).body["read_token"].(string)
	r = e.do("POST", "/api/v1/agent/handoff", tok, map[string]any{"text": "@acha 后面 zebra 交给你"})
	check(t, "a card for 王磊", r.status == 200 && strings.Contains(string(r.raw), "proposed"), r)

	var row map[string]any
	for _, x := range e.inbox(e.wl.session) {
		if x.(map[string]any)["id"] == id {
			row = x.(map[string]any)
		}
	}
	check(t, "on 王磊's list, redacted", row != nil && row["redacted"] == true, resp{raw: []byte(fmt.Sprint(row))})
	hs, _ := row["handoffs"].([]any)
	check(t, "with the card's id and agent, not its words", len(hs) == 1 && hs[0].(map[string]any)["to"] == e.aid &&
		hs[0].(map[string]any)["state"] == "proposed" && hs[0].(map[string]any)["what"] == "", resp{raw: []byte(fmt.Sprint(row))})
	got := wlLive.all()
	check(t, "he heard of it live, without the words", strings.Contains(got, `"handoff_card"`) && !strings.Contains(got, "zebra"), resp{raw: []byte(got)})
	r = e.do("POST", "/api/v1/tasks/"+id+"/handoff", e.wl.session, map[string]any{"id": hs[0].(map[string]any)["id"], "accept": true})
	check(t, "he clicks it", r.status == 200 && r.body["redacted"] == true && !strings.Contains(string(r.raw), "zebra"), r)
	check(t, "and @acha has the task", e.h.count("SELECT COUNT(*) FROM tasks_v1 WHERE agent_id = ? AND thread_id = ?", e.aid, m["id"]) == 1)
}
