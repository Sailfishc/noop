package hub

import (
	"bytes"
	"net/url"
	"testing"
)

func TestAttachments(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	up := func(name, body, typ string) resp {
		return e.do("POST", "/api/v1/uploads?name="+url.QueryEscape(name), e.zw.session, bytes.NewBufferString(body), "content-type", typ)
	}
	r := up("需求说明.pdf", "%PDF-1.4 hello", "application/pdf")
	check(t, "a person uploads any file", r.status == 200 && r.body["name"] == "需求说明.pdf" && r.body["mime"] == "application/pdf" && r.body["size"] == float64(14), r)
	pdf := r.body["path"].(string)
	png := up("截图.png", "\x89PNG\r\n\x1a\nxx", "").body["path"].(string)
	check(t, "a machine cannot upload", e.do("POST", "/api/v1/uploads?name=x", e.token, bytes.NewBufferString("x")).status == 403)
	check(t, "a name is needed", up("", "x", "").status == 400)
	check(t, "an empty file is not", up("a.txt", "", "").status == 400)

	r = e.do("POST", "/api/v1/channels/"+e.cid+"/messages", e.zw.session, map[string]any{"text": "@acha 按这个文档改", "attachments": []any{pdf, png}})
	check(t, "a message carries them", r.status == 200 && len(r.body["attachments"].([]any)) == 2, r)
	mid := r.body["id"].(string)
	r = e.do("POST", "/api/v1/channels/"+e.cid+"/messages", e.zw.session, map[string]any{"text": "", "attachments": []any{png}})
	check(t, "files alone are a message", r.status == 200, r)

	r = e.do("GET", "/api/v1/messages/"+mid+"/attachments", e.wl.session, nil)
	list := r.body["attachments"].([]any)
	first := list[0].(map[string]any)
	check(t, "names, types, sizes and links", len(list) == 2 && first["name"] == "需求说明.pdf" && list[1].(map[string]any)["mime"] == "image/png", r)
	r = e.do("GET", first["url"].(string), "", nil)
	check(t, "the link works without a session", r.status == 200 && string(r.raw) == "%PDF-1.4 hello", r)
	check(t, "a forged link does not", e.do("GET", "/api/v1/media/"+pdf[7:]+"/signed?exp=9999999999&sig=x", "", nil).status == 403)
	r = e.do("GET", "/api/v1/media/"+pdf[7:], e.token, nil)
	check(t, "the machine fetches it into in/", r.status == 200 && string(r.raw) == "%PDF-1.4 hello", r)
	check(t, "not without a credential", e.do("GET", "/api/v1/media/"+pdf[7:], "", nil).status == 401)
}
