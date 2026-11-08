package hub

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"time"
)

// The chat feed (events), the owner→fleet inbox, and the fleet's status/settings snapshot.

const (
	keepEvents = 5000
	hostStale  = 3 * time.Minute
)

// appendEvent stores an event and sends it to every owner socket. Fields in e win over the defaults (id, ts), as
// `{id, ts, ...e}` did. Call with h.mu held.
func (h *Hub) appendEvent(e obj) obj {
	ev := obj{"id": uuid4(), "ts": isoTime(h.now())}
	for k, v := range e {
		ev[k] = v
	}
	b, _ := json.Marshal(ev)
	ts, _ := ev["ts"].(string)
	var ref any
	if s, ok := ev["ref"].(string); ok {
		ref = s
	}
	h.must(h.db.Exec("INSERT INTO events (ts, json, ref) VALUES (?, ?, ?)", ts, string(b), ref))
	h.appends++
	if h.appends%50 == 0 {
		h.must(h.db.Exec("DELETE FROM events WHERE seq <= (SELECT MAX(seq) - ? FROM events)", keepEvents))
	}
	h.socks.send("owner", b)
	h.pruneMedia(false)
	return ev
}

// toInbox queues an item for the primary daemon and wakes it (a waiting long-poll, and a nudge on its socket).
func (h *Hub) toInbox(item obj) {
	b, _ := json.Marshal(item)
	h.must(h.db.Exec("INSERT INTO inbox (json) VALUES (?)", string(b)))
	for c := range h.inboxWaiters {
		close(c)
		delete(h.inboxWaiters, c)
	}
	h.socks.send("host", []byte(`{"type":"inbox"}`))
}

// ownerMessage: the owner said something. A retry with the same client_id returns the first event.
func (h *Hub) ownerMessage(text, ref string, attachments []string, thread bool, clientID string) obj {
	if clientID != "" {
		var prev string
		if err := h.db.QueryRow("SELECT json FROM events WHERE json_extract(json, '$.client_id') = ? LIMIT 1", clientID).Scan(&prev); err == nil {
			var ev obj
			_ = decodeBody([]byte(prev), &ev)
			return ev
		}
	}
	e := obj{"from": "owner", "kind": "owner", "text": text}
	if ref != "" {
		e["ref"] = ref
	}
	if clientID != "" {
		e["client_id"] = clientID
	}
	if len(attachments) > 0 {
		e["attachments"] = attachments
	}
	if thread {
		e["thread"] = true
	}
	ev := h.appendEvent(e)
	h.toInbox(obj{"type": "message", "event": ev})
	if !h.hostOnline() {
		h.appendEvent(obj{"from": "hub", "kind": "system", "text": "收到。团队的电脑暂时都不在线，上线后会马上处理。", "ref": ev["id"]})
	}
	return ev
}

func (h *Hub) hostOnline() bool {
	if h.socks.count("host") > 0 {
		return true
	}
	var seen int64
	return h.kvGet("host_seen", &seen) && h.nowMs()-seen < hostStale.Milliseconds()
}

func (h *Hub) touchHost() { h.kvSet("host_seen", h.nowMs()) }

func (h *Hub) statusView() obj {
	s := obj{}
	h.kvGet("status", &s)
	if s == nil {
		s = obj{}
	}
	var seen any
	var n int64
	if h.kvGet("host_seen", &n) {
		seen = n
	}
	s["hub"] = obj{"online": h.hostOnline(), "seen": seen}
	return s
}

// pushStatus sends the dashboard to owner clients that asked for status frames (?v=2).
func (h *Hub) pushStatus() {
	b, _ := json.Marshal(obj{"$status": h.statusView()})
	h.socks.send("v2", b)
}

// tellWatchers: the primary pushes live agent activity only while someone looks.
func (h *Hub) tellWatchers() {
	b, _ := json.Marshal(obj{"type": "watchers", "n": h.socks.count("owner")})
	h.socks.send("host", b)
}

func (h *Hub) usageView() obj {
	var pages, size int64
	_ = h.db.QueryRow("PRAGMA page_count").Scan(&pages)
	_ = h.db.QueryRow("PRAGMA page_size").Scan(&size)
	return obj{"day": h.now().UTC().Format("2006-01-02"), "level": "ok", "dbBytes": pages * size,
		"sockets": obj{"owner": h.socks.count("owner"), "host": h.socks.count("host")}}
}

// ---------------------------------------------------------------- routes

func (h *Hub) feed(w http.ResponseWriter, q *request) {
	rows, err := h.db.Query("SELECT json FROM (SELECT seq, json FROM events WHERE ts > ? ORDER BY ts DESC LIMIT 300) ORDER BY seq", q.query("since"))
	if err != nil {
		panic(err)
	}
	writeJSON(w, 200, obj{"events": scanEvents(rows)})
}

var clientIDRE = regexp.MustCompile(`^[\w:-]{1,100}$`)

func (h *Hub) postMessage(w http.ResponseWriter, q *request) {
	var b struct {
		Text        string          `json:"text"`
		ReplyTo     string          `json:"reply_to"`
		Attachments json.RawMessage `json:"attachments"`
		Thread      json.RawMessage `json:"thread"`
		ClientID    json.RawMessage `json:"client_id"`
	}
	if err := q.json(&b); err != nil {
		errJSON(w, 400, "bad json")
		return
	}
	clientID := ""
	if len(b.ClientID) > 0 && string(b.ClientID) != "null" {
		if json.Unmarshal(b.ClientID, &clientID) != nil || !clientIDRE.MatchString(clientID) {
			errJSON(w, 400, "bad client_id")
			return
		}
	}
	files, ok := ownerAttachments(b.Attachments)
	if !ok {
		errJSON(w, 400, "bad attachments")
		return
	}
	for _, f := range files {
		if h.count("SELECT COUNT(*) FROM media WHERE id = ?", f[7:]) == 0 {
			errJSON(w, 400, "attachment not found")
			return
		}
	}
	if isBlank(b.Text) && len(files) == 0 {
		errJSON(w, 400, "text required")
		return
	}
	thread := string(b.Thread) == "true" && taskRef.MatchString(b.ReplyTo)
	writeJSON(w, 200, h.ownerMessage(b.Text, b.ReplyTo, files, thread, clientID))
}

var taskRef = regexp.MustCompile(`^T-`)

func (h *Hub) putSettings(w http.ResponseWriter, q *request) {
	var patch any
	if err := q.json(&patch); err != nil {
		errJSON(w, 400, "bad json")
		return
	}
	h.toInbox(obj{"type": "settings", "patch": patch})
	view := obj{}
	h.kvGet("settings", &view)
	if view == nil {
		view = obj{}
	}
	cur, _ := view["current"].(map[string]any)
	if cur == nil {
		cur = obj{}
	}
	if pm, ok := patch.(map[string]any); ok {
		view["current"] = deepMerge(cur, pm)
		if _, has := pm["media_days"]; has {
			h.kvSet("settings", view)
			h.pruneMedia(true)
		}
	} else {
		view["current"] = cur
	}
	h.kvSet("settings", view)
	writeJSON(w, 200, view)
}

func deepMerge(a, b map[string]any) map[string]any {
	o := make(map[string]any, len(a)+len(b))
	for k, v := range a {
		o[k] = v
	}
	for k, v := range b {
		if bm, ok := v.(map[string]any); ok {
			am, _ := o[k].(map[string]any)
			if am == nil {
				am = map[string]any{}
			}
			o[k] = deepMerge(am, bm)
		} else {
			o[k] = v
		}
	}
	return o
}

func (h *Hub) hostState(w http.ResponseWriter, q *request) {
	if !q.who.machine {
		errJSON(w, 403, "forbidden")
		return
	}
	var b struct {
		Status   json.RawMessage `json:"status"`
		Settings json.RawMessage `json:"settings"`
	}
	if err := q.json(&b); err != nil {
		errJSON(w, 400, "bad json")
		return
	}
	if present(b.Status) {
		h.must(h.db.Exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('status', ?)", string(b.Status)))
	}
	if present(b.Settings) {
		h.must(h.db.Exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('settings', ?)", string(b.Settings)))
	}
	h.touchHost()
	if present(b.Status) {
		h.pushStatus()
	}
	writeJSON(w, 200, obj{"ok": true, "watchers": h.socks.count("owner"), "level": "ok"})
}

// present: a JSON value that is there and truthy enough to store (not null, false, 0 or "").
func present(m json.RawMessage) bool {
	s := string(m)
	return len(m) > 0 && s != "null" && s != "false" && s != "0" && s != `""`
}

// hostInbox: GET /api/host/inbox?after=<seq>[&wait=<s>] — acks everything ≤ after, returns up to 50 items, and with
// wait (≤ 25 s) holds the request until something arrives.
func (h *Hub) hostInbox(w http.ResponseWriter, q *request) {
	if !q.who.machine {
		errJSON(w, 403, "forbidden")
		return
	}
	after, _ := strconv.ParseInt(q.query("after"), 10, 64)
	wait, _ := strconv.ParseFloat(q.query("wait"), 64)
	if wait < 0 {
		wait = 0
	}
	if wait > 25 {
		wait = 25
	}
	var items []obj
	var ch chan struct{}
	h.locked(func() {
		if after > h.acked {
			h.must(h.db.Exec("DELETE FROM inbox WHERE seq <= ?", after))
			h.acked = after
		}
		h.touchHost()
		items = h.readInbox()
		if len(items) == 0 && wait > 0 {
			ch = make(chan struct{})
			h.inboxWaiters[ch] = struct{}{}
		}
	})
	if ch != nil {
		t := time.NewTimer(time.Duration(wait * float64(time.Second)))
		select {
		case <-ch:
		case <-t.C:
		case <-q.r.Context().Done():
		}
		t.Stop()
		h.locked(func() {
			delete(h.inboxWaiters, ch)
			h.touchHost()
			items = h.readInbox()
		})
	}
	writeJSON(w, 200, obj{"items": items})
}

func (h *Hub) readInbox() []obj {
	rows, err := h.db.Query("SELECT seq, json FROM inbox ORDER BY seq LIMIT 50")
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	items := []obj{}
	for rows.Next() {
		var seq int64
		var s string
		if err := rows.Scan(&seq, &s); err != nil {
			panic(err)
		}
		it := obj{}
		_ = decodeBody([]byte(s), &it)
		it["seq"] = seq
		items = append(items, it)
	}
	return items
}

func scanEvents(rows interface {
	Next() bool
	Scan(...any) error
	Close() error
}) []obj {
	defer rows.Close()
	out := []obj{}
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			panic(err)
		}
		var ev obj
		if decodeBody([]byte(s), &ev) == nil {
			out = append(out, ev)
		}
	}
	return out
}

func isBlank(s string) bool {
	for _, r := range s {
		if r != ' ' && r != '\t' && r != '\n' && r != '\r' && r != '　' && r != ' ' {
			return false
		}
	}
	return true
}
