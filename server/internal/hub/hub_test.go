package hub

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// machineToken: noop's old shared fleet token, which is nobody here.
const machineToken = "machine-token-for-tests"

type env struct {
	t     *testing.T
	h     *Hub
	srv   *httptest.Server
	clock time.Time
	mu    sync.Mutex
}

func newEnv(t *testing.T) *env {
	t.Helper()
	db, err := OpenDB(filepath.Join(t.TempDir(), "hub.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	e := &env{t: t, clock: time.Date(2026, 11, 8, 4, 0, 0, 0, time.UTC)}
	e.h = New(Config{Now: e.now, Logf: t.Logf}, db)
	e.srv = httptest.NewServer(e.h)
	t.Cleanup(e.srv.Close)
	return e
}

func (e *env) now() time.Time { e.mu.Lock(); defer e.mu.Unlock(); return e.clock }
func (e *env) advance(d time.Duration) {
	e.mu.Lock()
	e.clock = e.clock.Add(d)
	e.mu.Unlock()
}

type resp struct {
	status int
	body   map[string]any
	raw    []byte
	header http.Header
}

func (e *env) do(method, path, token string, body any, hdr ...string) resp {
	e.t.Helper()
	var rd io.Reader
	ct := ""
	switch b := body.(type) {
	case nil:
	case *bytes.Buffer:
		rd = b
	default:
		j, _ := json.Marshal(b)
		rd = bytes.NewReader(j)
		ct = "application/json"
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, rd)
	if ct != "" {
		req.Header.Set("content-type", ct)
	}
	if token != "" {
		req.Header.Set("authorization", "Bearer "+token)
	}
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer r.Body.Close()
	raw, _ := io.ReadAll(r.Body)
	out := resp{status: r.StatusCode, raw: raw, header: r.Header}
	_ = json.Unmarshal(raw, &out.body)
	return out
}

func num(v any) int64 { f, _ := v.(float64); return int64(f) }

func check(t *testing.T, name string, ok bool, r ...resp) {
	t.Helper()
	if !ok {
		extra := ""
		if len(r) > 0 {
			extra = fmt.Sprintf(" — %d %s", r[0].status, r[0].raw)
		}
		t.Errorf("%s%s", name, extra)
	}
}

func totpNow(secret string, at time.Time) string {
	key, _ := b32.DecodeString(secret)
	return hotp(key, at.Unix()/totpStep)
}

// noop's single-person API (feed, files, host bridge, email sign-in) is gone: only /api/v1 answers.
func TestOnlyV1(t *testing.T) {
	e := newEnv(t)
	for _, p := range []string{"/api/feed", "/api/files/list", "/api/status", "/api/auth/start", "/api/host/inbox", "/media/x"} {
		r := e.do("GET", p, machineToken, nil)
		check(t, p+" is gone", r.status == 404 || (strings.HasPrefix(p, "/media/") && r.status != 200), r)
	}
}
