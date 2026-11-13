package hub

import (
	"fmt"
	"testing"
	"time"
)

// Consecutive messages between the same person and agent share one runtime session for two hours; after two hours of
// quiet, a new session starts with recent conversation context; in a private agent chat, plain answers appear directly
// in the top-level stream.
func TestConversationSessionAndFlatDM(t *testing.T) {
	e := newTaskEnv(t, "team", false)
	dm := e.do("POST", "/api/v1/channels", e.wl.session, map[string]any{"dm_agent": e.aid}).body["id"].(string)

	m1 := e.do("POST", "/api/v1/channels/"+dm+"/messages", e.wl.session, map[string]any{"text": "帮我算一下 6 乘 7"}).body
	t1 := e.do("GET", "/api/v1/tasks?thread="+m1["id"].(string), e.wl.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	c1 := e.do("POST", "/api/v1/tasks/"+t1+"/claim", e.token, nil).body
	check(t, "first turn starts a fresh session", c1["task"].(map[string]any)["session"] == "" && c1["task"].(map[string]any)["conv_id"] == t1)
	e.do("POST", "/api/v1/tasks/"+t1+"/report", e.token, map[string]any{"state": "review", "summary": "是 42。", "answer": true, "session": "ses_conv_1", "run": 1})

	// In an agent DM, the plain answer lands in the top-level stream (no thread reply count).
	top := e.do("GET", "/api/v1/channels/"+dm+"/messages", e.wl.session, nil).body["messages"].([]any)
	check(t, "DM has both messages at top level", len(top) == 2 && top[1].(map[string]any)["text"] == "是 42。" && top[1].(map[string]any)["thread_id"] == nil, resp{raw: []byte(fmt.Sprint(top))})

	// Next message within 2 hours reuses ses_conv_1 and conv_id == t1.
	e.advance(5 * time.Minute)
	m2 := e.do("POST", "/api/v1/channels/"+dm+"/messages", e.wl.session, map[string]any{"text": "再加 8 呢？"}).body
	t2 := e.do("GET", "/api/v1/tasks?thread="+m2["id"].(string), e.wl.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	c2 := e.do("POST", "/api/v1/tasks/"+t2+"/claim", e.token, nil).body
	tk2 := c2["task"].(map[string]any)
	check(t, "second turn shares session and conv_id", tk2["session"] == "ses_conv_1" && tk2["conv_id"] == t1, resp{raw: []byte(fmt.Sprint(tk2))})
	e.do("POST", "/api/v1/tasks/"+t2+"/report", e.token, map[string]any{"state": "review", "summary": "是 50。", "answer": true, "session": "ses_conv_1", "run": 1})

	// Idle > 2 hours ends the conversation segment: fresh session, conv_recent carries earlier turns.
	e.advance(2*time.Hour + 5*time.Minute)
	m3 := e.do("POST", "/api/v1/channels/"+dm+"/messages", e.wl.session, map[string]any{"text": "刚才算到多少了？"}).body
	t3 := e.do("GET", "/api/v1/tasks?thread="+m3["id"].(string), e.wl.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	c3 := e.do("POST", "/api/v1/tasks/"+t3+"/claim", e.token, nil).body
	tk3 := c3["task"].(map[string]any)
	rec, _ := c3["conv_recent"].([]any)
	check(t, "after 2h idle: fresh session, new conv_id, recent context recovered", tk3["session"] == "" && tk3["conv_id"] == t3 && len(rec) >= 4, resp{raw: []byte(fmt.Sprint(c3))})
}

func TestConversationSerializationOfflineAndEditToAgent(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	laptop, laptopToken := e.mid, e.token
	r := e.do("POST", "/api/v1/machines", e.wl.session, map[string]any{"name": "王磊的台式机"})
	desk, deskToken := r.body["machine"].(map[string]any)["id"].(string), r.body["token"].(string)
	reportMachine := func(tok string) {
		e.do("PUT", "/api/v1/machine", tok, map[string]any{"runtimes": []any{"codex"}, "max_sessions": 2,
			"runtime_info": []any{map[string]any{"name": "codex", "installed": true, "logged_in": true}}})
	}
	reportMachine(laptopToken)
	reportMachine(deskToken)
	e.do("PATCH", "/api/v1/agents/"+e.aid, e.wl.session, map[string]any{"machines": []any{laptop, desk}})

	// 1. Serialization: Turn 2 cannot be picked or claimed before Turn 1 finishes (even while Turn 1 is still queued).
	m1 := e.do("POST", "/api/v1/channels/"+e.cid+"/messages", e.zw.session, map[string]any{"text": "第一问", "to_agent": e.aid}).body
	m2 := e.do("POST", "/api/v1/channels/"+e.cid+"/messages", e.zw.session, map[string]any{"text": "第二问", "to_agent": e.aid}).body
	t1 := e.do("GET", "/api/v1/tasks?thread="+m1["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	t2 := e.do("GET", "/api/v1/tasks?thread="+m2["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)

	offered := e.do("GET", "/api/v1/machine/tasks", laptopToken, nil).body["tasks"].([]any)
	check(t, "only turn 1 offered while turn 1 is queued", len(offered) == 1 && offered[0].(map[string]any)["id"] == t1, resp{raw: []byte(fmt.Sprint(offered))})
	check(t, "turn 2 cannot be claimed out of order", e.do("POST", "/api/v1/tasks/"+t2+"/claim", laptopToken, nil).status == 409)

	// Editing a message sent with to_agent preserves its agent mention even without @handle in text.
	ed := e.do("PATCH", "/api/v1/messages/"+m2["id"].(string), e.zw.session, map[string]any{"text": "第二问（改错字）"})
	check(t, "v1Edit preserves to_agent mention", ed.status == 200 && len(ed.body["mentions"].([]any)) == 1 &&
		ed.body["mentions"].([]any)[0].(map[string]any)["id"] == e.aid, ed)

	e.do("POST", "/api/v1/tasks/"+t1+"/claim", laptopToken, nil)
	check(t, "turn 2 still blocked while turn 1 is running", e.do("POST", "/api/v1/tasks/"+t2+"/claim", laptopToken, nil).status == 409)
	e.do("POST", "/api/v1/tasks/"+t1+"/report", laptopToken, map[string]any{"state": "review", "summary": "答一", "answer": true, "session": "ses_1", "run": 1})

	c2 := e.do("POST", "/api/v1/tasks/"+t2+"/claim", laptopToken, nil)
	check(t, "turn 2 claimable after turn 1 finishes, inheriting ses_1", c2.status == 200 && c2.body["task"].(map[string]any)["session"] == "ses_1", c2)
	e.do("POST", "/api/v1/tasks/"+t2+"/report", laptopToken, map[string]any{"state": "review", "summary": "答二", "answer": true, "session": "ses_1", "run": 1})

	// 2. Offline machine: laptop goes offline while desk stays online; Turn 3 rotates to desk instead of trapping on laptop.
	e.advance(machineOnlineSpan + time.Minute)
	reportMachine(deskToken)
	m3 := e.do("POST", "/api/v1/channels/"+e.cid+"/messages", e.zw.session, map[string]any{"text": "第三问", "to_agent": e.aid}).body
	t3 := e.do("GET", "/api/v1/tasks?thread="+m3["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	c3 := e.do("POST", "/api/v1/tasks/"+t3+"/claim", deskToken, nil)
	check(t, "offline previous machine rotates conversation to online machine with conv_recent",
		c3.status == 200 && c3.body["task"].(map[string]any)["conv_id"] == t3 && len(c3.body["conv_recent"].([]any)) >= 2, c3)
}
