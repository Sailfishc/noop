package hub

import (
	"bytes"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Files people attach to a message: uploaded first (POST /api/v1/uploads), then named in the message's attachments
// as "/media/<id>". Machines fetch them into a task's in/ (GET /api/v1/media/{id}); people's apps show them through a
// short-lived link, the way task outputs are opened (an <Image> cannot send a session header).

const maxAttachment = 50 << 20 // one file a person attaches

// v1Upload: the request's body is the file; ?name= its name. Any type: the agent reads what it can.
func (h *Hub) v1Upload(w http.ResponseWriter, q *request) {
	name := path.Base(strings.TrimSpace(q.query("name")))
	if name == "" || name == "." || name == "/" || utf8.RuneCountInString(name) > 200 {
		errJSON(w, 400, "name required")
		return
	}
	if len(q.body) == 0 {
		errJSON(w, 400, "empty file")
		return
	}
	if len(q.body) > maxAttachment {
		errJSON(w, 413, "文件太大（50 MB 以内）")
		return
	}
	typ := strings.TrimSpace(q.r.Header.Get("content-type"))
	if typ == "" || typ == "application/json" || typ == "application/octet-stream" {
		typ = mime.TypeByExtension(path.Ext(name))
	}
	if typ == "" {
		typ = http.DetectContentType(q.body)
	}
	if strings.HasPrefix(typ, "image/") {
		typ = sniffImage(q.body[:min(len(q.body), 32)], typ)
	}
	id := h.uploadID(name)
	h.storeMedia(id, typ, q.body)
	h.must(h.db.Exec("INSERT INTO uploads (id, name, user_id, created) VALUES (?, ?, ?, ?)", id, name, q.who.userID, h.nowMs()))
	writeJSON(w, 200, h.attachmentInfo(id, typ, len(q.body), ""))
}

// attachmentInfo: what an app shows for "/media/<id>": its name as uploaded, type, size, and a link.
func (h *Hub) attachmentInfo(id, typ string, size int, link string) obj {
	var name string
	if h.db.QueryRow("SELECT name FROM uploads WHERE id = ?", id).Scan(&name) != nil {
		name = id
		if parts := strings.SplitN(id, "-", 3); len(parts) == 3 {
			name = parts[2]
		}
	}
	o := obj{"path": "/media/" + id, "name": name, "mime": typ, "size": size}
	if link != "" {
		o["url"] = link
	}
	return o
}

// v1MessageAttachments: a message's files, each with a link (15 minutes) to show or download it.
func (h *Hub) v1MessageAttachments(w http.ResponseWriter, q *request) {
	m, ok := h.message(q.r.PathValue("id"))
	if !ok || !h.canRead(q.who, m.ChannelID) {
		errJSON(w, 404, "not found")
		return
	}
	out := []obj{}
	for _, a := range m.Attachments {
		id := strings.TrimPrefix(a, "/media/")
		var typ string
		var size int
		if h.db.QueryRow("SELECT MIN(type), COALESCE(SUM(LENGTH(data)), 0) FROM media WHERE id = ?", id).Scan(&typ, &size) != nil || size == 0 {
			continue
		}
		exp := h.nowMs()/1000 + outputLinkTTL
		link := fmt.Sprintf("/api/v1/media/%s/signed?exp=%d&sig=%s", url.PathEscape(id), exp, h.linkSig("media:"+id, 0, exp))
		out = append(out, h.attachmentInfo(id, typ, size, link))
	}
	writeJSON(w, 200, obj{"attachments": out})
}

// v1Media: the bytes of an attachment, for a person or a machine (fetching it into a task's in/).
func (h *Hub) v1Media(w http.ResponseWriter, q *request) {
	h.sendMedia(w, q.r.PathValue("id"))
}

// v1MediaSigned: the bytes behind a link from v1MessageAttachments.
func (h *Hub) v1MediaSigned(w http.ResponseWriter, q *request) {
	id := q.r.PathValue("id")
	exp, _ := strconv.ParseInt(q.query("exp"), 10, 64)
	if exp < h.nowMs()/1000 || q.query("sig") != h.linkSig("media:"+id, 0, exp) {
		errJSON(w, 403, "这个链接已经过期，请回到 TeamAgent 重新打开")
		return
	}
	h.sendMedia(w, id)
}

func (h *Hub) sendMedia(w http.ResponseWriter, id string) {
	if !attachmentRE.MatchString("/media/" + id) {
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
	for rows.Next() {
		var t string
		var d []byte
		if err := rows.Scan(&t, &d); err != nil {
			panic(err)
		}
		typ = t
		buf.Write(d)
	}
	if typ == "" {
		errJSON(w, 404, "not found")
		return
	}
	mediaHeaders(w, typ, h.attachmentInfo(id, typ, 0, "")["name"].(string))
	w.Header().Set("content-length", strconv.Itoa(buf.Len()))
	_, _ = w.Write(buf.Bytes())
}
