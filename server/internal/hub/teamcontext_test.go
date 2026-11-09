package hub

import (
	"strings"
	"testing"
)

// The agent reads and searches the chat itself while it runs, with its run's read token, in its own channels only.
func TestAgentLooksThingsUp(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	other := e.do("POST", "/api/v1/channels", e.zw.session, map[string]any{"name": "机密"}).body["id"].(string)
	e.do("POST", "/api/v1/channels/"+other+"/messages", e.zw.session, map[string]any{"text": "工资表在这里"})
	old := e.post(e.wl.session, "上次慢查询是 orders 表缺索引", "")
	e.post(e.ll.session, "补充：refunds 也慢", old["id"].(string))
	m := e.post(e.zw.session, "@acha 再看下慢查询", "")
	id := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)

	r := e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	tok, _ := r.body["read_token"].(string)
	check(t, "the claim brings a read token", strings.HasPrefix(tok, "rt_"), r)

	r = e.do("GET", "/api/v1/agent/read", tok, nil)
	check(t, "the task's channel, oldest first", r.status == 200 && strings.Index(string(r.raw), "orders 表缺索引") < strings.Index(string(r.raw), "再看下慢查询") &&
		strings.Contains(string(r.raw), "1 replies"), r)
	r = e.do("GET", "/api/v1/agent/read?thread="+old["id"].(string), tok, nil)
	check(t, "a thread, whole", strings.Contains(string(r.raw), "refunds 也慢"), r)
	r = e.do("GET", "/api/v1/agent/search?q=refunds", tok, nil)
	check(t, "search finds the reply", strings.Contains(string(r.raw), "refunds 也慢") && strings.Contains(string(r.raw), "王磊") == false, r)
	r = e.do("GET", "/api/v1/agent/search?q=工资", tok, nil)
	check(t, "not in channels it is not in", strings.Contains(string(r.raw), "nothing found"), r)
	check(t, "nor by name", e.do("GET", "/api/v1/agent/read?channel=%23机密", tok, nil).status == 404)

	e.do("POST", "/api/v1/tasks/"+id+"/track", e.zw.session, nil)
	r = e.do("GET", "/api/v1/agent/tasks", tok, nil)
	check(t, "its channels' tasks", strings.Contains(string(r.raw), id+" [in_progress]"), r)
	r = e.do("GET", "/api/v1/agent/tasks/"+id, tok, nil)
	check(t, "one task", strings.Contains(string(r.raw), "Thread: teamagent read --thread "+m["id"].(string)), r)

	check(t, "no token, no reading", e.do("GET", "/api/v1/agent/read", "", nil).status == 401)
	check(t, "a person's session is not a read token", e.do("GET", "/api/v1/agent/read", e.zw.session, nil).status == 401)
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "好了"})
	check(t, "only while the task runs", e.do("GET", "/api/v1/agent/read", tok, nil).status == 403)
}
