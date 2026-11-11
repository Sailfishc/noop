package hub

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

// 换电脑继续: the laptop that ran a task goes away; after 10 minutes, with the desktop able to take work, the agent's
// owner gets one card; waiting keeps it on the laptop, moving gives it to the desktop (fresh session, the laptop's
// late reports refused), and nobody else can move it.
func TestMoveCard(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	laptop, laptopToken := e.mid, e.token
	r := e.do("POST", "/api/v1/machines", e.wl.session, map[string]any{"name": "王磊的台式机"})
	desk, deskToken := r.body["machine"].(map[string]any)["id"].(string), r.body["token"].(string)
	alive := func(token string) {
		e.do("PUT", "/api/v1/machine", token, map[string]any{"runtimes": []any{"codex"}, "max_sessions": 2,
			"runtime_info": []any{map[string]any{"name": "codex", "installed": true, "logged_in": true}}})
	}
	alive(laptopToken)
	alive(deskToken)
	e.do("PATCH", "/api/v1/agents/"+e.aid, e.wl.session, map[string]any{"machines": []any{laptop, desk}})
	m := e.post(e.wl.session, "@acha 改一下订单索引", "")
	id := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.wl.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	r = e.do("POST", "/api/v1/tasks/"+id+"/claim", laptopToken, nil)
	check(t, "the laptop runs it", r.status == 200 && num(r.body["task"].(map[string]any)["moves"]) == 0, r)
	e.do("POST", "/api/v1/tasks/"+id+"/report", laptopToken, map[string]any{"step": "改索引"})
	e.do("POST", "/api/v1/tasks/"+id+"/checkpoint", laptopToken, map[string]any{"repos": []any{map[string]any{"repo": "corp/pay", "branch": "agent/" + id + "-wip", "commit": strings.Repeat("a", 40)}}})
	card := func() map[string]any { c, _ := e.task(id)["move"].(map[string]any); return c }
	inInbox := func(s string) bool {
		for _, x := range e.inbox(s) {
			if x.(map[string]any)["id"] == id {
				return true
			}
		}
		return false
	}

	// the laptop goes away mid-run: nothing for ten minutes
	e.advance(8 * time.Minute)
	alive(deskToken)
	e.h.Tick()
	check(t, "no card before ten minutes", card() == nil)
	e.advance(4 * time.Minute)
	alive(deskToken)
	e.h.Tick()
	e.h.Tick()
	c := card()
	check(t, "then one card, for the desktop", c != nil && c["state"] == "proposed" && c["from"] == laptop && c["to"] == desk)
	check(t, "on the owner's inbox", inInbox(e.wl.session))
	check(t, "the owner has the ball", e.task(id)["holder"].(map[string]any)["why"] == "move")
	calls := e.task(id)["calls"].([]any)
	check(t, "a call outside align, decide, accept", len(calls) == 1 && calls[0].(map[string]any)["kind"] == "move" && calls[0].(map[string]any)["class"] == "outside")

	// ignored: the laptop comes back, the card goes, the task goes on there in its session
	alive(laptopToken)
	e.h.Tick()
	check(t, "the laptop back: the card is withdrawn", card()["state"] == "withdrawn" && !inInbox(e.wl.session))
	check(t, "still the laptop's", e.task(id)["claimed_by"] == laptop)

	// gone again: a new card; someone else may not move it, nor to a computer not the agent's
	e.advance(11 * time.Minute)
	alive(deskToken)
	e.h.Tick()
	check(t, "a new absence, a new card", card()["state"] == "proposed")
	check(t, "not someone else", e.do("POST", "/api/v1/tasks/"+id+"/move", e.ll.session, map[string]any{}).status == 403)
	check(t, "not an admin either", e.do("POST", "/api/v1/tasks/"+id+"/move", e.zw.session, map[string]any{}).status == 403)
	var other string
	for _, x := range e.do("GET", "/api/v1/machines", e.zw.session, nil).body["machines"].([]any) {
		if mm := x.(map[string]any); mm["owner_id"] == e.zw.id {
			other = mm["id"].(string)
		}
	}
	check(t, "not to a computer not the agent's", e.do("POST", "/api/v1/tasks/"+id+"/move", e.wl.session, map[string]any{"to": other}).status == 400)

	// wait: the card goes, this absence asks no more
	r = e.do("POST", "/api/v1/tasks/"+id+"/move", e.wl.session, map[string]any{"wait": true})
	check(t, "wait", r.status == 200 && card()["state"] == "waited", r)
	e.advance(5 * time.Minute)
	alive(deskToken)
	e.h.Tick()
	check(t, "not asked again for this absence", card()["state"] == "waited" && !inInbox(e.wl.session))

	// move after all (the owner changed their mind): the desktop takes it, fresh
	r = e.do("POST", "/api/v1/tasks/"+id+"/move", e.wl.session, map[string]any{"to": desk})
	tk := r.body
	check(t, "moved", r.status == 200 && tk["claimed_by"] == desk && tk["state"] == "queued" && tk["session"] == "" && num(tk["moves"]) == 1, r)
	r = e.do("GET", "/api/v1/messages/"+m["id"].(string)+"/thread", e.wl.session, nil)
	check(t, "the thread says so", strings.Contains(string(r.raw), "换到 王磊的台式机 继续，从最新的检查点接着做"), r)
	r = e.do("POST", "/api/v1/tasks/"+id+"/claim", deskToken, nil)
	check(t, "the desktop claims it with its checkpoint and count", r.status == 200 && num(r.body["task"].(map[string]any)["moves"]) == 1 && r.body["task"].(map[string]any)["checkpoint"] != nil, r)

	// the laptop comes back with its old run: refused, whatever it says
	alive(laptopToken)
	r = e.do("POST", "/api/v1/tasks/"+id+"/report", laptopToken, map[string]any{"state": "review", "summary": "老的结果"})
	check(t, "the laptop's report is refused", r.status == 409, r)
	r = e.do("POST", "/api/v1/tasks/"+id+"/checkpoint", laptopToken, map[string]any{"unchanged": true})
	check(t, "and its checkpoint", r.status == 409, r)
	r = e.do("POST", "/api/v1/tasks/"+id+"/report?moves=0", deskToken, map[string]any{"step": "x"})
	check(t, "a run claimed before the move is refused anywhere", r.status == 409, r)
	r = e.do("POST", "/api/v1/tasks/"+id+"/report?moves=1", deskToken, map[string]any{"state": "review", "summary": "在台式机上做完了"})
	check(t, "the desktop's run reports", r.status == 200 && e.task(id)["state"] == "review", r)
	check(t, "a card no more", card()["state"] == "moved")
}

// No other computer can take it: no card; a task waiting for a person: no card, until after the answer.
func TestMoveCardWhenNot(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	laptop, laptopToken := e.mid, e.token
	r := e.do("POST", "/api/v1/machines", e.wl.session, map[string]any{"name": "王磊的台式机"})
	desk, deskToken := r.body["machine"].(map[string]any)["id"].(string), r.body["token"].(string)
	alive := func(token string) {
		e.do("PUT", "/api/v1/machine", token, map[string]any{"runtimes": []any{"codex"}, "max_sessions": 2,
			"runtime_info": []any{map[string]any{"name": "codex", "installed": true, "logged_in": true}}})
	}
	alive(laptopToken)
	e.do("PATCH", "/api/v1/agents/"+e.aid, e.wl.session, map[string]any{"machines": []any{laptop, desk}})
	m := e.post(e.wl.session, "@acha 改一下订单索引", "")
	id := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.wl.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	e.do("POST", "/api/v1/tasks/"+id+"/claim", laptopToken, nil)
	e.advance(15 * time.Minute)
	e.h.Tick()
	check(t, "the desktop is off too: no card", e.task(id)["move"] == nil)
	check(t, "and no move", e.do("POST", "/api/v1/tasks/"+id+"/move", e.wl.session, map[string]any{"to": desk}).status == 409)

	// it asks a question and stops: no card while it waits for the answer
	alive(laptopToken)
	e.do("POST", "/api/v1/tasks/"+id+"/report", laptopToken, map[string]any{"state": "needs_decision", "summary": "要问一下", "decision": map[string]any{"question": "A 还是 B？", "options": []any{"A", "B"}}})
	e.advance(15 * time.Minute)
	alive(deskToken)
	e.h.Tick()
	check(t, "waiting for a person: no card", e.task(id)["move"] == nil)
	e.do("POST", "/api/v1/tasks/"+id+"/decide", e.wl.session, map[string]any{"choice": "A"})
	check(t, "answered: queued for the laptop", e.task(id)["state"] == "queued")
	e.advance(5 * time.Minute)
	alive(deskToken)
	e.h.Tick()
	check(t, "not before ten minutes after the answer", e.task(id)["move"] == nil)
	e.advance(6 * time.Minute)
	alive(deskToken)
	e.h.Tick()
	check(t, "then the card", e.task(id)["move"] != nil && e.task(id)["move"].(map[string]any)["state"] == "proposed")

	// the packed directory: only the computer the task is on takes it back
	up := e.do("POST", "/api/v1/tasks/"+id+"/checkpoint/files", laptopToken, bytes.NewBufferString("tgz"))
	check(t, "stored while still on the laptop", up.status == 200, up)
	e.do("POST", "/api/v1/tasks/"+id+"/checkpoint", laptopToken, map[string]any{"files": map[string]any{"id": up.body["id"], "size": 3}})
	check(t, "another computer of the agent can't read it", e.do("GET", "/api/v1/tasks/"+id+"/checkpoint/files", deskToken, nil).status == 409)
	check(t, "nor a person", e.do("GET", "/api/v1/tasks/"+id+"/checkpoint/files", e.wl.session, nil).status == 403)
	e.advance(11 * time.Minute) // the laptop gone again (its upload was a sign of life)
	alive(deskToken)
	r = e.do("POST", "/api/v1/tasks/"+id+"/move", e.wl.session, map[string]any{})
	check(t, "moved to the card's computer", r.status == 200 && r.body["claimed_by"] == desk, r)
	r = e.do("GET", "/api/v1/tasks/"+id+"/checkpoint/files", deskToken, nil)
	check(t, "after the move, the desktop takes it back", r.status == 200 && string(r.raw) == "tgz", r)
	check(t, "and the laptop no more", e.do("GET", "/api/v1/tasks/"+id+"/checkpoint/files", laptopToken, nil).status == 409)
}
