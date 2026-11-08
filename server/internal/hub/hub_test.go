package hub

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const machineToken = "machine-token-for-tests"

type env struct {
	t     *testing.T
	h     *Hub
	srv   *httptest.Server
	owner string // an owner session
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
	e.h = New(Config{Token: machineToken, OwnerEmails: []string{"Owner@Example.com"}, Now: e.now, Logf: t.Logf}, db)
	e.srv = httptest.NewServer(e.h)
	t.Cleanup(e.srv.Close)
	e.h.mu.Lock()
	e.owner = e.h.newSession("owner@example.com", "test")
	e.h.mu.Unlock()
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

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

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

// The files contract, as cloud/test/run.ts checks it against the Worker.
func TestFilesContract(t *testing.T) {
	e := newEnv(t)
	commit := func(changes ...map[string]any) resp {
		return e.do("POST", "/api/files/commit", machineToken, map[string]any{"msg": "m", "changes": changes}, "x-noop-host", "mac1")
	}
	r := commit(map[string]any{"path": "x/a.md", "base_version": 0, "content": b64("A1")},
		map[string]any{"path": "x/bin", "base_version": 0, "content": base64.StdEncoding.EncodeToString([]byte{0, 255, 1, 254})})
	check(t, "commit new files", r.status == 200 && len(r.body["files"].([]any)) == 2, r)
	rev0 := num(r.body["rev"])

	r = commit(map[string]any{"path": "x/new.md", "base_version": 0, "content": b64("x")}, map[string]any{"path": "x/a.md", "base_version": 0, "content": b64("A?")})
	check(t, "409 on stale base", r.status == 409 && r.body["conflicts"].([]any)[0] == "x/a.md", r)
	r = e.do("GET", "/api/files/history?path=x/new.md", e.owner, nil)
	check(t, "409 applied nothing", r.status == 200 && len(r.body["history"].([]any)) == 0, r)

	r = commit(map[string]any{"path": "x/a.md", "base_version": 1, "content": b64("A2")}, map[string]any{"path": "x/bin", "base_version": 1, "deleted": true})
	check(t, "CAS edit + delete", r.status == 200 && r.body["files"].([]any)[1].(map[string]any)["deleted"] == true, r)

	r = e.do("GET", fmt.Sprintf("/api/files/changes?since=%d", rev0-2), machineToken, nil)
	var gotA string
	var binDeleted bool
	for _, f := range r.body["files"].([]any) {
		m := f.(map[string]any)
		if m["path"] == "x/a.md" {
			b, _ := base64.StdEncoding.DecodeString(m["content"].(string))
			gotA = string(b)
		}
		if m["path"] == "x/bin" {
			binDeleted = m["deleted"] == true && m["content"] == nil
		}
	}
	check(t, "changes since", gotA == "A2" && binDeleted, r)

	r = e.do("GET", "/api/files/history?path=x/a.md&content=1", e.owner, nil)
	h := r.body["history"].([]any)
	check(t, "history newest first, by the host", len(h) == 2 && num(h[0].(map[string]any)["version"]) == 2 && h[0].(map[string]any)["by"] == "mac1", r)

	r = e.do("POST", "/api/files/revert", e.owner, map[string]any{"path": "x/a.md", "version": 1})
	check(t, "revert", r.status == 200 && num(r.body["version"]) == 3, r)
	r = e.do("POST", "/api/files/revert", e.owner, map[string]any{"path": "x/bin", "version": 1})
	check(t, "revert a delete restores binary", r.status == 200, r)
	r = e.do("GET", fmt.Sprintf("/api/files/changes?since=%d", rev0), machineToken, nil)
	for _, f := range r.body["files"].([]any) {
		m := f.(map[string]any)
		if m["path"] == "x/bin" {
			b, _ := base64.StdEncoding.DecodeString(m["content"].(string))
			check(t, "binary round trip", bytes.Equal(b, []byte{0, 255, 1, 254}), r)
		}
	}

	pages, seen := 0, 0
	for since, more := int64(0), true; more; pages++ {
		r = e.do("GET", fmt.Sprintf("/api/files/changes?since=%d&limit=1", since), machineToken, nil)
		since, more = num(r.body["rev"]), r.body["more"] == true
		seen += len(r.body["files"].([]any))
	}
	check(t, "pagination", pages > 1 && seen == 2)

	r = commit(map[string]any{"path": "x/big", "base_version": 0, "content": base64.StdEncoding.EncodeToString(make([]byte, 1_600_000))})
	check(t, "413 over 1.5 MB", r.status == 413, r)
	r = commit(map[string]any{"path": "../etc/passwd", "base_version": 0, "content": b64("x")})
	check(t, "400 on traversal", r.status == 400, r)
	r = commit(map[string]any{"path": "x/.git/config", "base_version": 0, "content": b64("x")})
	check(t, "400 on .git", r.status == 400, r)

	r = commit(map[string]any{"path": "x/empty", "base_version": 0, "content": ""})
	check(t, "empty file commits", r.status == 200, r)
	r = e.do("GET", "/api/files/changes?since=0", machineToken, nil)
	for _, f := range r.body["files"].([]any) {
		if m := f.(map[string]any); m["path"] == "x/empty" {
			check(t, "an empty file is not a delete", m["deleted"] == false && m["content"] == "", r)
		}
	}
	r = e.do("GET", "/api/files/history?path=x/empty", e.owner, nil)
	check(t, "an empty file's history is not a delete", r.body["history"].([]any)[0].(map[string]any)["deleted"] == false, r)

	// roles: commits are the machines', history and revert the owner's
	check(t, "owner cannot commit", e.do("POST", "/api/files/commit", e.owner, map[string]any{"changes": []any{}}).status == 403)
	check(t, "machine cannot read history", e.do("GET", "/api/files/history?path=x/a.md", machineToken, nil).status == 403)

	// journals keep no history: their history is the current row
	commit(map[string]any{"path": "journal/2026-11-08.md", "base_version": 0, "content": b64("j1")})
	commit(map[string]any{"path": "journal/2026-11-08.md", "base_version": 1, "content": b64("j2")})
	r = e.do("GET", "/api/files/history?path=journal/2026-11-08.md&content=1", e.owner, nil)
	h = r.body["history"].([]any)
	check(t, "latest-only paths", len(h) == 1 && h[0].(map[string]any)["content"] == b64("j2"), r)
}

// Concurrent claims on one path: exactly one wins (the task-claim lock).
func TestFilesCASRace(t *testing.T) {
	e := newEnv(t)
	e.do("POST", "/api/files/commit", machineToken, map[string]any{"changes": []any{map[string]any{"path": "tasks/inbox/T-0001.md", "base_version": 0, "content": b64("t")}}})
	var wg sync.WaitGroup
	wins := make(chan string, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r := e.do("POST", "/api/files/commit", machineToken, map[string]any{"changes": []any{
				map[string]any{"path": "tasks/inbox/T-0001.md", "base_version": 1, "deleted": true},
				map[string]any{"path": "tasks/active/T-0001.md", "base_version": 0, "content": b64(fmt.Sprintf("claimed_by: h%d", i))},
			}})
			if r.status == 200 {
				wins <- fmt.Sprint(i)
			}
		}(i)
	}
	wg.Wait()
	close(wins)
	n := 0
	for range wins {
		n++
	}
	check(t, "exactly one claim wins", n == 1)
}

func TestAuthAndRoles(t *testing.T) {
	e := newEnv(t)
	check(t, "no credential", e.do("GET", "/api/status", "", nil).status == 401)
	check(t, "wrong token", e.do("GET", "/api/status", "nope", nil).status == 401)
	check(t, "machine", e.do("GET", "/api/status", machineToken, nil).status == 200)
	check(t, "owner", e.do("GET", "/api/status", e.owner, nil).status == 200)
	check(t, "?token= for sockets and <img>", e.do("GET", "/api/status?token="+e.owner, "", nil).status == 200)
	check(t, "owner cannot post fleet events", e.do("POST", "/api/events", e.owner, map[string]any{"kind": "x"}).status == 403)
	check(t, "owner cannot read the inbox", e.do("GET", "/api/host/inbox", e.owner, nil).status == 403)
	check(t, "machine cannot cancel tasks", e.do("POST", "/api/tasks/cancel", machineToken, map[string]any{"id": "T-0001"}).status == 403)
	r := e.do("POST", "/api/host/join", e.owner, map[string]any{"host": "mac2"})
	check(t, "owner gets the machine key for a new machine", r.status == 200 && r.body["token"] == machineToken, r)

	// idle sessions expire
	e.advance(31 * 24 * time.Hour)
	check(t, "idle session expires", e.do("GET", "/api/status", e.owner, nil).status == 401)

	r = e.do("POST", "/api/host/revoke-sessions", machineToken, nil)
	check(t, "revoke", r.status == 200, r)
}

func totpNow(secret string, at time.Time) string {
	key, _ := b32.DecodeString(secret)
	return hotp(key, at.Unix()/totpStep)
}

// Sign-in without mail: 2FA bound from a machine, code shown on the machine (`noop login`), verify → session.
func TestSignIn(t *testing.T) {
	e := newEnv(t)
	r := e.do("POST", "/api/auth/start", "", map[string]any{"email": "owner@example.com"})
	check(t, "no 2FA, no sign-in", r.status == 403 && r.body["error"] == "totp_not_setup", r)

	r = e.do("POST", "/api/host/2fa/setup", machineToken, nil)
	secret, _ := r.body["secret"].(string)
	check(t, "2fa setup", r.status == 200 && strings.HasPrefix(r.body["uri"].(string), "otpauth://totp/"), r)
	check(t, "2fa wrong code", e.do("POST", "/api/host/2fa/confirm", machineToken, map[string]any{"totp": "000000"}).status == 400)
	r = e.do("POST", "/api/host/2fa/confirm", machineToken, map[string]any{"totp": totpNow(secret, e.now())})
	check(t, "2fa confirm", r.status == 200 && r.body["replaced"] == false, r)
	check(t, "owner cannot set up 2FA", e.do("POST", "/api/host/2fa/setup", e.owner, nil).status == 403)

	check(t, "stranger refused", e.do("POST", "/api/auth/start", "", map[string]any{"email": "eve@example.com"}).status == 403)
	r = e.do("POST", "/api/auth/start", "", map[string]any{"email": "OWNER@example.com"})
	check(t, "start (cli delivery)", r.status == 200 && r.body["delivery"] == "cli", r)
	check(t, "resend too soon", e.do("POST", "/api/auth/start", "", map[string]any{"email": "owner@example.com"}).status == 429)
	r = e.do("GET", "/api/host/login-code", machineToken, nil)
	code, _ := r.body["code"].(string)
	check(t, "login code on the machine", r.status == 200 && len(code) == 8, r)

	e.advance(30 * time.Second) // the confirm used this step's code; a code works once
	r = e.do("POST", "/api/auth/verify", "", map[string]any{"email": "owner@example.com", "code": code, "totp": "123456"})
	check(t, "wrong TOTP", r.status == 401, r)
	r = e.do("POST", "/api/auth/verify", "", map[string]any{"email": "owner@example.com", "code": strings.ToLower(code[:4] + "-" + code[4:]), "totp": totpNow(secret, e.now())})
	session, _ := r.body["session"].(string)
	check(t, "verify", r.status == 200 && len(session) == 64, r)
	check(t, "the new session works", e.do("GET", "/api/feed", session, nil).status == 200)
	r = e.do("POST", "/api/auth/verify", "", map[string]any{"email": "owner@example.com", "code": code, "totp": totpNow(secret, e.now())})
	check(t, "code works once", r.status == 401, r)
	e.do("POST", "/api/auth/logout", session, nil)
	check(t, "logout", e.do("GET", "/api/feed", session, nil).status == 401)

	// the feed recorded the security notices
	r = e.do("GET", "/api/feed", e.owner, nil)
	var notices []string
	for _, ev := range r.body["events"].([]any) {
		if m := ev.(map[string]any); m["kind"] == "notice" {
			notices = append(notices, m["text"].(string))
		}
	}
	joined := strings.Join(notices, "\n")
	check(t, "alerts in the feed", strings.Contains(joined, "两步验证已开启") && strings.Contains(joined, "新登录") && strings.Contains(joined, "两步验证码错误"))
}

func TestSignInByMail(t *testing.T) {
	e := newEnv(t)
	var mails []string
	var mu sync.Mutex
	e.h.SetMailer(func(to, subject, text string) error {
		mu.Lock()
		mails = append(mails, to+"|"+subject)
		mu.Unlock()
		return nil
	})
	secret := newTOTPSecret()
	e.h.kvSet("totp", totpState{Secret: secret})
	r := e.do("POST", "/api/auth/start", "", map[string]any{"email": "owner@example.com"})
	check(t, "start by mail", r.status == 200 && r.body["delivery"] == nil, r)
	mu.Lock()
	defer mu.Unlock()
	check(t, "code mailed", len(mails) == 1 && strings.HasPrefix(mails[0], "owner@example.com|Noop 登录验证码："))
}

// Owner message → feed + inbox; the daemon drains and acks; retries with a client_id don't duplicate.
func TestMessagesAndInbox(t *testing.T) {
	e := newEnv(t)
	r := e.do("POST", "/api/messages", e.owner, map[string]any{"text": "修一下结算页", "client_id": "c-1"})
	id, _ := r.body["id"].(string)
	check(t, "message", r.status == 200 && r.body["from"] == "owner", r)
	r2 := e.do("POST", "/api/messages", e.owner, map[string]any{"text": "修一下结算页", "client_id": "c-1"})
	check(t, "client_id dedupes", r2.body["id"] == id, r2)
	check(t, "bad client_id", e.do("POST", "/api/messages", e.owner, map[string]any{"text": "x", "client_id": "a b"}).status == 400)
	check(t, "empty message", e.do("POST", "/api/messages", e.owner, map[string]any{"text": "  "}).status == 400)

	r = e.do("GET", "/api/feed", e.owner, nil)
	evs := r.body["events"].([]any)
	check(t, "offline notice follows", len(evs) == 2 && evs[1].(map[string]any)["kind"] == "system" && evs[1].(map[string]any)["ref"] == id, r)

	r = e.do("GET", "/api/host/inbox?after=0", machineToken, nil)
	items := r.body["items"].([]any)
	check(t, "one inbox item", len(items) == 1 && items[0].(map[string]any)["type"] == "message", r)
	seq := num(items[0].(map[string]any)["seq"])
	r = e.do("GET", fmt.Sprintf("/api/host/inbox?after=%d", seq), machineToken, nil)
	check(t, "acked", len(r.body["items"].([]any)) == 0, r)

	// the host polled, so it is online: no offline notice
	e.do("POST", "/api/messages", e.owner, map[string]any{"text": "第二条"})
	r = e.do("GET", "/api/feed", e.owner, nil)
	check(t, "no offline notice while the host is online", len(r.body["events"].([]any)) == 3, r)
	e.advance(4 * time.Minute)
	check(t, "host goes stale", e.do("GET", "/api/status", e.owner, nil).body["hub"].(map[string]any)["online"] == false)

	// fleet events keep their own id and ts
	r = e.do("POST", "/api/events", machineToken, map[string]any{"id": "ev-1", "ts": "2026-11-08T05:00:00.000Z", "from": "agent", "kind": "reply", "text": "好", "ref": "T-0042", "n": 3})
	check(t, "fleet event", r.status == 200 && r.body["id"] == "ev-1" && num(r.body["n"]) == 3, r)
	r = e.do("GET", "/api/feed?since=2026-11-08T04:59:00.000Z", e.owner, nil)
	check(t, "feed since", len(r.body["events"].([]any)) == 1, r)
}

func TestInboxLongPoll(t *testing.T) {
	e := newEnv(t)
	done := make(chan resp, 1)
	start := time.Now()
	go func() { done <- e.do("GET", "/api/host/inbox?after=0&wait=10", machineToken, nil) }()
	time.Sleep(200 * time.Millisecond)
	e.do("POST", "/api/fleet/update", e.owner, nil)
	select {
	case r := <-done:
		check(t, "long-poll wakes on a new item", len(r.body["items"].([]any)) == 1 && time.Since(start) < 5*time.Second, r)
	case <-time.After(8 * time.Second):
		t.Fatal("long-poll did not wake")
	}
}

func TestSettingsAndState(t *testing.T) {
	e := newEnv(t)
	r := e.do("GET", "/api/settings", e.owner, nil)
	check(t, "default settings", r.status == 200 && r.body["current"] != nil, r)
	e.do("PUT", "/api/host/state", machineToken, map[string]any{"status": map[string]any{"active": []any{}, "decisions": []any{}}, "settings": map[string]any{"current": map[string]any{"a": map[string]any{"x": 1, "y": 2}}}})
	r = e.do("PUT", "/api/settings", e.owner, map[string]any{"a": map[string]any{"y": 3}, "media_days": 30})
	cur := r.body["current"].(map[string]any)
	a := cur["a"].(map[string]any)
	check(t, "deep merge", num(a["x"]) == 1 && num(a["y"]) == 3 && num(cur["media_days"]) == 30, r)
	r = e.do("GET", "/api/host/inbox", machineToken, nil)
	it := r.body["items"].([]any)[0].(map[string]any)
	check(t, "settings patch queued for the primary", it["type"] == "settings" && it["patch"].(map[string]any)["media_days"] != nil, r)
	r = e.do("GET", "/api/status", e.owner, nil)
	check(t, "status snapshot + hub", r.body["active"] != nil && r.body["hub"].(map[string]any)["online"] == true, r)
}

func multipartFile(name, typ string, data []byte) (*bytes.Buffer, string) {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	h := make(map[string][]string)
	h["Content-Disposition"] = []string{fmt.Sprintf(`form-data; name="file"; filename="%s"`, name)}
	if typ != "" {
		h["Content-Type"] = []string{typ}
	}
	p, _ := w.CreatePart(h)
	p.Write(data)
	w.Close()
	return &buf, w.FormDataContentType()
}

func TestUploadsAndMedia(t *testing.T) {
	e := newEnv(t)
	png := append([]byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}, make([]byte, 100)...)
	body, ct := multipartFile("截图 1.png", "application/octet-stream", png)
	r := e.do("POST", "/api/uploads", e.owner, body, "content-type", ct)
	url, _ := r.body["url"].(string)
	check(t, "upload sniffs a png", r.status == 200 && strings.HasPrefix(url, "/media/"), r)

	body, ct = multipartFile("x.svg", "image/svg+xml", []byte("<svg/>"))
	check(t, "svg refused", e.do("POST", "/api/uploads", e.owner, body, "content-type", ct).status == 415)

	r = e.do("POST", "/api/messages", e.owner, map[string]any{"text": "", "attachments": []any{url}})
	check(t, "image-only message", r.status == 200 && len(r.body["attachments"].([]any)) == 1, r)
	check(t, "unknown attachment", e.do("POST", "/api/messages", e.owner, map[string]any{"text": "x", "attachments": []any{"/media/nope"}}).status == 400)
	check(t, "foreign attachment", e.do("POST", "/api/messages", e.owner, map[string]any{"text": "x", "attachments": []any{"https://evil/x.png"}}).status == 400)

	r = e.do("GET", url, e.owner, nil)
	check(t, "media served inline, sandboxed", r.status == 200 && bytes.Equal(r.raw, png) && r.header.Get("content-type") == "image/png" &&
		strings.HasPrefix(r.header.Get("content-security-policy"), "sandbox"), r)

	big := bytes.Repeat([]byte("ab"), 1_200_000) // 2.4 MB: three chunks
	body, ct = multipartFile("log.html", "text/html", big)
	r = e.do("POST", "/api/media", machineToken, body, "content-type", ct)
	r = e.do("GET", r.body["url"].(string), e.owner, nil)
	check(t, "chunked media round trip, html as a download", bytes.Equal(r.raw, big) && r.header.Get("content-type") == "application/octet-stream" &&
		strings.HasPrefix(r.header.Get("content-disposition"), "attachment"), r)

	// media past media_days is pruned (ids start with the upload's milliseconds)
	e.advance(8 * 24 * time.Hour)
	e.h.mu.Lock()
	e.h.pruneMedia(true)
	e.h.mu.Unlock()
	check(t, "pruned after 7 days", e.do("GET", url, e.owner, nil).status == 404)
}

func TestSockets(t *testing.T) {
	e := newEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws := strings.Replace(e.srv.URL, "http", "ws", 1)

	host, _, err := websocket.Dial(ctx, ws+"/api/host/stream", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + machineToken}}})
	if err != nil {
		t.Fatal(err)
	}
	defer host.CloseNow()
	_, _, err = websocket.Dial(ctx, ws+"/api/host/stream?token="+e.owner, nil)
	check(t, "owner cannot open the host stream", err != nil)

	owner, _, err := websocket.Dial(ctx, ws+"/api/stream?v=2&token="+e.owner, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.CloseNow()

	read := func(c *websocket.Conn, want string) string {
		for {
			_, b, err := c.Read(ctx)
			if err != nil {
				t.Fatalf("waiting for %q: %v", want, err)
			}
			if strings.Contains(string(b), want) {
				return string(b)
			}
		}
	}
	read(host, `{"n":1,"type":"watchers"}`)
	host.Write(ctx, websocket.MessageText, []byte("ping"))
	read(host, "pong")

	check(t, "host socket counts as online", e.do("GET", "/api/status", e.owner, nil).body["hub"].(map[string]any)["online"] == true)
	e.do("POST", "/api/messages", e.owner, map[string]any{"text": "你好"})
	read(host, `{"type":"inbox"}`)
	got := read(owner, `"text":"你好"`)
	check(t, "owner socket gets the event", strings.Contains(got, `"from":"owner"`))
	e.do("PUT", "/api/host/state", machineToken, map[string]any{"status": map[string]any{"active": []any{}}})
	read(owner, `"$status"`)
}

func TestTasksAndChannels(t *testing.T) {
	e := newEnv(t)
	task := "---\nid: T-0042\ntitle: 修复金额输入框\nagent: amar\nclaimed_by: mac1\nstarted: 2026-11-08T03:00:00Z\nchannels: pay-fe\n---\n> 结算页金额输入框在 Safari 跳光标\n\n## Run 2026-11-08T03:00 · mac1 · codex\n**done** — 修好了，见 reports/fix.md\n"
	files := []any{
		map[string]any{"path": "tasks/active/T-0042.md", "base_version": 0, "content": b64(task)},
		map[string]any{"path": "tasks/done/T-0041.md", "base_version": 0, "content": b64("---\nid: T-0041\ntitle: 旧任务\nfinished: 2026-11-01T00:00:00Z\n---\nbody\n")},
		map[string]any{"path": "channels/pay-fe.md", "base_version": 0, "content": b64("---\nname: 支付前端\ngoal: 结算页\n---\n")},
		map[string]any{"path": "decisions/open/D-0007.md", "base_version": 0, "content": b64("---\nid: D-0007\ntask: T-0042\nquestion: 先改哪个？\ncreated: 2026-11-08T03:30:00Z\n---\n")},
		map[string]any{"path": "reports/fix.md", "base_version": 0, "content": b64("# fix")},
	}
	r := e.do("POST", "/api/files/commit", machineToken, map[string]any{"changes": files})
	check(t, "seed", r.status == 200, r)
	e.do("POST", "/api/events", machineToken, map[string]any{"from": "agent", "kind": "reply", "text": "开工", "ref": "T-0042"})
	e.do("POST", "/api/events", machineToken, map[string]any{"from": "agent", "kind": "reply", "text": "线程里", "ref": "T-0042", "thread": true})

	r = e.do("GET", "/api/tasks", e.owner, nil)
	ts := r.body["tasks"].([]any)
	check(t, "task history newest first", num(r.body["total"]) == 2 && ts[0].(map[string]any)["id"] == "T-0042" && ts[0].(map[string]any)["host"] == "mac1", r)
	r = e.do("GET", "/api/tasks?q=旧", e.owner, nil)
	check(t, "task search", num(r.body["total"]) == 1, r)

	r = e.do("GET", "/api/tasks/get?id=T-0042", e.owner, nil)
	check(t, "task page", r.status == 200 && r.body["request"] == "结算页金额输入框在 Safari 跳光标" && len(r.body["runs"].([]any)) == 1 &&
		r.body["decisions"].([]any)[0] == "D-0007" && len(r.body["events"].([]any)) == 2, r)

	r = e.do("GET", "/api/channels", e.owner, nil)
	ch := r.body["channels"].([]any)[0].(map[string]any)
	check(t, "channel items: task, card, report", ch["name"] == "支付前端" && num(ch["count"]) == 3 && len(ch["refs"].([]any)) == 2, r)
	r = e.do("GET", "/api/channels/feed?slug=pay-fe", e.owner, nil)
	check(t, "channel digest leaves thread chatter out", len(r.body["events"].([]any)) == 1, r)

	r = e.do("POST", "/api/channels", e.owner, map[string]any{"slug": "pay-fe", "archived": true})
	check(t, "channel edit queued", r.status == 200, r)
	r = e.do("POST", "/api/tasks/cancel", e.owner, map[string]any{"id": "T-0042"})
	check(t, "cancel queued", r.status == 200, r)
	r = e.do("GET", "/api/host/inbox", machineToken, nil)
	check(t, "both in the inbox", len(r.body["items"].([]any)) == 2, r)

	r = e.do("GET", "/api/files/read?path=reports/fix.md", e.owner, nil)
	check(t, "owner reads reports", r.status == 200 && r.body["content"] == "# fix", r)
	check(t, "owner cannot read tasks raw", e.do("GET", "/api/files/read?path=tasks/active/T-0042.md", e.owner, nil).status == 403)
	r = e.do("GET", "/api/files/list?prefix=reports", e.owner, nil)
	check(t, "list reports", len(r.body["files"].([]any)) == 1, r)
}
