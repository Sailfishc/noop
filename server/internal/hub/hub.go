// Package hub is Remi's server: people, their machines and agents, channels, messages, tasks, reminders and
// files, in one SQLite file, under /api/v1 (v1.go). Machines only make outbound calls here.
package hub

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Config is everything the server needs; cmd/remi-server fills it from flags and the environment.
type Config struct {
	StaticDir string // the web client (app/dist/web/noop); empty: API only
	// PublicURL: the address others reach the server at ("http://remi.corp:8080"), for the links and commands
	// the apps hand out and the callbacks agents give; empty: each app uses the address it connected to.
	PublicURL string
	// GitWebhookSecret: the secret a GitLab-based platform (Ant Code) sends with its webhooks (X-Gitlab-Token);
	// empty: /api/v1/hooks/gitlab is off.
	GitWebhookSecret string
	Now              func() time.Time
	Logf             func(format string, args ...any)
}

type Hub struct {
	cfg Config
	db  *sql.DB

	// mu makes each request's database work atomic, as the Durable Object's single thread did.
	// It is never held while waiting on the network (long-polls, sockets, mail).
	mu sync.Mutex

	socks sockets
	v1    *http.ServeMux
}

func New(cfg Config, db *sql.DB) *Hub {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logf == nil {
		cfg.Logf = log.Printf
	}
	h := &Hub{cfg: cfg, db: db}
	h.socks.byTag = map[string]map[*sock]struct{}{}
	h.v1 = h.v1Routes()
	return h
}

// locked runs f with h.mu held, and releases it even if f panics.
func (h *Hub) locked(f func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	f()
}

func (h *Hub) now() time.Time { return h.cfg.Now() }
func (h *Hub) nowMs() int64   { return h.now().UnixMilli() }

// ---------------------------------------------------------------- small helpers

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

type obj = map[string]any

func errJSON(w http.ResponseWriter, status int, msg string) { writeJSON(w, status, obj{"error": msg}) }

func sha256hex(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func uuid4() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	x := hex.EncodeToString(b)
	return x[0:8] + "-" + x[8:12] + "-" + x[12:16] + "-" + x[16:20] + "-" + x[20:]
}

func sameStr(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

// decodeBody parses a JSON body; numbers stay json.Number so events pass through untouched.
func decodeBody(body []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(body))
	d.UseNumber()
	return d.Decode(v)
}

// ---------------------------------------------------------------- kv

func (h *Hub) kvGet(k string, v any) bool {
	var s string
	if err := h.db.QueryRow("SELECT v FROM kv WHERE k = ?", k).Scan(&s); err != nil {
		return false
	}
	d := json.NewDecoder(strings.NewReader(s))
	d.UseNumber()
	return d.Decode(v) == nil
}

func (h *Hub) kvSet(k string, v any) {
	b, _ := json.Marshal(v)
	h.must(h.db.Exec("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)", k, string(b)))
}

func (h *Hub) must(_ sql.Result, err error) {
	if err != nil {
		panic(err) // recovered in ServeHTTP as a 500
	}
}

func (h *Hub) count(q string, args ...any) int64 {
	var n int64
	if err := h.db.QueryRow(q, args...).Scan(&n); err != nil {
		panic(err)
	}
	return n
}

// ---------------------------------------------------------------- routing

const defaultLimit = 1 << 20

func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if v := recover(); v != nil {
			if v == http.ErrAbortHandler {
				panic(v)
			}
			h.cfg.Logf("panic on %s %s: %v", r.Method, r.URL.Path, v)
			errJSON(w, 500, "internal error")
		}
	}()
	if strings.HasPrefix(r.URL.Path, "/api/") {
		h.v1.ServeHTTP(w, r)
		return
	}
	h.static(w, r)
}

// request is one API call with its body already read (so the lock is never held while a slow client uploads).
type request struct {
	r    *http.Request
	body []byte
	who  *principal
}

func (q *request) json(v any) error { return decodeBody(q.body, v) }
func (q *request) query(k string) string {
	return q.r.URL.Query().Get(k)
}

// static serves the web client as a single-page app (unknown paths get index.html).
func (h *Hub) static(w http.ResponseWriter, r *http.Request) {
	if h.cfg.StaticDir == "" {
		http.NotFound(w, r)
		return
	}
	clean := filepath.Clean("/" + r.URL.Path)
	f := filepath.Join(h.cfg.StaticDir, filepath.FromSlash(clean))
	if st, err := os.Stat(f); err != nil || st.IsDir() {
		if st != nil && st.IsDir() {
			if _, err := os.Stat(filepath.Join(f, "index.html")); err == nil {
				http.ServeFile(w, r, filepath.Join(f, "index.html"))
				return
			}
		}
		f = filepath.Join(h.cfg.StaticDir, "index.html")
	}
	http.ServeFile(w, r, f)
}
