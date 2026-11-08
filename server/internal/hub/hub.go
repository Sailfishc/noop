// Package hub is the self-hosted coordination plane: a Go port of noop's Cloudflare Worker (cloud/src/index.ts).
// It speaks the same HTTP API, so noop's app and daemon work against it unchanged ([cloud] url = this server).
//
// One SQLite file holds the chat feed, the owner→fleet inbox, the fleet's status and settings snapshot, media,
// the shared fleet files and owner sessions. Machines only make outbound calls here.
//
// Not ported (yet): MCP + OAuth connectors, Web Push, the Cloudflare budget metering, export/import, IP allow-list.
package hub

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Config is everything the server needs; cmd/teamagent-server fills it from flags and the environment.
type Config struct {
	Token       string      // machine (fleet) credential, HUB_TOKEN in noop
	OwnerEmails []string    // owner allow-list for email-code sign-in (lower case)
	SMTP        *SMTPConfig // nil: sign-in codes are shown on the owner's machine (`noop login`)
	StaticDir   string      // the web client (app/dist/web/noop); empty: API only
	Now         func() time.Time
	Logf        func(format string, args ...any)
}

type Hub struct {
	cfg Config
	db  *sql.DB

	// mu makes each request's database work atomic, as the Durable Object's single thread did.
	// It is never held while waiting on the network (long-polls, sockets, mail).
	mu sync.Mutex

	socks        sockets
	inboxWaiters map[chan struct{}]struct{}
	acked        int64
	appends      int
	sendMail     func(to, subject, text string) error // nil: no mail configured; tests replace it
}

func New(cfg Config, db *sql.DB) *Hub {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logf == nil {
		cfg.Logf = log.Printf
	}
	for i, e := range cfg.OwnerEmails {
		cfg.OwnerEmails[i] = normEmail(e)
	}
	h := &Hub{cfg: cfg, db: db, inboxWaiters: map[chan struct{}]struct{}{}}
	h.socks.byTag = map[string]map[*sock]struct{}{}
	if cfg.SMTP != nil && cfg.SMTP.Host != "" {
		smtp := *cfg.SMTP
		h.sendMail = func(to, subject, text string) error { return smtp.Send(to, subject, text) }
	}
	return h
}

// SetMailer replaces how mail is sent (tests).
func (h *Hub) SetMailer(f func(to, subject, text string) error) { h.sendMail = f }

// locked runs f with h.mu held, and releases it even if f panics.
func (h *Hub) locked(f func()) {
	h.mu.Lock()
	defer h.mu.Unlock()
	f()
}

func (h *Hub) now() time.Time { return h.cfg.Now() }
func (h *Hub) nowMs() int64   { return h.now().UnixMilli() }

// isoTime is JavaScript's Date#toISOString: the feed compares these as strings.
func isoTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

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

func (h *Hub) kvDel(k string) { h.must(h.db.Exec("DELETE FROM kv WHERE k = ?", k)) }

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

const (
	maxBody      = 64 << 20 // a files commit carries many files, base64
	defaultLimit = 1 << 20
)

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
	p := r.URL.Path
	if !strings.HasPrefix(p, "/api/") && !strings.HasPrefix(p, "/media/") {
		h.static(w, r)
		return
	}
	if isMcpPath(p) {
		errJSON(w, 404, "MCP is not available on this server yet")
		return
	}
	// sockets and the long-poll manage the lock themselves
	switch p {
	case "/api/stream":
		h.ownerStream(w, r)
		return
	case "/api/host/stream":
		h.hostStream(w, r)
		return
	}
	limit := int64(defaultLimit)
	if p == "/api/files/commit" || p == "/api/media" || p == "/api/uploads" || p == "/api/files/revert" {
		limit = maxBody
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			errJSON(w, 413, "request too large")
			return
		}
		errJSON(w, 400, "could not read body")
		return
	}
	req := &request{r: r, body: body}

	if strings.HasPrefix(p, "/api/auth/") {
		h.auth(w, req)
		return
	}
	var who *principal
	h.locked(func() { who = h.who(r) })
	if who == nil {
		errJSON(w, 401, "unauthorized")
		return
	}
	req.who = who
	if p == "/api/host/inbox" {
		h.hostInbox(w, req)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.route(w, req)
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

func isMcpPath(p string) bool {
	return p == "/mcp" || strings.HasPrefix(p, "/oauth/") || strings.HasPrefix(p, "/.well-known/oauth-") || p == "/.well-known/openid-configuration"
}

// route runs with h.mu held.
func (h *Hub) route(w http.ResponseWriter, q *request) {
	p, m := q.r.URL.Path, q.r.Method
	machine := q.who.machine
	switch {
	case strings.HasPrefix(p, "/api/push/"):
		h.push(w, q)
	case (p == "/api/files/list" || p == "/api/files/read") && m == "GET":
		h.readFiles(w, q)
	case strings.HasPrefix(p, "/api/files/"):
		ownerOnly := p == "/api/files/history" || p == "/api/files/revert"
		if ownerOnly == machine {
			errJSON(w, 403, "forbidden")
			return
		}
		actor := "owner"
		if machine {
			actor = q.r.Header.Get("x-noop-host")
			if actor == "" {
				actor = "machine"
			}
		}
		h.files(w, q, actor)
	case strings.HasPrefix(p, "/api/host/2fa"):
		h.twoFactor(w, q)
	case p == "/api/host/login-code":
		if !machine {
			errJSON(w, 403, "forbidden")
			return
		}
		var c struct {
			Email   string `json:"email"`
			Code    string `json:"code"`
			Expires int64  `json:"expires"`
		}
		if h.kvGet("cli_code", &c) && c.Expires > h.nowMs() {
			writeJSON(w, 200, c)
			return
		}
		errJSON(w, 404, "no pending code")
	case p == "/api/host/join" && m == "POST":
		if machine {
			errJSON(w, 403, "forbidden")
			return
		}
		var b struct {
			Host string `json:"host"`
		}
		_ = q.json(&b)
		if b.Host == "" {
			b.Host = "?"
		}
		h.appendEvent(obj{"from": "hub", "kind": "notice", "text": "新机器 " + truncRunes(b.Host, 60) + " 已加入团队。"})
		writeJSON(w, 200, obj{"token": h.cfg.Token})
	case p == "/api/host/revoke-sessions" && m == "POST":
		if !machine {
			errJSON(w, 403, "forbidden")
			return
		}
		n := h.count("SELECT COUNT(*) FROM sessions")
		h.must(h.db.Exec("DELETE FROM sessions"))
		h.must(h.db.Exec("DELETE FROM auth_codes"))
		by := q.r.Header.Get("x-noop-host")
		if by == "" {
			by = "持有机器密钥的主机"
		}
		h.alert("所有登录已撤销", []string{itoa(n) + " 个登录（手机、浏览器）已被踢下线，需要重新用邮箱验证码登录。", "操作方：" + by})
		writeJSON(w, 200, obj{"ok": true, "revoked": n})
	case p == "/api/usage" && m == "GET":
		writeJSON(w, 200, h.usageView())
	case p == "/api/feed":
		h.feed(w, q)
	case p == "/api/messages" && m == "POST":
		h.postMessage(w, q)
	case p == "/api/uploads" && m == "POST":
		h.upload(w, q)
	case p == "/api/status":
		writeJSON(w, 200, h.statusView())
	case p == "/api/settings" && m == "GET":
		var s any
		if !h.kvGet("settings", &s) {
			s = obj{"current": obj{}, "effective": obj{}, "options": obj{}}
		}
		writeJSON(w, 200, s)
	case p == "/api/settings" && m == "PUT":
		h.putSettings(w, q)
	case p == "/api/tasks" && m == "GET":
		writeJSON(w, 200, taskHistory(h.store(), q.query("q"), atoiDefault(q.query("offset"), 0), atoiDefault(q.query("limit"), 0)))
	case p == "/api/tasks/get" && m == "GET":
		h.taskGet(w, q)
	case p == "/api/tasks/cancel" && m == "POST":
		if machine {
			errJSON(w, 403, "forbidden")
			return
		}
		var b struct {
			ID   string `json:"id"`
			Done bool   `json:"done"`
		}
		_ = q.json(&b)
		if !taskCancelID.MatchString(b.ID) {
			errJSON(w, 400, "id required")
			return
		}
		h.toInbox(obj{"type": "cancel", "id": b.ID, "done": b.Done})
		writeJSON(w, 200, obj{"ok": true})
	case p == "/api/channels" && m == "GET":
		writeJSON(w, 200, channelsView(h.store(), h.now(), 100))
	case p == "/api/channels/feed" && m == "GET":
		h.channelFeed(w, q)
	case p == "/api/channels" && m == "POST":
		h.postChannel(w, q)
	case p == "/api/fleet/update" && m == "POST":
		if machine {
			errJSON(w, 403, "forbidden")
			return
		}
		h.toInbox(obj{"type": "update"})
		writeJSON(w, 200, obj{"ok": true})
	case p == "/api/media" && m == "POST":
		h.postMedia(w, q)
	case strings.HasPrefix(p, "/media/") && m == "GET":
		h.getMedia(w, q)
	// ---- fleet side
	case p == "/api/events" && m == "POST":
		if !machine {
			errJSON(w, 403, "forbidden")
			return
		}
		var e obj
		if err := q.json(&e); err != nil || e == nil {
			errJSON(w, 400, "event required")
			return
		}
		writeJSON(w, 200, h.appendEvent(e))
	case p == "/api/host/state" && m == "PUT":
		h.hostState(w, q)
	default:
		errJSON(w, 404, "not found")
	}
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
