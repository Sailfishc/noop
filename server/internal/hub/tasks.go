package hub

import (
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
)

// Read-only views of tasks and channels over the files mirror (cloud/src/tools.ts). Writes go to the primary
// daemon through the inbox; the daemon owns the data.

type fileText struct {
	path, text, updated string
}

type store struct{ h *Hub }

func (h *Hub) store() store { return store{h} }

func (s store) read(path string) *fileText {
	var content []byte
	var updated *string
	if err := s.h.db.QueryRow("SELECT content, updated FROM files WHERE path = ? AND deleted = 0", path).Scan(&content, &updated); err != nil {
		return nil
	}
	return &fileText{path: path, text: string(content), updated: deref(updated)}
}

// list: files under dir ("tasks/active/"), newest path first.
func (s store) list(dir string) []fileText {
	rows, err := s.h.db.Query("SELECT path, content, updated FROM files WHERE path >= ? AND path < ? AND deleted = 0 ORDER BY path DESC LIMIT 2000", dir, prefixEnd(dir))
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	var out []fileText
	for rows.Next() {
		var f fileText
		var content []byte
		var updated *string
		if err := rows.Scan(&f.path, &content, &updated); err != nil {
			panic(err)
		}
		f.text, f.updated = string(content), deref(updated)
		out = append(out, f)
	}
	return out
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

var docRE = regexp.MustCompile(`(?s)^---\n(.*?)\n---\n?(.*)$`)

// parseDoc: "---\nk: v\n---\nbody" → meta, body.
func parseDoc(text string) (map[string]string, string) {
	m := docRE.FindStringSubmatch(text)
	meta := map[string]string{}
	if m == nil {
		return meta, text
	}
	for _, line := range strings.Split(m[1], "\n") {
		if i := strings.Index(line, ":"); i > 0 {
			meta[strings.TrimSpace(line[:i])] = strings.TrimSpace(line[i+1:])
		}
	}
	return meta, m[2]
}

var (
	taskStates    = []string{"inbox", "active", "waiting", "blocked", "failed", "done"}
	historyStates = append(append([]string{}, taskStates...), "rejected")
	taskFileRE    = regexp.MustCompile(`^tasks/[^/]+/T-[^/]*\.md$`)
	cancelledRE   = regexp.MustCompile(`(?m)^cancelled:`)
	taskCancelID  = regexp.MustCompile(`^T-\w*\d{4}$`)
	channelSlugRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,47}$`)
)

func fileID(meta map[string]string, path string) string {
	if meta["id"] != "" {
		return meta["id"]
	}
	return strings.TrimSuffix(path[strings.LastIndex(path, "/")+1:], ".md")
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if x != "" {
			return x
		}
	}
	return ""
}

// omit drops empty optional fields, as undefined values vanish from JSON in the Worker.
func omit(o obj) obj {
	for k, v := range o {
		if s, ok := v.(string); ok && s == "" && k != "title" && k != "state" && k != "id" {
			delete(o, k)
		}
	}
	return o
}

func historyRow(f fileText, folder string) obj {
	m, _ := parseDoc(f.text)
	state := folder
	switch {
	case folder == "waiting" && m["wake_at"] != "":
		state = "parked"
	case folder == "inbox" && m["parked"] != "" && m["requires"] != "":
		state = "nohost"
	case folder == "rejected":
		state = "cancelled"
	}
	needs := ""
	if state == "nohost" {
		needs = m["requires"]
	}
	return omit(obj{
		"id": fileID(m, f.path), "title": m["title"], "agent": m["agent"], "host": m["claimed_by"], "state": state, "needs": needs,
		"started": m["started"], "created": m["created"], "finished": firstNonEmpty(m["finished"], m["cancelled"]),
		"updated": firstNonEmpty(m["finished"], m["cancelled"], m["started"], m["created"], f.updated),
		"attempt": m["attempt"], "cli": m["cli_used"], "model": m["model"],
	})
}

func str(o obj, k string) string { s, _ := o[k].(string); return s }

// taskHistory: every task, newest first, a page at a time.
func taskHistory(s store, query string, offset, limit int) obj {
	q := strings.ToLower(strings.TrimSpace(query))
	seen := map[string]bool{}
	all := []obj{}
	for _, st := range historyStates {
		for _, f := range s.list("tasks/" + st + "/") {
			if !taskFileRE.MatchString(f.path) || (st == "rejected" && !cancelledRE.MatchString(f.text)) {
				continue
			}
			t := historyRow(f, st)
			id := str(t, "id")
			if seen[id] {
				continue // a task copied in two folders mid-sync shows once
			}
			seen[id] = true
			if q != "" && !strings.Contains(strings.ToLower(id+" "+str(t, "title")+" "+str(t, "agent")), q) {
				continue
			}
			all = append(all, t)
		}
	}
	sort.SliceStable(all, func(i, j int) bool { return str(all[i], "updated") > str(all[j], "updated") })
	offset = max(0, offset)
	if limit == 0 {
		limit = 50
	}
	limit = max(1, min(limit, 200))
	end := min(len(all), offset+limit)
	page := []obj{}
	if offset < len(all) {
		page = all[offset:end]
	}
	return obj{"tasks": page, "total": len(all)}
}

var (
	noteRE  = regexp.MustCompile(`(?i)^>?\s*(Requeued|Retried|Resumed|Attempt \d+ failed)\b`)
	paraRE  = regexp.MustCompile(`\n\n+`)
	quoteRE = regexp.MustCompile(`(^|\n)> [\s\S]*?(\n\n[^>]|$)`)
	runRE   = regexp.MustCompile(`## Run (\S+) · (\S+) · (\S+)\n\*\*(\w+)\*\* — ([^\n]*)`)
	qmarkRE = regexp.MustCompile(`(?m)^> ?`)
)

// parseTaskBody: the owner's request (a quote, or the task's first paragraph) and the last runs.
func parseTaskBody(title, body string) obj {
	var own []string
	for _, p := range paraRE.Split(strings.SplitN(body, "\n## ", 2)[0], -1) {
		if !noteRE.MatchString(strings.TrimSpace(p)) {
			own = append(own, p)
		}
	}
	joined := strings.Join(own, "\n\n")
	request := joined
	if loc := quoteRE.FindStringSubmatchIndex(joined); loc != nil {
		request = joined[loc[0]:loc[4]] // the original's lookahead: stop before "\n\n<non-quote>" or the end
	} else if request == "" {
		request = title
	}
	request = strings.TrimSpace(qmarkRE.ReplaceAllString(request, ""))
	request = truncRunes(request, 1200)
	runs := []obj{}
	for _, r := range runRE.FindAllStringSubmatch(body, -1) {
		runs = append(runs, obj{"ts": r[1], "host": r[2], "cli": r[3], "status": r[4], "summary": r[5]})
	}
	if len(runs) > 5 {
		runs = runs[len(runs)-5:]
	}
	return obj{"request": request, "runs": runs}
}

// taskInfo: one task for the app's task page, wherever it is, with the cards it asked.
func taskInfo(s store, id string) obj {
	for _, st := range historyStates {
		f := s.read("tasks/" + st + "/" + id + ".md")
		if f == nil {
			continue
		}
		decisions := []string{}
		for _, w := range []string{"open", "closed"} {
			for _, d := range s.list("decisions/" + w + "/") {
				m, _ := parseDoc(d.text)
				if m["task"] == id && m["id"] != "" {
					decisions = append(decisions, m["id"])
				}
			}
		}
		t := historyRow(*f, st)
		meta, body := parseDoc(f.text)
		for k, v := range parseTaskBody(meta["title"], body) {
			t[k] = v
		}
		t["decisions"] = decisions
		return t
	}
	return nil
}

func (h *Hub) taskGet(w http.ResponseWriter, q *request) {
	t := taskInfo(h.store(), q.query("id"))
	if t == nil {
		errJSON(w, 404, "not found")
		return
	}
	refs := append([]any{t["id"]}, toAny(t["decisions"].([]string))...)
	rows, err := h.db.Query("SELECT json FROM events WHERE ref IN ("+strings.TrimSuffix(strings.Repeat("?,", len(refs)), ",")+") ORDER BY seq", refs...)
	if err != nil {
		panic(err)
	}
	t["events"] = scanEvents(rows)
	writeJSON(w, 200, t)
}

func toAny(xs []string) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = x
	}
	return out
}

// ---------------------------------------------------------------- channels

type channelRow struct {
	slug, name, goal, status, created string
}

const staleDays = 7

var (
	reportRE      = regexp.MustCompile(`\breports/[\w./-]+\.md\b`)
	channelFileRE = regexp.MustCompile(`^channels/[^/]+\.md$`)
)

func listChannelRows(s store) []channelRow {
	var out []channelRow
	for _, f := range s.list("channels/") {
		if !channelFileRE.MatchString(f.path) {
			continue
		}
		slug := strings.TrimSuffix(f.path[strings.LastIndex(f.path, "/")+1:], ".md")
		if !channelSlugRE.MatchString(slug) {
			continue
		}
		meta, body := parseDoc(f.text)
		goal := body
		if g, ok := meta["goal"]; ok {
			goal = g
		}
		status := "active"
		if meta["status"] == "archived" {
			status = "archived"
		}
		out = append(out, channelRow{slug: slug, name: firstNonEmpty(meta["name"], slug), goal: strings.TrimSpace(goal), status: status, created: meta["created"]})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

func taskChannels(meta map[string]string) []string {
	var out []string
	for _, c := range strings.Split(meta["channels"], ",") {
		if c = strings.TrimSpace(c); c != "" {
			out = append(out, c)
		}
	}
	return out
}

// channelsView: every channel with its items (tasks + the cards they asked + reports), newest first.
func channelsView(s store, now time.Time, limit int) obj {
	chans := listChannelRows(s)
	items := map[string][]obj{}
	for _, c := range chans {
		items[c.slug] = []obj{}
	}
	taskOf := map[string][]string{}
	seen := map[string]bool{}
	reportExists := map[string]bool{}
	for _, st := range historyStates {
		for _, f := range s.list("tasks/" + st + "/") {
			if !taskFileRE.MatchString(f.path) {
				continue
			}
			meta, body := parseDoc(f.text)
			var cs []string
			for _, c := range taskChannels(meta) {
				if _, ok := items[c]; ok {
					cs = append(cs, c)
				}
			}
			id := fileID(meta, f.path)
			if len(cs) == 0 || seen[id] {
				continue
			}
			seen[id] = true
			taskOf[id] = cs
			row := historyRow(f, st)
			for _, c := range cs {
				items[c] = append(items[c], obj{"id": id, "kind": "task", "title": str(row, "title"), "state": st, "updated": str(row, "updated")})
				done := map[string]bool{}
				for _, path := range reportRE.FindAllString(body, -1) {
					if done[path] || strings.Contains("/"+path+"/", "/../") {
						continue
					}
					done[path] = true
					if _, ok := reportExists[path]; !ok {
						reportExists[path] = s.read(path) != nil
					}
					if !reportExists[path] || hasItem(items[c], path) {
						continue
					}
					title := strings.TrimSuffix(path[strings.LastIndex(path, "/")+1:], ".md")
					items[c] = append(items[c], obj{"id": path, "kind": "report", "title": title, "state": "done", "updated": str(row, "updated"), "task": id})
				}
			}
		}
	}
	for _, w := range []string{"open", "closed"} {
		for _, d := range s.list("decisions/" + w + "/") {
			meta, _ := parseDoc(d.text)
			cs := taskOf[meta["task"]]
			if meta["task"] == "" || cs == nil || meta["id"] == "" {
				continue
			}
			for _, c := range cs {
				items[c] = append(items[c], obj{"id": meta["id"], "kind": "decision", "title": firstNonEmpty(meta["question"], meta["id"]), "state": w,
					"updated": firstNonEmpty(meta["answered"], meta["created"], d.updated), "task": meta["task"]})
			}
		}
	}
	out := []obj{}
	for _, c := range chans {
		list := items[c.slug]
		sort.SliceStable(list, func(i, j int) bool { return str(list[i], "updated") > str(list[j], "updated") })
		last := c.created
		if len(list) > 0 {
			last = str(list[0], "updated")
		}
		stale := true
		if t, err := time.Parse(time.RFC3339, last); err == nil {
			stale = now.Sub(t) > staleDays*24*time.Hour
		}
		refs := []string{}
		for _, i := range list {
			if i["kind"] != "report" {
				refs = append(refs, str(i, "id"))
			}
		}
		shown := list
		if len(shown) > limit {
			shown = shown[:limit]
		}
		out = append(out, obj{"slug": c.slug, "name": c.name, "goal": c.goal, "status": c.status, "created": c.created,
			"last_activity": last, "stale": stale, "count": len(list), "refs": refs, "items": shown})
	}
	return obj{"channels": out}
}

func hasItem(list []obj, id string) bool {
	for _, i := range list {
		if i["id"] == id {
			return true
		}
	}
	return false
}

// channelDigest: the main-chat messages about a channel's tasks and cards, newest last.
func channelDigest(events []obj, refs []string, limit int) []obj {
	want := map[string]bool{}
	for _, r := range refs {
		want[r] = true
	}
	out := []obj{}
	for _, e := range events {
		ref := str(e, "ref")
		if ref == "" || !want[ref] || e["thread"] == true || strings.HasPrefix(str(e, "from"), "hub") || str(e, "kind") == "system" {
			continue
		}
		out = append(out, e)
	}
	if len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out
}

func (h *Hub) channelFeed(w http.ResponseWriter, q *request) {
	slug := q.query("slug")
	var ch obj
	for _, c := range channelsView(h.store(), h.now(), 100)["channels"].([]obj) {
		if c["slug"] == slug {
			ch = c
		}
	}
	if ch == nil {
		errJSON(w, 404, "not found")
		return
	}
	rows, err := h.db.Query("SELECT json FROM events WHERE ref IS NOT NULL ORDER BY seq DESC LIMIT 5000")
	if err != nil {
		panic(err)
	}
	evs := scanEvents(rows)
	for i, j := 0, len(evs)-1; i < j; i, j = i+1, j-1 {
		evs[i], evs[j] = evs[j], evs[i]
	}
	writeJSON(w, 200, obj{"events": channelDigest(evs, ch["refs"].([]string), 80)})
}

func (h *Hub) postChannel(w http.ResponseWriter, q *request) {
	if q.who.machine {
		errJSON(w, 403, "forbidden")
		return
	}
	var b struct {
		Slug     string `json:"slug"`
		Goal     any    `json:"goal"`
		Archived any    `json:"archived"`
	}
	_ = q.json(&b)
	if !channelSlugRE.MatchString(b.Slug) {
		errJSON(w, 400, "slug required")
		return
	}
	item := obj{"type": "channel", "slug": b.Slug}
	if g, ok := b.Goal.(string); ok {
		item["goal"] = truncRunes(g, 500)
	}
	if a, ok := b.Archived.(bool); ok {
		item["archived"] = a
	}
	h.toInbox(item)
	writeJSON(w, 200, obj{"ok": true})
}

// push: Web Push is not ported; answering a card from a notification still works.
func (h *Hub) push(w http.ResponseWriter, q *request) {
	p := q.r.URL.Path
	if p == "/api/push/answer" && q.r.Method == "POST" {
		var b struct {
			Ref    string `json:"ref"`
			Answer string `json:"answer"`
		}
		_ = q.json(&b)
		ref, ans := strings.TrimFunc(b.Ref, unicode.IsSpace), strings.TrimFunc(b.Answer, unicode.IsSpace)
		if ref == "" || ans == "" {
			errJSON(w, 400, "ref and answer required")
			return
		}
		writeJSON(w, 200, h.ownerMessage(ref+" "+ans, ref, nil, false, ""))
		return
	}
	errJSON(w, 503, "push not configured")
}
