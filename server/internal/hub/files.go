package hub

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Shared fleet files (cloud/src/files.ts): each host keeps a local mirror of the data folder and syncs it here.
//
//	GET  /api/files/changes?since=<rev>[&limit=]  → {rev, more, files:[{path, version, hash, deleted, content(base64)|null, rev}]}
//	POST /api/files/commit {msg, changes:[{path, base_version, content(base64)} | {path, base_version, deleted:true}]}
//	     → 200 {rev, files} | 409 {conflicts:[path]} (nothing applied) | 400/413 {error}
//	     Compare-and-swap per path: the distributed lock that task claims rely on (exactly one host wins a move).
//	GET  /api/files/history?path=&limit=[&content=1]   (owner)
//	POST /api/files/revert {path, version, msg?}        (owner)
//	GET  /api/files/list?prefix= · GET /api/files/read?path=   (READABLE prefixes only)

const (
	maxFile        = 1_500_000
	pageBytes      = 8_000_000
	pageRows       = 1000
	historyDays    = 90
	historyRows    = 20_000
	historyPerPath = 30
	listRows       = 2000
	storageTarget  = 500_000_000
	latestOnlySQL  = `(path LIKE 'journal/%' OR path LIKE 'logs/%' OR path LIKE 'fleet/%' OR path IN ('memory/lessons.md', 'memory/judge-feedback.md'))`
)

// latestOnly: paths rewritten constantly whose old versions are worth nothing (logs, heartbeats).
func latestOnly(p string) bool {
	return strings.HasPrefix(p, "journal/") || strings.HasPrefix(p, "logs/") || strings.HasPrefix(p, "fleet/") ||
		p == "memory/lessons.md" || p == "memory/judge-feedback.md"
}

// validPath: relative, normalized, no traversal, no git internals.
func validPath(p string) bool {
	if p == "" || len([]rune(p)) > 512 || strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\\\x00") {
		return false
	}
	for _, s := range strings.Split(p, "/") {
		if s == "" || s == "." || s == ".." || s == ".git" {
			return false
		}
	}
	return true
}

var readablePrefixes = []string{"policies/", "memory/", "agents/", "decisions/closed/", "reports/"}

func readable(p string) bool {
	base := strings.TrimSuffix(p, "/")
	if base == "" {
		base = "x"
	}
	if !validPath(base) {
		return false
	}
	for _, r := range readablePrefixes {
		if strings.HasPrefix(p, r) {
			return true
		}
	}
	return false
}

// prefixEnd: exclusive upper bound for a prefix range scan ("a/" → "a0").
func prefixEnd(p string) string { return p[:len(p)-1] + string(rune(p[len(p)-1]+1)) }

func (h *Hub) curRev() int64 {
	var v int64
	_ = h.db.QueryRow("SELECT v FROM files_meta WHERE k = 'rev'").Scan(&v)
	return v
}

type fileRow struct {
	version int64
	deleted bool
}

func (h *Hub) fileRow(path string) *fileRow {
	var r fileRow
	if err := h.db.QueryRow("SELECT version, deleted FROM files WHERE path = ?", path).Scan(&r.version, &r.deleted); err != nil {
		return nil
	}
	return &r
}

// liveVersion: what a writer must name as base (0 when absent or deleted).
func liveVersion(r *fileRow) int64 {
	if r == nil || r.deleted {
		return 0
	}
	return r.version
}

type prepared struct {
	path    string
	base    int64
	content []byte // nil: delete
	hash    string
}

type fileOut struct {
	Path    string  `json:"path"`
	Version int64   `json:"version"`
	Hash    *string `json:"hash"`
	Deleted bool    `json:"deleted"`
}

// applyCAS checks every base version, then applies all or nothing. Call with h.mu held.
func (h *Hub) applyCAS(items []prepared, actor, msg string) (int, any) {
	var conflicts []string
	for _, it := range items {
		if liveVersion(h.fileRow(it.path)) != it.base {
			conflicts = append(conflicts, it.path)
		}
	}
	if len(conflicts) > 0 {
		return 409, obj{"conflicts": conflicts}
	}
	tx, err := h.db.Begin()
	if err != nil {
		panic(err)
	}
	defer tx.Rollback()
	rev := h.curRevTx(tx)
	ts := isoTime(h.now())
	out := []fileOut{}
	for _, it := range items {
		var version int64
		var deleted bool
		hasRow := tx.QueryRow("SELECT version, deleted FROM files WHERE path = ?", it.path).Scan(&version, &deleted) == nil
		live := version
		if !hasRow || deleted {
			live = 0
		}
		if it.content == nil && live == 0 { // delete of nothing
			out = append(out, fileOut{Path: it.path, Version: version, Deleted: true})
			continue
		}
		version++
		rev++
		var hash any
		if it.content != nil {
			hash = it.hash
		}
		var content any
		if it.content != nil {
			content = it.content
		}
		del := 0
		if it.content == nil {
			del = 1
		}
		if _, err := tx.Exec(`INSERT INTO files (path, content, hash, version, updated, by, deleted, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(path) DO UPDATE SET content = excluded.content, hash = excluded.hash, version = excluded.version,
			  updated = excluded.updated, by = excluded.by, deleted = excluded.deleted, rev = excluded.rev`,
			it.path, content, hash, version, ts, actor, del, rev); err != nil {
			panic(err)
		}
		if !latestOnly(it.path) {
			if _, err := tx.Exec("INSERT INTO history (path, version, hash, content, ts, by, msg) VALUES (?, ?, ?, ?, ?, ?, ?)",
				it.path, version, hash, content, ts, actor, msg); err != nil {
				panic(err)
			}
		}
		o := fileOut{Path: it.path, Version: version, Deleted: it.content == nil}
		if it.content != nil {
			s := it.hash
			o.Hash = &s
		}
		out = append(out, o)
	}
	if _, err := tx.Exec("INSERT OR REPLACE INTO files_meta (k, v) VALUES ('rev', ?)", rev); err != nil {
		panic(err)
	}
	if err := tx.Commit(); err != nil {
		panic(err)
	}
	h.pruneHistory(false)
	return 200, obj{"rev": rev, "files": out}
}

func (h *Hub) curRevTx(tx *sql.Tx) int64 {
	var v int64
	_ = tx.QueryRow("SELECT v FROM files_meta WHERE k = 'rev'").Scan(&v)
	return v
}

// pruneHistory, once a day: ≤ 90 days and ≤ 20k rows (always keeping each path's latest), no history for latestOnly
// paths, ≤ 30 versions per path (1 once the database is past its storage target).
func (h *Hub) pruneHistory(force bool) {
	now := h.nowMs()
	var last int64
	_ = h.db.QueryRow("SELECT v FROM files_meta WHERE k = 'pruned'").Scan(&last)
	if !force && now-last < 86_400_000 {
		return
	}
	h.must(h.db.Exec("INSERT OR REPLACE INTO files_meta (k, v) VALUES ('pruned', ?)", now))
	cutoff := isoTime(h.now().Add(-historyDays * 24 * time.Hour))
	h.must(h.db.Exec(`DELETE FROM history WHERE (ts < ? OR seq <= (SELECT MAX(seq) FROM history) - ?)
		AND seq NOT IN (SELECT MAX(seq) FROM history GROUP BY path)`, cutoff, historyRows))
	h.must(h.db.Exec("DELETE FROM history WHERE " + latestOnlySQL))
	keep := historyPerPath
	if h.usageView()["dbBytes"].(int64) > storageTarget {
		keep = 1
	}
	h.must(h.db.Exec(`DELETE FROM history WHERE seq IN (SELECT seq FROM (SELECT seq,
		ROW_NUMBER() OVER (PARTITION BY path ORDER BY seq DESC) AS rn FROM history) WHERE rn > ?)`, keep))
}

func clampInt(s string, def, lo, hi int) int {
	n, err := strconv.Atoi(s)
	if err != nil || n == 0 {
		n = def
	}
	return max(lo, min(hi, n))
}

func (h *Hub) files(w http.ResponseWriter, q *request, actor string) {
	p, m := q.r.URL.Path, q.r.Method
	switch {
	case p == "/api/files/changes" && m == "GET":
		since, _ := strconv.ParseInt(q.query("since"), 10, 64)
		since = max(0, since)
		limit := clampInt(q.query("limit"), pageRows, 1, pageRows)
		head := h.curRev()
		type change struct {
			Path    string  `json:"path"`
			Version int64   `json:"version"`
			Hash    *string `json:"hash"`
			Deleted bool    `json:"deleted"`
			Content *string `json:"content"`
			Rev     int64   `json:"rev"`
		}
		files := []change{}
		size, last, more := 0, since, false
		for { // one row at a time so a page never loads more than its byte budget
			var c change
			var content []byte
			err := h.db.QueryRow("SELECT path, content, hash, version, deleted, rev FROM files WHERE rev > ? ORDER BY rev LIMIT 1", last).
				Scan(&c.Path, &content, &c.Hash, &c.Version, &c.Deleted, &c.Rev)
			if err != nil {
				break
			}
			n := 0
			if !c.Deleted {
				n = len(content)
			}
			if len(files) > 0 && (len(files) >= limit || size+n > pageBytes) {
				more = true
				break
			}
			if !c.Deleted {
				s := base64.StdEncoding.EncodeToString(content)
				c.Content = &s
			}
			files = append(files, c)
			size += n
			last = c.Rev
		}
		rev := last
		if !more {
			rev = max(last, head)
		}
		writeJSON(w, 200, obj{"rev": rev, "more": more, "files": files})

	case p == "/api/files/commit" && m == "POST":
		var b struct {
			Msg     any `json:"msg"`
			Changes []struct {
				Path        any  `json:"path"`
				BaseVersion any  `json:"base_version"`
				Content     any  `json:"content"`
				Deleted     bool `json:"deleted"`
			} `json:"changes"`
		}
		if err := q.json(&b); err != nil || len(b.Changes) == 0 {
			errJSON(w, 400, "changes[] required")
			return
		}
		seen := map[string]bool{}
		items := make([]prepared, 0, len(b.Changes))
		for _, c := range b.Changes {
			path, _ := c.Path.(string)
			if !validPath(path) {
				errJSON(w, 400, "invalid path: "+truncRunes(fmt.Sprint(c.Path), 200))
				return
			}
			if seen[path] {
				errJSON(w, 400, "duplicate path: "+path)
				return
			}
			seen[path] = true
			base, ok := wholeNumber(c.BaseVersion)
			if !ok || base < 0 {
				errJSON(w, 400, "bad base_version for "+path)
				return
			}
			if c.Deleted {
				items = append(items, prepared{path: path, base: base})
				continue
			}
			s, ok := c.Content.(string)
			if !ok {
				errJSON(w, 400, "content (base64) or deleted:true required for "+path)
				return
			}
			content, err := base64.StdEncoding.DecodeString(s)
			if err != nil {
				errJSON(w, 400, "content is not base64: "+path)
				return
			}
			if len(content) > maxFile {
				errJSON(w, 413, fmt.Sprintf("file too large: %s is %d bytes (max %d); keep large artifacts outside the data folder", path, len(content), maxFile))
				return
			}
			if content == nil {
				content = []byte{}
			}
			items = append(items, prepared{path: path, base: base, content: content, hash: sha256hex(content)})
		}
		msg := ""
		if b.Msg != nil {
			msg = truncRunes(fmt.Sprint(b.Msg), 500)
		}
		st, out := h.applyCAS(items, actor, msg)
		writeJSON(w, st, out)

	case p == "/api/files/history" && m == "GET":
		path := q.query("path")
		if !validPath(path) {
			errJSON(w, 400, "path required")
			return
		}
		limit := clampInt(q.query("limit"), 50, 1, 500)
		withContent := q.query("content") == "1"
		var rows *sql.Rows
		var err error
		if latestOnly(path) {
			rows, err = h.db.Query("SELECT 0, version, hash, CASE WHEN deleted THEN NULL ELSE content END, updated, by, '' FROM files WHERE path = ?", path)
		} else {
			rows, err = h.db.Query("SELECT seq, version, hash, content, ts, by, msg FROM history WHERE path = ? ORDER BY seq DESC LIMIT ?", path, limit)
		}
		if err != nil {
			panic(err)
		}
		defer rows.Close()
		hist := []obj{}
		for rows.Next() {
			var seq, version int64
			var hash, ts, by, msg *string
			var content []byte
			var raw any
			if err := rows.Scan(&seq, &version, &hash, &raw, &ts, &by, &msg); err != nil {
				panic(err)
			}
			deleted := raw == nil
			switch v := raw.(type) {
			case []byte:
				content = v
			case string:
				content = []byte(v)
			}
			o := obj{"seq": seq, "version": version, "hash": hash, "ts": ts, "by": by, "msg": msg, "deleted": deleted, "size": len(content)}
			if withContent {
				if deleted {
					o["content"] = nil
				} else {
					o["content"] = base64.StdEncoding.EncodeToString(content)
				}
			}
			hist = append(hist, o)
		}
		writeJSON(w, 200, obj{"history": hist})

	case p == "/api/files/revert" && m == "POST":
		var b struct {
			Path    string `json:"path"`
			Version any    `json:"version"`
			Msg     any    `json:"msg"`
		}
		_ = q.json(&b)
		version, ok := wholeNumber(b.Version)
		if !validPath(b.Path) || !ok {
			errJSON(w, 400, "{path, version} required")
			return
		}
		var raw any
		var hash *string
		if err := h.db.QueryRow("SELECT content, hash FROM history WHERE path = ? AND version = ? ORDER BY seq DESC LIMIT 1", b.Path, version).Scan(&raw, &hash); err != nil {
			errJSON(w, 404, fmt.Sprintf("no history for %s v%d (pruned or never existed)", b.Path, version))
			return
		}
		it := prepared{path: b.Path, base: liveVersion(h.fileRow(b.Path))}
		switch v := raw.(type) {
		case []byte:
			it.content = v
		case string:
			it.content = []byte(v)
		}
		if it.content != nil && hash != nil {
			it.hash = *hash
		}
		msg := fmt.Sprintf("revert %s to v%d", b.Path, version)
		if b.Msg != nil {
			msg = fmt.Sprint(b.Msg)
		}
		st, out := h.applyCAS([]prepared{it}, actor, truncRunes(msg, 500))
		if st != 200 {
			writeJSON(w, st, out)
			return
		}
		res := out.(obj)
		writeJSON(w, 200, obj{"rev": res["rev"], "version": res["files"].([]fileOut)[0].Version})

	default:
		errJSON(w, 404, "not found")
	}
}

// wholeNumber: a JSON integer (json.Number or a numeric string, as JavaScript's Number() would take it).
func wholeNumber(v any) (int64, bool) {
	switch x := v.(type) {
	case json.Number:
		n, err := x.Int64()
		if err != nil {
			f, ferr := x.Float64()
			if ferr != nil || f != float64(int64(f)) {
				return 0, false
			}
			return int64(f), true
		}
		return n, true
	case string:
		n, err := strconv.ParseInt(strings.TrimSpace(x), 10, 64)
		return n, err == nil
	}
	return 0, false
}

// readFiles: owner (and machine) read of the READABLE prefixes.
func (h *Hub) readFiles(w http.ResponseWriter, q *request) {
	switch q.r.URL.Path {
	case "/api/files/list":
		prefix := q.query("prefix")
		if prefix != "" && !strings.HasSuffix(prefix, "/") {
			prefix += "/"
		}
		if !readable(prefix) {
			errJSON(w, 403, "prefix not readable")
			return
		}
		rows, err := h.db.Query(`SELECT path, LENGTH(content), updated, version FROM files
			WHERE path >= ? AND path < ? AND deleted = 0 ORDER BY path LIMIT ?`, prefix, prefixEnd(prefix), listRows)
		if err != nil {
			panic(err)
		}
		defer rows.Close()
		out := []obj{}
		for rows.Next() {
			var path string
			var size *int64
			var updated *string
			var version int64
			if err := rows.Scan(&path, &size, &updated, &version); err != nil {
				panic(err)
			}
			n := int64(0)
			if size != nil {
				n = *size
			}
			out = append(out, obj{"path": path, "size": n, "updated": updated, "version": version})
		}
		writeJSON(w, 200, obj{"files": out})
	case "/api/files/read":
		path := q.query("path")
		if !validPath(path) || !readable(path) {
			errJSON(w, 403, "path not readable")
			return
		}
		var content []byte
		var updated *string
		var version int64
		if err := h.db.QueryRow("SELECT content, updated, version FROM files WHERE path = ? AND deleted = 0", path).Scan(&content, &updated, &version); err != nil {
			errJSON(w, 404, "not found")
			return
		}
		writeJSON(w, 200, obj{"path": path, "content": string(content), "size": len(content), "updated": updated, "version": version})
	}
}
