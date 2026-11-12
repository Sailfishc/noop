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
