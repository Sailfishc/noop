package hub

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

// Checkpoints: the machine records the latest one (a wip commit, a packed directory, or why there is none); only the
// latest is kept, only the task's own machine stores one, nobody reads a packed directory back, and it goes a week
// after the task ended.
func TestCheckpoints(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	m := e.post(e.wl.session, "@acha 写个周报", "")
	id := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.wl.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	r := e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	check(t, "claimed, and told whether it may keep the directory here (a person's own computer: yes)", r.status == 200 && r.body["checkpoint_files"] == true, r)
	check(t, "no checkpoint yet", e.task(id)["checkpoint"] == nil)

	sha := strings.Repeat("a", 40)
	r = e.do("POST", "/api/v1/tasks/"+id+"/checkpoint", e.token, map[string]any{"repos": []any{map[string]any{"repo": "corp/pay", "branch": "agent/" + id + "-wip", "commit": sha, "head": strings.Repeat("b", 40)}}})
	check(t, "a repository checkpoint is recorded", r.status == 200, r)
	c := e.task(id)["checkpoint"].(map[string]any)
	check(t, "with its time, machine and commit", num(c["at"]) > 0 && c["machine"] == e.mid && c["repos"].([]any)[0].(map[string]any)["commit"] == sha, r)
	r = e.do("POST", "/api/v1/tasks/"+id+"/checkpoint", e.token, map[string]any{"repos": []any{map[string]any{"repo": "x", "branch": "main", "commit": sha}}})
	check(t, "only on agent/ branches", r.status == 400, r)
	r = e.do("POST", "/api/v1/tasks/"+id+"/checkpoint", e.otherToken, map[string]any{"repos": []any{}})
	check(t, "another machine records none", r.status == 403, r)

	updated := num(e.task(id)["updated"])
	e.advance(10 * time.Minute)
	r = e.do("POST", "/api/v1/tasks/"+id+"/checkpoint", e.token, map[string]any{"unchanged": true})
	check(t, "a checkpoint does not touch the task's updated time", num(e.task(id)["updated"]) == updated)
	c2 := e.task(id)["checkpoint"].(map[string]any)
	check(t, "still current: checked moves, at stays", r.status == 200 && num(c2["checked"]) > num(c2["at"]) && num(c2["at"]) == num(c["at"]), r)

	// a packed directory: stored apart, named by the record, the latest only
	up := func(data string) string {
		r := e.do("POST", "/api/v1/tasks/"+id+"/checkpoint/files", e.token, bytes.NewBufferString(data))
		check(t, "the packed directory is stored", r.status == 200 && num(r.body["size"]) == int64(len(data)), r)
		return r.body["id"].(string)
	}
	f1 := up("first")
	check(t, "another machine stores none", e.do("POST", "/api/v1/tasks/"+id+"/checkpoint/files", e.otherToken, bytes.NewBufferString("x")).status == 403)
	r = e.do("POST", "/api/v1/tasks/"+id+"/checkpoint", e.token, map[string]any{"repos": []any{}, "files": map[string]any{"id": f1, "size": 5}})
	check(t, "a files checkpoint", r.status == 200 && e.task(id)["checkpoint"].(map[string]any)["files"].(map[string]any)["id"] == f1, r)
	r = e.do("POST", "/api/v1/tasks/"+id+"/checkpoint", e.token, map[string]any{"files": map[string]any{"id": "ckpt-T-9999-1-abc", "size": 1}})
	check(t, "only a file of its own", r.status == 400, r)
	f2 := up("second")
	e.do("POST", "/api/v1/tasks/"+id+"/checkpoint", e.token, map[string]any{"files": map[string]any{"id": f2, "size": 6}})
	check(t, "the older one is gone", e.h.count("SELECT COUNT(*) FROM checkpoint_blobs WHERE task_id = ?", id) == 1 && e.h.count("SELECT COUNT(*) FROM checkpoint_blobs WHERE id = ?", f1) == 0)
	for _, s := range []string{e.wl.session, e.zw.session} {
		check(t, "nobody reads it as media, not even an admin", e.do("GET", "/api/v1/media/"+f2, s, nil).status == 404)
	}

	// why there is none
	e.do("POST", "/api/v1/tasks/"+id+"/checkpoint", e.token, map[string]any{"error": "工作目录压缩后超过 100 MB，没有存"})
	c = e.task(id)["checkpoint"].(map[string]any)
	check(t, "the reason is kept, the file gone", c["error"] != "" && c["files"] == nil && e.h.count("SELECT COUNT(*) FROM checkpoint_blobs WHERE task_id = ?", id) == 0)

	// the machine's switch: its owner turns it off; a team machine starts off
	r = e.do("PATCH", "/api/v1/machines/"+e.mid, e.ll.session, map[string]any{"checkpoint_files": false})
	check(t, "not someone else's machine", r.status == 403, r)
	r = e.do("PATCH", "/api/v1/machines/"+e.mid, e.wl.session, map[string]any{"checkpoint_files": false})
	check(t, "its owner turns it off", r.status == 200 && r.body["machine"].(map[string]any)["checkpoint_files"] == false, r)
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "好了"})
	e.post(e.wl.session, "再改改", m["id"].(string))
	check(t, "the next claim says so", e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil).body["checkpoint_files"] == false)
	r = e.do("PATCH", "/api/v1/machines/"+e.mid, e.zw.session, map[string]any{"team": true})
	e.h.must(e.h.db.Exec("UPDATE machines SET checkpoint_files = NULL WHERE id = ?", e.mid))
	ms := e.do("GET", "/api/v1/machines", e.zw.session, nil).body["machines"].([]any)
	for _, x := range ms {
		if mm := x.(map[string]any); mm["id"] == e.mid {
			check(t, "a team machine starts off", mm["team"] == true && mm["checkpoint_files"] == false, r)
		}
	}

	// a week after the task ended, its packed directory goes
	f3 := up("third")
	e.do("POST", "/api/v1/tasks/"+id+"/checkpoint", e.token, map[string]any{"files": map[string]any{"id": f3, "size": 5}})
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "好了"})
	e.do("POST", "/api/v1/tasks/"+id+"/accept", e.wl.session, nil)
	check(t, "accepted", e.task(id)["state"] == "done")
	e.advance(time.Hour)
	f4 := up("fourth") // the last checkpoint after it ended: the task stays where it was in lists, the week stays
	done := num(e.task(id)["updated"])
	e.do("POST", "/api/v1/tasks/"+id+"/checkpoint", e.token, map[string]any{"files": map[string]any{"id": f4, "size": 6}})
	check(t, "an ended task's updated time stays", num(e.task(id)["updated"]) == done)
	e.h.Tick()
	check(t, "kept for now", e.h.count("SELECT COUNT(*) FROM checkpoint_blobs WHERE task_id = ?", id) == 1)
	r = e.do("GET", "/api/v1/machine/tasks?ended="+id+"&age=0", e.token, nil)
	check(t, "the machine hears it ended (to drop its wip branches)", len(r.body["tasks"].([]any)) == 1, r)
	check(t, "though its folder is kept a week", len(e.do("GET", "/api/v1/machine/tasks?ended="+id, e.token, nil).body["tasks"].([]any)) == 0)
	e.advance(checkpointKeep + time.Hour)
	e.h.Tick()
	check(t, "gone a week later", e.h.count("SELECT COUNT(*) FROM checkpoint_blobs WHERE task_id = ?", id) == 0)
}

// A task in a private channel: its checkpoint does not reach people outside it.
func TestCheckpointPrivate(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	p := newPrivEnv(t, e)
	r := e.do("POST", "/api/v1/tasks/"+p.tid+"/checkpoint", e.token, map[string]any{"repos": []any{map[string]any{"repo": "corp/zebra", "branch": "agent/" + p.tid + "-wip", "commit": strings.Repeat("c", 40)}}})
	check(t, "recorded after it stopped too", r.status == 200, r)
	check(t, "its member sees it", e.do("GET", "/api/v1/tasks/"+p.tid, e.wl.session, nil).body["checkpoint"] != nil)
	for _, s := range []string{e.ll.session, e.zw.session} {
		r := e.do("GET", "/api/v1/tasks/"+p.tid, s, nil)
		check(t, "outsiders do not", r.body["checkpoint"] == nil && !strings.Contains(string(r.raw), "zebra"), r)
	}
}
