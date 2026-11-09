package hub

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Go's built-in MIME table has no Markdown entry, so mime.TypeByExtension(".md") depends on the host's
// mime.types files: text/markdown on most Linux, nothing on macOS (then sniffed as text/plain). Register it so
// uploads and outputs get the same type everywhere.
func init() {
	for _, ext := range []string{".md", ".markdown"} {
		_ = mime.AddExtensionType(ext, "text/markdown; charset=utf-8")
	}
}

// A task's outputs: what came out of it and where it is. A file is kept here (its bytes in the media table, every
// version); a PR lives on its Git platform (the task's pr); an external result lives in a third-party service (its
// id and link, and a small preview kept here). The thread shows them all as the same kind of card.

const (
	maxOutputFile    = 50 << 20 // one file the machine uploads
	maxOutputsOfTask = 50
	outputLinkTTL    = 15 * 60 // seconds a download link works
)

var outputKinds = map[string]bool{"file": true, "external": true}
var outputStatuses = map[string]bool{"pending": true, "ready": true, "failed": true}

type outputVersion struct {
	Media string `json:"media"`
	Size  int64  `json:"size"`
	At    int64  `json:"at"`
}

type outputView struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`   // file | pr | external
	Title      string `json:"title"`  // what people see
	Status     string `json:"status"` // pending | ready | failed (a PR: open | merged | closed)
	URL        string `json:"url,omitempty"`
	Name       string `json:"name,omitempty"` // a file: its path under out/
	Mime       string `json:"mime,omitempty"`
	Size       int64  `json:"size,omitempty"`
	Version    int    `json:"version,omitempty"`     // a file: how many times it was uploaded
	Service    string `json:"service,omitempty"`     // an external result: which service keeps it
	ExternalID string `json:"external_id,omitempty"` // and its id there
	Note       string `json:"note,omitempty"`        // progress or why it failed
	Preview    bool   `json:"preview,omitempty"`     // a preview image is kept here
	Updated    int64  `json:"updated"`
	media      string
	preview    string
	versions   []outputVersion
}

func (h *Hub) outputs(taskID string) []outputView {
	rows, err := h.db.Query(`SELECT id, kind, title, status, url, name, mime, size, version, service, external_id, note, media, preview,
		versions, updated FROM task_outputs WHERE task_id = ? ORDER BY created`, taskID)
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []outputView{}
	for rows.Next() {
		var o outputView
		var versions string
		if err := rows.Scan(&o.ID, &o.Kind, &o.Title, &o.Status, &o.URL, &o.Name, &o.Mime, &o.Size, &o.Version, &o.Service, &o.ExternalID,
			&o.Note, &o.media, &o.preview, &versions, &o.Updated); err != nil {
			panic(err)
		}
		_ = json.Unmarshal([]byte(versions), &o.versions)
		o.Preview = o.preview != ""
		out = append(out, o)
	}
	return out
}

// withOutputs: the tasks with their outputs, the PR first.
func (h *Hub) withOutputs(ts []taskView) []taskView {
	for i := range ts {
		os := []outputView{}
		if pr := ts[i].PR; pr != nil {
			title := pr.Title
			if title == "" {
				title = fmt.Sprintf("PR #%d", pr.Number)
			}
			os = append(os, outputView{ID: ts[i].ID + "-pr", Kind: "pr", Title: title, Status: pr.State, URL: pr.URL, Note: pr.Checks, Updated: ts[i].Updated})
		}
		ts[i].Outputs = append(os, h.outputs(ts[i].ID)...)
		ts[i].Events = h.taskEvents(ts[i].ID)
	}
	return ts
}

// v1OutputUpload: the machine uploads a file of the task's out/ (the raw body; ?name=report.md). The same name again
// is a new version.
func (h *Hub) v1OutputUpload(w http.ResponseWriter, q *request) {
	t, _, ok := h.machineTask(w, q)
	if !ok {
		return
	}
	h.storeOutput(w, q, t)
}

// storeOutput: the request's body as a file output of the task (?name=, ?title=), a new version if the name is known.
func (h *Hub) storeOutput(w http.ResponseWriter, q *request, t taskView) {
	name := strings.TrimSpace(q.query("name"))
	clean := path.Clean("/" + name)[1:]
	if name == "" || clean != name || strings.HasPrefix(clean, "..") || utf8.RuneCountInString(name) > 200 {
		errJSON(w, 400, "name: a relative path under out/")
		return
	}
	if len(q.body) > maxOutputFile {
		errJSON(w, 413, "file too large")
		return
	}
	typ := q.r.Header.Get("content-type")
	if typ == "" || typ == "application/json" {
		typ = mime.TypeByExtension(path.Ext(name))
	}
	if typ == "" {
		typ = http.DetectContentType(q.body)
	}
	media := "out_" + randHex(12)
	now := h.nowMs()
	var id, versions string
	var version int
	err := h.db.QueryRow("SELECT id, version, versions FROM task_outputs WHERE task_id = ? AND kind = 'file' AND name = ?", t.ID, name).Scan(&id, &version, &versions)
	if err != nil && h.count("SELECT COUNT(*) FROM task_outputs WHERE task_id = ?", t.ID) >= maxOutputsOfTask {
		errJSON(w, 409, "这个任务的产出太多了")
		return
	}
	h.storeMedia(media, typ, q.body)
	var vs []outputVersion
	_ = json.Unmarshal([]byte(versions), &vs)
	vs = append(vs, outputVersion{Media: media, Size: int64(len(q.body)), At: now})
	vj, _ := json.Marshal(vs)
	if err != nil {
		id = newID("o_")
		title := trimmed(q.query("title"), 120)
		if title == "" {
			title = path.Base(name)
		}
		h.must(h.db.Exec(`INSERT INTO task_outputs (id, task_id, kind, title, status, name, mime, size, version, media, versions, created, updated)
			VALUES (?, ?, 'file', ?, 'ready', ?, ?, ?, 1, ?, ?, ?, ?)`, id, t.ID, title, name, typ, len(q.body), media, string(vj), now, now))
	} else {
		h.must(h.db.Exec("UPDATE task_outputs SET mime = ?, size = ?, version = ?, media = ?, versions = ?, status = 'ready', updated = ? WHERE id = ?",
			typ, len(q.body), version+1, media, string(vj), now, id))
	}
	h.taskChanged(t.ID)
	writeJSON(w, 200, obj{"id": id})
}

// outputReport: an output the agent reports (an external result), by its external id, else its title.
type outputReport struct {
	Kind       string `json:"kind"`
	Title      string `json:"title"`
	Status     string `json:"status"`
	URL        string `json:"url"`
	Service    string `json:"service"`
	ExternalID string `json:"external_id"`
	Note       string `json:"note"`
}

func (h *Hub) applyOutputs(taskID string, rs []outputReport) {
	for _, r := range rs {
		if r.Kind == "" {
			r.Kind = "external"
		}
		if r.Kind != "external" { // files come as uploads, PRs from the machine's Git work
			continue
		}
		title, ext := trimmed(r.Title, 120), trimmed(r.ExternalID, 200)
		if title == "" && ext == "" {
			continue
		}
		if title == "" {
			title = ext
		}
		status := r.Status
		if !outputStatuses[status] {
			status = "pending"
		}
		u := trimmed(r.URL, 1000)
		if u != "" && !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
			u = ""
		}
		now := h.nowMs()
		var id string
		key, val := "external_id", ext
		if ext == "" {
			key, val = "title", title
		}
		if h.db.QueryRow("SELECT id FROM task_outputs WHERE task_id = ? AND kind = 'external' AND "+key+" = ?", taskID, val).Scan(&id) == nil {
			h.must(h.db.Exec("UPDATE task_outputs SET title = ?, status = ?, url = COALESCE(NULLIF(?, ''), url), service = COALESCE(NULLIF(?, ''), service), note = ?, updated = ? WHERE id = ?",
				title, status, u, trimmed(r.Service, 60), trimmed(r.Note, 300), now, id))
			continue
		}
		if h.count("SELECT COUNT(*) FROM task_outputs WHERE task_id = ?", taskID) >= maxOutputsOfTask {
			return
		}
		h.must(h.db.Exec(`INSERT INTO task_outputs (id, task_id, kind, title, status, url, service, external_id, note, created, updated)
			VALUES (?, ?, 'external', ?, ?, ?, ?, ?, ?, ?, ?)`, newID("o_"), taskID, title, status, u, trimmed(r.Service, 60), ext, trimmed(r.Note, 300), now, now))
	}
}

func (h *Hub) output(id string) (outputView, string, bool) {
	var taskID string
	if h.db.QueryRow("SELECT task_id FROM task_outputs WHERE id = ?", id).Scan(&taskID) != nil {
		return outputView{}, "", false
	}
	for _, o := range h.outputs(taskID) {
		if o.ID == id {
			return o, taskID, true
		}
	}
	return outputView{}, "", false
}

func (h *Hub) linkKey() []byte {
	var k string
	if !h.kvGet("output_link_key", &k) || k == "" {
		k = randHex(32)
		h.kvSet("output_link_key", k)
	}
	return []byte(k)
}

func (h *Hub) linkSig(id string, v int, exp int64) string {
	m := hmac.New(sha256.New, h.linkKey())
	fmt.Fprintf(m, "%s|%d|%d", id, v, exp)
	return hex.EncodeToString(m.Sum(nil))
}

// v1OutputLink: a link to a file output (or its preview, ?preview=1; an older version, ?v=2) that works for 15
// minutes without a session, for a browser or an image view.
func (h *Hub) v1OutputLink(w http.ResponseWriter, q *request) {
	o, taskID, ok := h.output(q.r.PathValue("id"))
	t, _ := h.task(taskID)
	if !ok || !h.canRead(q.who, t.ChannelID) {
		errJSON(w, 404, "not found")
		return
	}
	v := 0 // 0: the latest; -1: the preview
	if q.query("preview") == "1" {
		if o.preview == "" {
			errJSON(w, 404, "no preview")
			return
		}
		v = -1
	} else if s := q.query("v"); s != "" {
		v, _ = strconv.Atoi(s)
		if v < 1 || v > len(o.versions) {
			errJSON(w, 404, "no such version")
			return
		}
	} else if o.media == "" {
		errJSON(w, 404, "no file")
		return
	}
	exp := h.nowMs()/1000 + outputLinkTTL
	writeJSON(w, 200, obj{"url": fmt.Sprintf("/api/v1/outputs/%s/content?v=%d&exp=%d&sig=%s", o.ID, v, exp, h.linkSig(o.ID, v, exp))})
}

// v1OutputContent: the bytes behind a link from v1OutputLink.
func (h *Hub) v1OutputContent(w http.ResponseWriter, q *request) {
	id := q.r.PathValue("id")
	v, _ := strconv.Atoi(q.query("v"))
	exp, _ := strconv.ParseInt(q.query("exp"), 10, 64)
	if exp < h.nowMs()/1000 || !hmac.Equal([]byte(q.query("sig")), []byte(h.linkSig(id, v, exp))) {
		errJSON(w, 403, "这个链接已经过期，请回到 Remi 重新打开")
		return
	}
	o, _, ok := h.output(id)
	if !ok {
		errJSON(w, 404, "not found")
		return
	}
	media, name := o.media, o.Name
	switch {
	case v == -1:
		media, name = o.preview, "preview"
	case v > 0 && v <= len(o.versions):
		media = o.versions[v-1].Media
	}
	rows, err := h.db.Query("SELECT type, data FROM media WHERE id = ? ORDER BY n", media)
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
	if name == "" {
		name = o.Title
	}
	mediaHeaders(w, typ, path.Base(name))
	w.Header().Set("content-length", strconv.Itoa(buf.Len()))
	_, _ = w.Write(buf.Bytes())
}

// v1OutputPreview: the machine uploads a small preview image of an output (?output=<id> or ?external_id=…).
func (h *Hub) v1OutputPreview(w http.ResponseWriter, q *request) {
	t, _, ok := h.machineTask(w, q)
	if !ok {
		return
	}
	if len(q.body) > maxUpload {
		errJSON(w, 413, "preview too large")
		return
	}
	head := q.body
	if len(head) > 16 {
		head = head[:16]
	}
	typ := sniffImage(head, q.r.Header.Get("content-type"))
	if !uploadTypes.MatchString(typ) {
		errJSON(w, 415, "a preview is an image")
		return
	}
	var id, old string
	err := h.db.QueryRow("SELECT id, preview FROM task_outputs WHERE task_id = ? AND (id = ? OR (external_id != '' AND external_id = ?) OR (kind = 'file' AND name = ?))",
		t.ID, q.query("output"), q.query("external_id"), q.query("name")).Scan(&id, &old)
	if err != nil {
		errJSON(w, 404, "no such output")
		return
	}
	media := "out_" + randHex(12)
	h.storeMedia(media, typ, q.body)
	h.must(h.db.Exec("UPDATE task_outputs SET preview = ?, updated = ? WHERE id = ?", media, h.nowMs(), id))
	if old != "" {
		h.must(h.db.Exec("DELETE FROM media WHERE id = ?", old))
	}
	h.taskChanged(t.ID)
	writeJSON(w, 200, obj{"id": id})
}
