package hub

import (
	"bytes"
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
