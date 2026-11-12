package hub

import (
	"bytes"
	"fmt"
	"strings"
	"testing"
)

func TestTaskOutputs(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	m := e.post(e.wl.session, "@acha 整理一份事故复盘，再出一张示意图", "")
	id := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)

	// files from out/: the same name again is a new version
	up := func(name, body string) resp {
		return e.do("POST", "/api/v1/tasks/"+id+"/outputs/file?name="+name, e.token, bytes.NewBufferString(body), "content-type", "")
	}
	r := up("report.md", "# 复盘 v1")
	check(t, "uploaded", r.status == 200, r)
	fid := r.body["id"].(string)
	check(t, "a second version", up("report.md", "# 复盘 v2").body["id"] == fid)
	check(t, "a path under out/", up("data/a.csv", "a,b\n1,2").status == 200)
	check(t, "not outside it", up("../x", "x").status == 400)
	check(t, "people can't upload as the machine", e.do("POST", "/api/v1/tasks/"+id+"/outputs/file?name=y", e.wl.session, bytes.NewBufferString("y")).status == 403)
	check(t, "another machine can't either", e.do("POST", "/api/v1/tasks/"+id+"/outputs/file?name=y", e.otherToken, bytes.NewBufferString("y")).status == 403)

	// an external result: by its id there; reported again, it changes
	r = e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"outputs": []any{
		map[string]any{"kind": "external", "title": "示意图模型", "service": "3D 云", "external_id": "job-1", "status": "pending", "url": "javascript:alert(1)"}}})
	check(t, "external reported", r.status == 200, r)
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"outputs": []any{
		map[string]any{"external_id": "job-1", "title": "示意图模型", "status": "ready", "url": "https://3d.example.com/m/1"}}})

	tk := e.task(id)
	os := tk["outputs"].([]any)
	check(t, "three outputs", len(os) == 3)
	f := os[0].(map[string]any)
	check(t, "the file: latest version, its type", f["kind"] == "file" && f["title"] == "report.md" && f["version"] == float64(2) && strings.HasPrefix(f["mime"].(string), "text/markdown"))
	x := os[2].(map[string]any)
	check(t, "the external result: ready, a safe link only", x["kind"] == "external" && x["status"] == "ready" && x["url"] == "https://3d.example.com/m/1" && x["service"] == "3D 云")

	// a preview for the external result
	png := "\x89PNG\r\n\x1a\n" + strings.Repeat("\x00", 20)
	r = e.do("POST", "/api/v1/tasks/"+id+"/outputs/preview?external_id=job-1", e.token, bytes.NewBufferString(png))
	check(t, "preview", r.status == 200, r)
	check(t, "not a picture", e.do("POST", "/api/v1/tasks/"+id+"/outputs/preview?external_id=job-1", e.token, bytes.NewBufferString("hello")).status == 415)

	// people read through a short-lived link
	r = e.do("GET", "/api/v1/outputs/"+fid+"/link", e.ll.session, nil)
	check(t, "a link", r.status == 200, r)
	link := r.body["url"].(string)
	r = e.do("GET", link, "", nil)
	check(t, "the latest version, no session needed", r.status == 200 && string(r.raw) == "# 复盘 v2", r)
	r = e.do("GET", e.do("GET", "/api/v1/outputs/"+fid+"/link?v=1", e.ll.session, nil).body["url"].(string), "", nil)
	check(t, "an older version", string(r.raw) == "# 复盘 v1", r)
	check(t, "a changed link fails", e.do("GET", strings.Replace(link, "v=0", "v=1", 1), "", nil).status == 403)
	check(t, "machines don't make links", e.do("GET", "/api/v1/outputs/"+fid+"/link", e.token, nil).status == 403)
	r = e.do("GET", e.do("GET", "/api/v1/outputs/"+x["id"].(string)+"/link?preview=1", e.ll.session, nil).body["url"].(string), "", nil)
	check(t, "the preview", r.status == 200 && r.header.Get("content-type") == "image/png", r)

	// a PR is an output too, first
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"pr": map[string]any{"provider": "github", "url": "https://github.com/acme/pay/pull/3", "number": 3, "state": "open", "checks": "pending"}})
	os = e.task(id)["outputs"].([]any)
	check(t, "the PR first", len(os) == 4 && os[0].(map[string]any)["kind"] == "pr" && os[0].(map[string]any)["title"] == "PR #3")
}

func TestMessageOutputs(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	// Plain untracked conversation answer carrying a file output attaches the output directly to the agent's message.
	asTask := false
	m := e.do("POST", "/api/v1/channels/"+e.cid+"/messages", e.wl.session, map[string]any{"text": "@acha 出一份简短总结文档", "as_task": &asTask}).body
	id := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)

	r := e.do("POST", "/api/v1/tasks/"+id+"/outputs/file?name=summary.md", e.token, bytes.NewBufferString("# 总结 v1"))
	check(t, "uploaded v1", r.status == 200, r)
	fid := r.body["id"].(string)
	r = e.do("POST", "/api/v1/tasks/"+id+"/outputs/file?name=summary.md", e.token, bytes.NewBufferString("# 总结 v2"))
	check(t, "uploaded v2", r.status == 200 && r.body["id"] == fid, r)

	r = e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "answer": true, "summary": "总结文档已生成", "run": 1})
	check(t, "plain answer reported", r.status == 200, r)

	msgs := e.do("GET", "/api/v1/channels/"+e.cid+"/messages", e.wl.session, nil).body["messages"].([]any)
	var reply map[string]any
	for _, raw := range msgs {
		msg := raw.(map[string]any)
		if msg["text"] == "总结文档已生成" {
			reply = msg
			break
		}
	}
	check(t, "top-level answer posted", reply != nil && reply["thread_id"] == nil, resp{raw: []byte(fmt.Sprint(msgs))})
	outs, _ := reply["outputs"].([]any)
	check(t, "output attached to answer message", len(outs) == 1, resp{raw: []byte(fmt.Sprint(reply))})
	fo := outs[0].(map[string]any)
	check(t, "output has version metadata", fo["id"] == fid && fo["version"] == float64(2) && fo["message_id"] == reply["id"], resp{raw: []byte(fmt.Sprint(fo))})
	vers, _ := fo["versions"].([]any)
	check(t, "two version entries", len(vers) == 2, resp{raw: []byte(fmt.Sprint(fo))})
}

func TestChannelOutputsAndTaskPlan(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	m := e.post(e.wl.session, "@acha 排查慢查询并出一份报告", "")
	id := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)

	// Runtime checklist plan updates in place on the task without posting chat messages.
	r := e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{
		"track": true,
		"step":  "加索引",
		"plan": []any{
			map[string]any{"text": "排查慢查询", "status": "done"},
			map[string]any{"text": "加索引", "status": "in_progress"},
			map[string]any{"text": "压测验证", "status": "pending"},
		},
	})
	check(t, "plan reported", r.status == 200, r)
	tk := e.task(id)
	plan, _ := tk["plan"].([]any)
	check(t, "three plan items persisted", len(plan) == 3 &&
		plan[0].(map[string]any)["status"] == "done" &&
		plan[1].(map[string]any)["text"] == "加索引" &&
		plan[1].(map[string]any)["status"] == "in_progress", resp{raw: []byte(fmt.Sprint(tk))})

	// Upload a file output, report an external output and a PR, then finish.
	r = e.do("POST", "/api/v1/tasks/"+id+"/outputs/file?name=bench.md", e.token, bytes.NewBufferString("# 压测结果"))
	check(t, "file uploaded", r.status == 200, r)
	r = e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{
		"state":   "review",
		"summary": "压测和 PR 已就绪",
		"run":     1,
		"outputs": []any{map[string]any{"kind": "external", "title": "火焰图", "service": "Perf", "external_id": "fg-1", "status": "ready", "url": "https://perf.example.com/1"}},
		"pr":      map[string]any{"provider": "github", "url": "https://github.com/acme/pay/pull/8", "number": 8, "state": "open", "checks": "success"},
	})
	check(t, "task finished with outputs", r.status == 200, r)

	// Channel files endpoint aggregates file, external, and PR outputs with thread_id and task_id.
	co := e.do("GET", "/api/v1/channels/"+e.cid+"/outputs", e.ll.session, nil)
	check(t, "channel outputs ok", co.status == 200, co)
	list, _ := co.body["outputs"].([]any)
	check(t, "three channel outputs aggregated", len(list) == 3, co)
	kinds := map[string]bool{}
	for _, raw := range list {
		o := raw.(map[string]any)
		kinds[o["kind"].(string)] = true
		check(t, "carries task_id and thread_id", o["task_id"] == id && o["thread_id"] == m["id"], resp{raw: []byte(fmt.Sprint(o))})
	}
	check(t, "includes file, external, and pr", kinds["file"] && kinds["external"] && kinds["pr"], resp{raw: []byte(fmt.Sprint(list))})

	// Private channel outputs return 404 to non-members (including admins not in the private channel).
	priv := e.do("POST", "/api/v1/channels", e.wl.session, map[string]any{
		"name":    "私有排查",
		"private": true,
		"members": []any{map[string]any{"kind": "agent", "id": e.aid}},
	}).body["id"].(string)
	check(t, "outsider gets 404 on private channel outputs", e.do("GET", "/api/v1/channels/"+priv+"/outputs", e.ll.session, nil).status == 404)
	check(t, "non-member admin also gets 404", e.do("GET", "/api/v1/channels/"+priv+"/outputs", e.zw.session, nil).status == 404)
	check(t, "member gets 200 on private channel outputs", e.do("GET", "/api/v1/channels/"+priv+"/outputs", e.wl.session, nil).status == 200)
}
