package hub

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"net/url"
	"strings"
	"testing"
)

func pngOf(w, h int) string {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 200, 255})
		}
	}
	var b bytes.Buffer
	_ = png.Encode(&b, img)
	return b.String()
}

func TestAttachmentPreviews(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	up := func(name, body, typ string) string {
		r := e.do("POST", "/api/v1/uploads?name="+url.QueryEscape(name), e.zw.session, bytes.NewBufferString(body), "content-type", typ)
		return r.body["path"].(string)
	}
	var log strings.Builder
	for i := 1; i <= 60; i++ {
		log.WriteString("line ")
		log.WriteString(strings.Repeat("x", i%7))
		log.WriteString("\n")
	}
	big, small := up("大图.png", pngOf(1200, 600), "image/png"), up("小图.png", pngOf(100, 50), "image/png")
	logf, md := up("run.log", log.String(), "text/plain"), up("说明.md", "# 标题\n\n一行", "")
	bin, pdf := up("data.txt", "a\x00b", "text/plain"), up("spec.pdf", "%PDF-1.4 x", "application/pdf")
	broken := up("坏.png", "\x89PNG\r\n\x1a\nnot really", "image/png")
	m := e.do("POST", "/api/v1/channels/"+e.cid+"/messages", e.zw.session, map[string]any{"text": "看附件", "attachments": []any{big, small, logf, md, bin, pdf, broken}}).body
	r := e.do("GET", "/api/v1/messages/"+m["id"].(string)+"/attachments", e.wl.session, nil)
	at := map[string]map[string]any{}
	for _, a := range r.body["attachments"].([]any) {
		at[a.(map[string]any)["name"].(string)] = a.(map[string]any)
	}

	b := at["大图.png"]
	check(t, "a big picture: its size, and a thumbnail link", b["width"] == float64(1200) && b["height"] == float64(600) && strings.HasSuffix(b["thumb"].(string), "&thumb=1"), r)
	th := e.do("GET", b["thumb"].(string), "", nil)
	cfg, _, err := image.DecodeConfig(bytes.NewReader(th.raw))
	check(t, "the thumbnail is 480 wide", th.status == 200 && err == nil && cfg.Width == 480 && cfg.Height == 240, th)
	check(t, "a small one is its own thumbnail", at["小图.png"]["thumb"] == at["小图.png"]["url"] && at["小图.png"]["width"] == float64(100))
	check(t, "a broken picture gets none", at["坏.png"]["thumb"] == nil)

	l := at["run.log"]
	check(t, "a log: its first 40 lines, and that there is more", strings.Count(l["preview"].(string), "\n") == 39 && l["more"] == true, r)
	check(t, "markdown by its name", at["说明.md"]["preview"] == "# 标题\n\n一行" && at["说明.md"]["more"] == false, r)
	check(t, "not a binary that says text", at["data.txt"]["preview"] == nil)
	check(t, "nor a pdf", at["spec.pdf"]["preview"] == nil && at["spec.pdf"]["thumb"] == nil)

	r = e.do("GET", "/api/v1/messages/"+m["id"].(string)+"/attachments", e.wl.session, nil)
	check(t, "made once, kept", r.status == 200 && e.h.count("SELECT COUNT(*) FROM thumbs") == 3)
}
