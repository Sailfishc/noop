package hub

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestCheckCommands(t *testing.T) {
	e := newTaskEnv(t, "channel", false) // @acha (王磊's) takes its channels' work without his yes: not a check command
	online := func() { e.h.must(e.h.db.Exec("UPDATE machines SET last_seen = ? WHERE id = ?", e.h.nowMs(), e.mid)) }
	trg := func() map[string]any {
		return e.do("GET", "/api/v1/triggers?channel="+e.cid, e.zw.session, nil).body["triggers"].([]any)[0].(map[string]any)
	}
	tasks := func() int { return len(e.do("GET", "/api/v1/tasks", e.zw.session, nil).body["tasks"].([]any)) }
	checks := func(tok string) []any { return e.do("GET", "/api/v1/machine/tasks", tok, nil).body["checks"].([]any) }
	day := func() { e.advance(24 * time.Hour); online(); e.h.Tick() }

	check(t, "only a schedule takes a check command", e.do("POST", "/api/v1/triggers", e.zw.session, map[string]any{"channel_id": e.cid, "agent": "acha", "kind": "pr",
		"repo": "https://github.com/acme/pay", "text": "看 PR", "check_cmd": "ls"}).status == 400)
	r := e.do("POST", "/api/v1/triggers", e.zw.session, map[string]any{"channel_id": e.cid, "agent": "acha", "kind": "schedule", "when": "9:00", "repeat": "daily",
		"text": "主干有新提交就看一眼", "duty": "看住主干", "check_cmd": "git ls-remote origin main"})
	check(t, "张伟 sets one with a check on 王磊's computer: it waits for 王磊, although @acha needs no yes", r.status == 200 && r.body["confirmed_by"] == nil && r.body["check_waits"] == true, r)
	id := r.body["id"].(string)
	msgs := e.channelTexts()
	check(t, "王磊 is asked, with the command shown", strings.Contains(msgs[len(msgs)-1], "@wanglei") && strings.Contains(msgs[len(msgs)-1], "git ls-remote origin main"))
	e.advance(10 * time.Hour)
	online()
	e.h.Tick()
	check(t, "before he confirms the command never runs", len(checks(e.token)) == 0 && tasks() == 0)
	check(t, "张伟 can't confirm it, admin as he is", e.do("POST", "/api/v1/triggers/"+id+"/confirm", e.zw.session, nil).status == 403 && trg()["check_waits"] == true)
	check(t, "王磊 confirms", e.do("POST", "/api/v1/triggers/"+id+"/confirm", e.wl.session, nil).status == 200 && trg()["check_waits"] == nil)

	// due: the check goes to @acha's computer; no task yet
	day()
	cs := checks(e.token)
	check(t, "the check is handed to the agent's computer, with its command", len(cs) == 1 && cs[0].(map[string]any)["cmd"] == "git ls-remote origin main" && tasks() == 0, resp{raw: []byte(fmt.Sprint(cs))})
	check(t, "not to another computer", len(checks(e.otherToken)) == 0 &&
		e.do("POST", "/api/v1/triggers/"+id+"/check", e.otherToken, map[string]any{"hash": "x"}).status == 409)
	r = e.do("POST", "/api/v1/triggers/"+id+"/check", e.token, map[string]any{"hash": "h1", "output": "abc123\trefs/heads/main"})
	check(t, "the first output fires it, the output in the request", r.body["result"] == "fired" && tasks() == 1, r)
	tk := e.do("GET", "/api/v1/tasks", e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)
	check(t, "the agent sees what the check printed", strings.Contains(tk["body"].(string), "abc123\trefs/heads/main"), resp{raw: []byte(fmt.Sprint(tk["body"]))})
	e.do("POST", "/api/v1/tasks/"+tk["id"].(string)+"/claim", e.token, nil)
	e.do("POST", "/api/v1/tasks/"+tk["id"].(string)+"/report", e.token, map[string]any{"state": "nothing", "summary": "新提交没问题"})

	// the same output: nothing at all
	day()
	r = e.do("POST", "/api/v1/triggers/"+id+"/check", e.token, map[string]any{"hash": "h1", "output": "abc123\trefs/heads/main"})
	check(t, "the same output: no task, no message", r.body["result"] == "nochange" && tasks() == 1, r)
	runs := e.dutyRuns(e.zw.session, "trigger="+id)
	check(t, "one 'no change' line", runs[0]["outcome"] == "nochange" && runs[1]["outcome"] == "nothing", resp{raw: []byte(fmt.Sprint(runs))})
	check(t, "answered once only", e.do("POST", "/api/v1/triggers/"+id+"/check", e.token, map[string]any{"hash": "h2"}).status == 409)

	// an error is a change
	day()
	r = e.do("POST", "/api/v1/triggers/"+id+"/check", e.token, map[string]any{"error": "超时（60 秒）", "output": "fatal: unable to access"})
	check(t, "a failed or timed-out check fires it, with the error", r.body["result"] == "fired" && tasks() == 2 &&
		strings.Contains(e.do("GET", "/api/v1/tasks?state=queued", e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["body"].(string), "超时（60 秒）"), r)

	// a change while the last task is open: skipped, and the change still counts next time
	day()
	r = e.do("POST", "/api/v1/triggers/"+id+"/check", e.token, map[string]any{"hash": "h3", "output": "def456"})
	check(t, "changed while its last task is still queued: skipped", r.body["result"] == "skipped", r)
	for _, x := range e.do("GET", "/api/v1/tasks?state=queued", e.zw.session, nil).body["tasks"].([]any) {
		e.do("POST", "/api/v1/tasks/"+x.(map[string]any)["id"].(string)+"/cancel", e.zw.session, nil)
	}
	day()
	r = e.do("POST", "/api/v1/triggers/"+id+"/check", e.token, map[string]any{"hash": "h3", "output": "def456"})
	check(t, "the skipped change fires the next time", r.body["result"] == "fired", r)

	// the computer offline: skipped and counted; a check nobody answers is given up
	e.h.must(e.h.db.Exec("UPDATE tasks_v1 SET state = 'done'"))
	e.advance(24 * time.Hour)
	e.h.must(e.h.db.Exec("UPDATE machines SET last_seen = 0"))
	e.h.Tick()
	tv := trg()
	check(t, "its computer offline: skipped, in a row, and why", tv["skip_reason"] == "offline" && tv["skipped_run"] == float64(1) && len(checks(e.token)) == 0, resp{raw: []byte(fmt.Sprint(tv))})
	day()
	check(t, "online again: sent", len(checks(e.token)) == 1)
	e.advance(4 * time.Minute)
	e.h.Tick()
	check(t, "not answered in time: given up as offline", trg()["skipped_run"] == float64(2) && trg()["skip_reason"] == "offline" && len(checks(e.token)) == 0, resp{raw: []byte(fmt.Sprint(trg()))})

	// someone else changes the command: it waits for the owner again; the owner's own change does not
	r = e.do("PATCH", "/api/v1/triggers/"+id, e.zw.session, map[string]any{"check_cmd": "curl -s https://ci.example.com/main/status"})
	check(t, "张伟 changes the command: it waits for 王磊 again", r.status == 200 && r.body["check_waits"] == true, r)
	day()
	check(t, "meanwhile nothing runs", len(checks(e.token)) == 0)
	e.do("POST", "/api/v1/triggers/"+id+"/confirm", e.wl.session, nil)
	r = e.do("PATCH", "/api/v1/triggers/"+id, e.wl.session, map[string]any{"check_cmd": "ls out/"})
	check(t, "王磊's own change needs no confirmation", r.status == 200 && r.body["check_waits"] == nil && r.body["check_cmd"] == "ls out/", r)
	check(t, "a PR trigger can't be given one", e.do("PATCH", "/api/v1/triggers/"+id, e.wl.session, map[string]any{"check_cmd": strings.Repeat("x", 1001)}).status == 400)
}
