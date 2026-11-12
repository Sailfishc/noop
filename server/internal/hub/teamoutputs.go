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
	"sort"
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

type outputVersionMeta struct {
	Version int   `json:"version"`
	Size    int64 `json:"size"`
	At      int64 `json:"at"`
}

type outputView struct {
	ID         string              `json:"id"`
	TaskID     string              `json:"task_id,omitempty"`
	ThreadID   string              `json:"thread_id,omitempty"`
	MessageID  string              `json:"message_id,omitempty"`
	Kind       string              `json:"kind"`   // file | pr | external
	Title      string              `json:"title"`  // what people see
	Status     string              `json:"status"` // pending | ready | failed (a PR: open | merged | closed)
	URL        string              `json:"url,omitempty"`
	Name       string              `json:"name,omitempty"` // a file: its path under out/
	Mime       string              `json:"mime,omitempty"`
	Size       int64               `json:"size,omitempty"`
	Version    int                 `json:"version,omitempty"`     // a file: how many times it was uploaded
	Versions   []outputVersionMeta `json:"versions,omitempty"`    // file versions (1..Version) for WorkPanel switching
	Service    string              `json:"service,omitempty"`     // an external result: which service keeps it
	ExternalID string              `json:"external_id,omitempty"` // and its id there
	Note       string              `json:"note,omitempty"`        // progress or why it failed
	Preview    bool                `json:"preview,omitempty"`     // a preview image is kept here
	Updated    int64               `json:"updated"`
	media      string
	preview    string
	versions   []outputVersion
}

const outputCols = `o.id, o.task_id, COALESCE((SELECT thread_id FROM tasks_v1 WHERE tasks_v1.id = o.task_id), ''),
	COALESCE(o.message_id, ''), o.kind, o.title, o.status, o.url, o.name, o.mime, o.size, o.version,
	o.service, o.external_id, o.note, o.media, o.preview, o.versions, o.updated`

func scanOutputRows(rows interface {
	Next() bool
	Scan(...any) error
	Close() error
}) []outputView {
	defer rows.Close()
	out := []outputView{}
	for rows.Next() {
		var o outputView
		var versions string
		if err := rows.Scan(&o.ID, &o.TaskID, &o.ThreadID, &o.MessageID, &o.Kind, &o.Title, &o.Status, &o.URL, &o.Name,
			&o.Mime, &o.Size, &o.Version, &o.Service, &o.ExternalID, &o.Note, &o.media, &o.preview, &versions, &o.Updated); err != nil {
			panic(err)
		}
		_ = json.Unmarshal([]byte(versions), &o.versions)
		if len(o.versions) > 0 {
			o.Versions = make([]outputVersionMeta, len(o.versions))
			for i, v := range o.versions {
				o.Versions[i] = outputVersionMeta{Version: i + 1, Size: v.Size, At: v.At}
			}
		}
		o.Preview = o.preview != ""
		out = append(out, o)
	}
	return out
}

func (h *Hub) outputs(taskID string) []outputView {
	rows, err := h.db.Query("SELECT "+outputCols+" FROM task_outputs o WHERE o.task_id = ? ORDER BY o.created", taskID)
	if err != nil {
		panic(err)
	}
	return scanOutputRows(rows)
}

func (h *Hub) withMessageOutputs(ms []messageView) []messageView {
	if len(ms) == 0 {
		return ms
	}
	ph := make([]string, len(ms))
	args := make([]any, len(ms))
	for i, m := range ms {
		ph[i] = "?"
		args[i] = m.ID
	}
	rows, err := h.db.Query("SELECT "+outputCols+" FROM task_outputs o WHERE o.message_id IN ("+strings.Join(ph, ",")+") ORDER BY o.created", args...)
	if err != nil {
		panic(err)
	}
	byMsg := map[string][]outputView{}
	for _, o := range scanOutputRows(rows) {
		byMsg[o.MessageID] = append(byMsg[o.MessageID], o)
	}
	for i := range ms {
		if os := byMsg[ms[i].ID]; len(os) > 0 {
			ms[i].Outputs = os
		}
	}
	return ms
}

func (h *Hub) linkTaskOutputs(t taskView, msgID string) bool {
	if msgID == "" {
		return false
	}
	res, err := h.db.Exec("UPDATE task_outputs SET message_id = ?, channel_id = ? WHERE task_id = ? AND message_id IS NULL",
		msgID, t.ChannelID, t.ID)
	if err != nil {
		panic(err)
	}
	n, _ := res.RowsAffected()
	return n > 0
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
			os = append(os, outputView{ID: ts[i].ID + "-pr", TaskID: ts[i].ID, ThreadID: ts[i].ThreadID, Kind: "pr", Title: title, Status: pr.State, URL: pr.URL, Note: pr.Checks, Updated: ts[i].Updated})
		}
		ts[i].Outputs = append(os, h.outputs(ts[i].ID)...)
		ts[i].Events, ts[i].Calls = h.taskEvents(ts[i].ID)
		ts[i].Holder = h.holderOf(ts[i])
		ts[i].Delegates = h.delegatesOf(ts[i].ID)
		ts[i].Reminders = h.taskReminders(ts[i])
	}
	return ts
}

// v1ChannelOutputs: every output produced across messages and tasks in this channel (Spec §6: computed from messages/tasks,
// no separate storage). Private channels are visible only to their members (404 to outsiders).
func (h *Hub) v1ChannelOutputs(w http.ResponseWriter, q *request) {
	c, ok := h.channel(q.r.PathValue("id"))
	if !ok || !h.canRead(q.who, c.ID) {
		errJSON(w, 404, "not found")
		return
	}
	rows, err := h.db.Query("SELECT "+outputCols+` FROM task_outputs o
		WHERE o.channel_id = ? OR o.task_id IN (SELECT id FROM tasks_v1 WHERE channel_id = ?)
		ORDER BY o.updated DESC LIMIT 200`, c.ID, c.ID)
	if err != nil {
		panic(err)
	}
	outs := scanOutputRows(rows)
	prRows, err := h.db.Query("SELECT id, thread_id, COALESCE(pr, ''), updated FROM tasks_v1 WHERE channel_id = ? AND pr IS NOT NULL ORDER BY updated DESC LIMIT 100", c.ID)
	if err != nil {
		panic(err)
	}
	type prRow struct {
		id, thread, raw string
		updated         int64
	}
	prs := []prRow{}
	for prRows.Next() {
		var r prRow
		if err := prRows.Scan(&r.id, &r.thread, &r.raw, &r.updated); err != nil {
			prRows.Close()
			panic(err)
		}
		prs = append(prs, r)
	}
	prRows.Close()
	for _, r := range prs {
		if r.raw == "" {
			continue
		}
		var pr prView
		if json.Unmarshal([]byte(r.raw), &pr) != nil || pr.URL == "" {
			continue
		}
		title := pr.Title
		if title == "" {
			title = fmt.Sprintf("PR #%d", pr.Number)
		}
		outs = append(outs, outputView{ID: r.id + "-pr", TaskID: r.id, ThreadID: r.thread, Kind: "pr", Title: title, Status: pr.State, URL: pr.URL, Note: pr.Checks, Updated: r.updated})
	}
	sort.SliceStable(outs, func(i, j int) bool { return outs[i].Updated > outs[j].Updated })
	if len(outs) > 200 {
		outs = outs[:200]
	}
	writeJSON(w, 200, obj{"outputs": outs})
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
		h.must(h.db.Exec(`INSERT INTO task_outputs (id, task_id, channel_id, kind, title, status, name, mime, size, version, media, versions, created, updated)
			VALUES (?, ?, ?, 'file', ?, 'ready', ?, ?, ?, 1, ?, ?, ?, ?)`, id, t.ID, t.ChannelID, title, name, typ, len(q.body), media, string(vj), now, now))
	} else {
		h.must(h.db.Exec("UPDATE task_outputs SET channel_id = ?, message_id = NULL, mime = ?, size = ?, version = ?, media = ?, versions = ?, status = 'ready', updated = ? WHERE id = ?",
			t.ChannelID, typ, len(q.body), version+1, media, string(vj), now, id))
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

func (h *Hub) applyOutputs(t taskView, rs []outputReport) {
	taskID := t.ID
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
			h.must(h.db.Exec("UPDATE task_outputs SET channel_id = ?, message_id = NULL, title = ?, status = ?, url = COALESCE(NULLIF(?, ''), url), service = COALESCE(NULLIF(?, ''), service), note = ?, updated = ? WHERE id = ?",
				t.ChannelID, title, status, u, trimmed(r.Service, 60), trimmed(r.Note, 300), now, id))
			continue
		}
		if h.count("SELECT COUNT(*) FROM task_outputs WHERE task_id = ?", taskID) >= maxOutputsOfTask {
			return
		}
		h.must(h.db.Exec(`INSERT INTO task_outputs (id, task_id, channel_id, kind, title, status, url, service, external_id, note, created, updated)
			VALUES (?, ?, ?, 'external', ?, ?, ?, ?, ?, ?, ?, ?)`, newID("o_"), taskID, t.ChannelID, title, status, u, trimmed(r.Service, 60), ext, trimmed(r.Note, 300), now, now))
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
