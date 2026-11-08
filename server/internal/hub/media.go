package hub

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Media (cloud/src/uploads.ts): the owner's images for a message, and files the fleet attaches to events.
// Stored in 1 MB chunks, as the Worker did, so the tables stay interchangeable.

const (
	chunk          = 1_000_000
	maxMedia       = 30_000_000
	maxUpload      = 10 * 1024 * 1024
	maxAttachments = 10
)

var uploadTypes = regexp.MustCompile(`^image/(png|jpeg|gif|webp|heic|heif|avif|bmp)$`)

// sniffImage: the real type from the first bytes (phones often send no type, or a wrong one).
func sniffImage(head []byte, declared string) string {
	at := func(i int) int {
		if i < len(head) {
			return int(head[i])
		}
		return -1
	}
	ascii := func(i, n int) string {
		if i >= len(head) {
			return ""
		}
		e := i + n
		if e > len(head) {
			e = len(head)
		}
		return string(head[i:e])
	}
	switch {
	case at(0) == 0x89 && ascii(1, 3) == "PNG":
		return "image/png"
	case at(0) == 0xff && at(1) == 0xd8 && at(2) == 0xff:
		return "image/jpeg"
	case ascii(0, 4) == "GIF8":
		return "image/gif"
	case ascii(0, 4) == "RIFF" && ascii(8, 4) == "WEBP":
		return "image/webp"
	case ascii(0, 2) == "BM":
		return "image/bmp"
	case ascii(4, 4) == "ftyp":
		brand := ascii(8, 4)
		switch brand {
		case "mif1", "msf1":
			return "image/heif"
		case "heic", "heix", "hevc", "heim", "heis":
			return "image/heic"
		case "avif", "avis":
			return "image/avif"
		}
	}
	if declared == "image/jpg" {
		return "image/jpeg"
	}
	return declared
}

func uploadProblem(typ string, size int) (int, string) {
	if !uploadTypes.MatchString(typ) {
		return 415, "images only (png, jpeg, gif, webp, heic, bmp)"
	}
	if size > maxUpload {
		return 413, "image too large (10 MB max)"
	}
	if size == 0 {
		return 400, "empty file"
	}
	return 0, ""
}

var unsafeName = regexp.MustCompile(`[^\w.\-]`)

func safeName(name string) string { return unsafeName.ReplaceAllString(name, "_") }

func (h *Hub) uploadID(name string) string {
	if name == "" {
		name = "image"
	}
	n := safeName(name)
	if len(n) > 80 {
		n = n[len(n)-80:]
	}
	return fmt.Sprintf("%d-%s-%s", h.nowMs(), uuid4()[:8], n)
}

var attachmentRE = regexp.MustCompile(`^/media/\w[\w.\-]*$`)

// ownerAttachments: up to 10 paths of the hub's own media ("/media/<id>"); ok=false when malformed.
func ownerAttachments(raw json.RawMessage) ([]string, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, true
	}
	var list []any
	if json.Unmarshal(raw, &list) != nil || len(list) > maxAttachments {
		return nil, false
	}
	out := make([]string, 0, len(list))
	for _, x := range list {
		s, ok := x.(string)
		if !ok || !attachmentRE.MatchString(s) || strings.Contains(s, "..") {
			return nil, false
		}
		out = append(out, s)
	}
	return out, true
}

var inlineTypes = regexp.MustCompile(`^(image/(png|jpe?g|gif|webp|avif|heic|heif|bmp)|video/[\w.+-]+|audio/[\w.+-]+|application/pdf|text/plain)(;|$)`)

// mediaHeaders: anything a browser could run as a page is sent as a download, and every response is sandboxed.
func mediaHeaders(w http.ResponseWriter, typ, name string) {
	t := strings.ToLower(typ)
	if t == "" {
		t = "application/octet-stream"
	}
	inline := inlineTypes.MatchString(t)
	disp := "attachment"
	if inline {
		disp = "inline"
	} else {
		t = "application/octet-stream"
	}
	hd := w.Header()
	hd.Set("content-type", t)
	hd.Set("content-disposition", fmt.Sprintf(`%s; filename="%s"`, disp, safeName(name)))
	hd.Set("x-content-type-options", "nosniff")
	hd.Set("content-security-policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'")
	hd.Set("cache-control", "private, max-age=31536000")
}

// formFile reads the multipart field "file" from an already-read body.
func formFile(q *request) (name, typ string, data []byte, err error) {
	ct, params, err := mime.ParseMediaType(q.r.Header.Get("content-type"))
	if err != nil || !strings.HasPrefix(ct, "multipart/") {
		return "", "", nil, fmt.Errorf("multipart body expected")
	}
	mr := multipart.NewReader(bytes.NewReader(q.body), params["boundary"])
	for {
		part, err := mr.NextPart()
		if err != nil {
			return "", "", nil, fmt.Errorf("file required")
		}
		if part.FormName() != "file" || part.FileName() == "" {
			continue
		}
		data, err := io.ReadAll(part)
		if err != nil {
			return "", "", nil, err
		}
		return part.FileName(), part.Header.Get("content-type"), data, nil
	}
}

func (h *Hub) storeMedia(id, typ string, data []byte) {
	for n, i := 0, 0; ; n, i = n+1, i+chunk {
		e := min(i+chunk, len(data))
		h.must(h.db.Exec("INSERT INTO media (id, n, type, data) VALUES (?, ?, ?, ?)", id, n, typ, data[i:e]))
		if e == len(data) {
			return
		}
	}
}

// POST /api/uploads (multipart `file`): the owner's images, ≤ 10 MB → {url: "/media/<id>"}.
func (h *Hub) upload(w http.ResponseWriter, q *request) {
	name, declared, data, err := formFile(q)
	if err != nil {
		errJSON(w, 400, "file required")
		return
	}
	head := data
	if len(head) > 16 {
		head = head[:16]
	}
	typ := sniffImage(head, declared)
	if st, msg := uploadProblem(typ, len(data)); st != 0 {
		errJSON(w, st, msg)
		return
	}
	id := h.uploadID(name)
	h.storeMedia(id, typ, data)
	writeJSON(w, 200, obj{"url": "/media/" + id})
}

// POST /api/media (multipart `file`): any file up to 30 MB (the fleet's attachments).
func (h *Hub) postMedia(w http.ResponseWriter, q *request) {
	name, typ, data, err := formFile(q)
	if err != nil {
		errJSON(w, 400, "file required")
		return
	}
	if len(data) > maxMedia {
		errJSON(w, 413, "file too large")
		return
	}
	if typ == "" {
		typ = "application/octet-stream"
	}
	id := fmt.Sprintf("%d-%s", h.nowMs(), safeName(name))
	h.storeMedia(id, typ, data)
	writeJSON(w, 200, obj{"url": "/media/" + id})
}

func (h *Hub) getMedia(w http.ResponseWriter, q *request) {
	id, err := url.PathUnescape(strings.TrimPrefix(q.r.URL.EscapedPath(), "/media/"))
	if err != nil {
		errJSON(w, 404, "not found")
		return
	}
	rows, err := h.db.Query("SELECT type, data FROM media WHERE id = ? ORDER BY n", id)
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	var typ string
	var buf bytes.Buffer
	found := false
	for rows.Next() {
		var t string
		var d []byte
		if err := rows.Scan(&t, &d); err != nil {
			panic(err)
		}
		if !found {
			typ = t
		}
		found = true
		buf.Write(d)
	}
	if !found {
		errJSON(w, 404, "not found")
		return
	}
	mediaHeaders(w, typ, id)
	w.Header().Set("content-length", strconv.Itoa(buf.Len()))
	_, _ = w.Write(buf.Bytes())
}

// pruneMedia: media older than settings media_days (7, 14, 30 or 90; 7 by default) goes, checked at most hourly.
// Ids start with the upload's Unix milliseconds.
func (h *Hub) pruneMedia(force bool) {
	now := h.nowMs()
	var last int64
	h.kvGet("media_pruned", &last)
	if !force && now-last < time.Hour.Milliseconds() {
		return
	}
	h.kvSet("media_pruned", now)
	var s struct {
		Current   map[string]any `json:"current"`
		Effective map[string]any `json:"effective"`
	}
	h.kvGet("settings", &s)
	want := numberOf(s.Current["media_days"])
	if want == 0 {
		want = numberOf(s.Effective["media_days"])
	}
	days := int64(7)
	switch want {
	case 7, 14, 30, 90:
		days = want
	}
	h.must(h.db.Exec("DELETE FROM media WHERE instr(id, '-') = 14 AND CAST(substr(id, 1, 13) AS INTEGER) < ?", now-days*86_400_000))
}

func numberOf(v any) int64 {
	switch x := v.(type) {
	case json.Number:
		n, _ := x.Int64()
		return n
	case float64:
		return int64(x)
	case string:
		n, _ := strconv.ParseInt(x, 10, 64)
		return n
	}
	return 0
}
