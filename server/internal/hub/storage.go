package hub

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// Stored files (attachments, task outputs, previews): kept in the media table in 1 MB chunks.

var uploadTypes = regexp.MustCompile(`^image/(png|jpeg|gif|webp|heic|heif|avif|bmp)$`)

const (
	chunk          = 1_000_000
	maxUpload      = 10 * 1024 * 1024
	maxAttachments = 10
)

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

func (h *Hub) storeMedia(id, typ string, data []byte) {
	for n, i := 0, 0; ; n, i = n+1, i+chunk {
		e := min(i+chunk, len(data))
		h.must(h.db.Exec("INSERT INTO media (id, n, type, data) VALUES (?, ?, ?, ?)", id, n, typ, data[i:e]))
		if e == len(data) {
			return
		}
	}
}

var clientIDRE = regexp.MustCompile(`^[\w:-]{1,100}$`)

// present: a JSON value that is there and truthy enough to store (not null, false, 0 or "").
func present(m json.RawMessage) bool {
	s := string(m)
	return len(m) > 0 && s != "null" && s != "false" && s != "0" && s != `""`
}

func isBlank(s string) bool {
	for _, r := range s {
		if r != ' ' && r != '\t' && r != '\n' && r != '\r' && r != '　' && r != ' ' {
			return false
		}
	}
	return true
}

func clampInt(s string, def, lo, hi int) int {
	n, err := strconv.Atoi(s)
	if err != nil || n == 0 {
		n = def
	}
	return max(lo, min(hi, n))
}
