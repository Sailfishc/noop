package hub

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Auth, as in cloud/src/index.ts: the machine token (HUB_TOKEN) is the fleet credential; an owner signs in with an
// emailed one-time code plus a mandatory TOTP, and gets a session whose sha256 is all that is stored.

const (
	codeTTL        = 10 * time.Minute
	codeTries      = 5
	resendEvery    = time.Minute
	sendsPerHour   = 10
	seenEvery      = time.Hour
	failsPerDay    = 20
	sessionIdle    = 30 * 24 * time.Hour
	totpMissingMsg = "还没有绑定两步验证（验证器 App），任何人都无法登录：先在你的主机上运行 noop 2fa setup"
)

type principal struct {
	machine   bool
	session   string // sha256 of the session id
	userID    string // the person signed in (a session), or the machine's owner (a machine token)
	machineID string // a per-machine token; "" for the shared legacy token
}

const machineTokenPrefix = "tam_"

func credential(r *http.Request) string {
	if a := r.Header.Get("authorization"); strings.HasPrefix(a, "Bearer ") {
		return strings.TrimSpace(a[7:])
	}
	return r.URL.Query().Get("token") // WebSocket / <img> can't send headers
}

var hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

// who: the machine for the token, the session for an owner session, nil otherwise. A session whose email left the
// allow-list, or that went unused past sessionIdle, is deleted on sight. Call with h.mu held.
func (h *Hub) who(r *http.Request) *principal {
	t := credential(r)
	if t == "" {
		return nil
	}
	if h.cfg.Token != "" && sameStr(t, h.cfg.Token) {
		return &principal{machine: true}
	}
	if strings.HasPrefix(t, machineTokenPrefix) {
		var mid, owner string
		var disabled bool
		err := h.db.QueryRow(`SELECT m.id, m.owner_id, u.disabled FROM machines m JOIN users u ON u.id = m.owner_id WHERE m.token_hash = ?`,
			sha256hex([]byte(t))).Scan(&mid, &owner, &disabled)
		if err != nil || disabled {
			return nil
		}
		h.must(h.db.Exec("UPDATE machines SET last_seen = ? WHERE id = ?", h.nowMs(), mid))
		return &principal{machine: true, machineID: mid, userID: owner}
	}
	if !hex64.MatchString(t) {
		return nil
	}
	id := sha256hex([]byte(t))
	var lastSeen int64
	var email, scope, userID string
	var scopeN, userN *string
	if err := h.db.QueryRow("SELECT last_seen, email, scope, user_id FROM sessions WHERE id = ?", id).Scan(&lastSeen, &email, &scopeN, &userN); err != nil {
		return nil
	}
	if scopeN != nil {
		scope = *scopeN
	}
	if userN != nil {
		userID = *userN
	}
	now := h.nowMs()
	allowed := h.ownerOk(email)
	if userID != "" { // a person's session lives as long as the person is enabled
		allowed = h.count("SELECT COUNT(*) FROM users WHERE id = ? AND disabled = 0", userID) == 1
	}
	if !allowed || now-lastSeen > sessionIdle.Milliseconds() {
		h.must(h.db.Exec("DELETE FROM sessions WHERE id = ?", id))
		return nil
	}
	if scope == "mcp" { // connector tokens are for /mcp only, which this server does not serve
		return nil
	}
	if now-lastSeen > seenEvery.Milliseconds() {
		h.must(h.db.Exec("UPDATE sessions SET last_seen = ? WHERE id = ?", now, id))
	}
	return &principal{session: id, userID: userID}
}

func normEmail(e string) string { return strings.ToLower(strings.TrimSpace(e)) }

var emailRE = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

func validEmail(e string) bool { return len(e) <= 254 && emailRE.MatchString(e) }

func (h *Hub) owners() []string { return h.cfg.OwnerEmails }
func (h *Hub) ownerOk(email string) bool {
	if len(h.cfg.OwnerEmails) == 0 {
		return true
	}
	e := normEmail(email)
	for _, o := range h.cfg.OwnerEmails {
		if o == e {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------- one-time codes (cloud/src/authcode.ts)

const codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789" // no 0/O, 1/I/L
const codeLen = 8

var codeRE = regexp.MustCompile("^[" + codeAlphabet + "]{8}$")

func newCode() string {
	out := make([]byte, 0, codeLen)
	b := make([]byte, 1)
	for len(out) < codeLen {
		if _, err := rand.Read(b); err != nil {
			panic(err)
		}
		if b[0] < 248 { // unbiased: 248 = 8 × 31
			out = append(out, codeAlphabet[int(b[0])%31])
		}
	}
	return string(out)
}

var codeStrip = regexp.MustCompile(`[\s-]`)

func normCode(c string) string { return codeStrip.ReplaceAllString(strings.ToUpper(c), "") }

// ---------------------------------------------------------------- TOTP (cloud/src/totp.ts: RFC 6238, SHA-1, 30 s, 6 digits)

const totpStep = 30

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

func newTOTPSecret() string {
	b := make([]byte, 20)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b32.EncodeToString(b)
}

func hotp(key []byte, counter int64) string {
	m := hmac.New(sha1.New, key)
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], uint64(counter))
	m.Write(msg[:])
	s := m.Sum(nil)
	o := s[len(s)-1] & 15
	n := (uint32(s[o])&127)<<24 | uint32(s[o+1])<<16 | uint32(s[o+2])<<8 | uint32(s[o+3])
	return fmt.Sprintf("%06d", n%1_000_000)
}

var sixDigits = regexp.MustCompile(`^\d{6}$`)

// totpMatch: the step the code matches within ±1 step, or -1. Steps ≤ after were already used (a code works once).
func totpMatch(secret, code string, after int64, now time.Time) int64 {
	c := strings.Join(strings.Fields(code), "")
	if !sixDigits.MatchString(c) {
		return -1
	}
	key, err := b32.DecodeString(strings.ToUpper(strings.NewReplacer(" ", "", "=", "", "-", "").Replace(secret)))
	if err != nil {
		return -1
	}
	cur := now.Unix() / totpStep
	for s := cur - 1; s <= cur+1; s++ {
		if s <= after {
			continue
		}
		if sameStr(hotp(key, s), c) {
			return s
		}
	}
	return -1
}

func otpauthURI(secret, account string) string {
	label := url.PathEscape("Noop:" + account)
	return fmt.Sprintf("otpauth://totp/%s?secret=%s&issuer=Noop&algorithm=SHA1&digits=6&period=30", label, secret)
}

type totpState struct {
	Secret string `json:"secret"`
	Last   *int64 `json:"last,omitempty"`
	Bound  *int64 `json:"bound,omitempty"`
}

func (h *Hub) totp() *totpState {
	var t totpState
	if h.kvGet("totp", &t) && t.Secret != "" {
		return &t
	}
	return nil
}

// ---------------------------------------------------------------- routes

func (h *Hub) auth(w http.ResponseWriter, q *request) {
	if q.r.Method != "POST" {
		errJSON(w, 405, "method not allowed")
		return
	}
	var b struct {
		Email string `json:"email"`
		Code  string `json:"code"`
		TOTP  string `json:"totp"`
	}
	_ = q.json(&b)
	switch q.r.URL.Path {
	case "/api/auth/start":
		h.authStart(w, normEmail(b.Email))
	case "/api/auth/verify":
		h.mu.Lock()
		defer h.mu.Unlock()
		email, status, msg := h.checkCode(b.Email, b.Code, b.TOTP, q.r, "App / 浏览器登录")
		if email == "" {
			errJSON(w, status, msg)
			return
		}
		writeJSON(w, 200, obj{"session": h.newSession(email, q.r.UserAgent())})
	case "/api/auth/logout":
		h.mu.Lock()
		defer h.mu.Unlock()
		if p := h.who(q.r); p != nil && !p.machine {
			h.must(h.db.Exec("DELETE FROM sessions WHERE id = ?", p.session))
		}
		writeJSON(w, 200, obj{"ok": true})
	default:
		errJSON(w, 404, "not found")
	}
}

func (h *Hub) authStart(w http.ResponseWriter, email string) {
	if !validEmail(email) {
		errJSON(w, 400, "invalid email")
		return
	}
	var (
		status int
		body   any
		code   string
		send   func(to, subject, text string) error
	)
	h.locked(func() { status, body, code, send = h.issueCode(email) })
	if status != 0 {
		writeJSON(w, status, body)
		return
	}
	err := send(email, "Noop 登录验证码："+code,
		"你的 Noop 登录验证码是：\n\n    "+code+"\n\n10 分钟内有效。\n\n如果不是你本人操作，请忽略这封邮件。\n")
	if err != nil { // mail goes out without the lock held
		h.cfg.Logf("auth mail failed: %v", err)
		h.locked(func() { h.must(h.db.Exec("DELETE FROM auth_codes WHERE email = ?", email)) })
		errJSON(w, 502, "验证码邮件发送失败，请稍后再试")
		return
	}
	writeJSON(w, 200, obj{"ok": true})
}

// issueCode records a new sign-in code. status 0: mail `code` with `send`; otherwise answer status/body.
func (h *Hub) issueCode(email string) (int, any, string, func(to, subject, text string) error) {
	owners := h.owners()
	// only the allow-list may sign in: anyone else is told so at once, with no code, no mail and no row written
	if len(owners) > 0 && !h.ownerOk(email) {
		return 403, obj{"error": "这个邮箱不允许登录"}, "", nil
	}
	if h.totp() == nil {
		return 403, obj{"error": "totp_not_setup", "message": totpMissingMsg}, "", nil
	}
	send := h.sendMail
	cli := send == nil // no mail: the code is shown on the owner's own machine (`noop login`)
	now := h.nowMs()
	h.must(h.db.Exec("DELETE FROM auth_sends WHERE ts < ?", now-time.Hour.Milliseconds()))
	if h.count("SELECT COUNT(*) FROM auth_sends WHERE email = ? AND ts > ?", email, now-resendEvery.Milliseconds()) > 0 {
		return 429, obj{"error": "请稍等一分钟再重新获取验证码"}, "", nil
	}
	if h.count("SELECT COUNT(*) FROM auth_sends WHERE sent = 1") >= sendsPerHour {
		return 429, obj{"error": "验证码发送太频繁，请一小时后再试"}, "", nil
	}
	isOwner := h.ownerOk(email) && (len(owners) > 0 || cli)
	sent := 0
	if isOwner {
		sent = 1
	}
	h.must(h.db.Exec("INSERT INTO auth_sends (email, ts, sent) VALUES (?, ?, ?)", email, now, sent))
	if !isOwner { // no allow-list and mail set up: nobody is the owner
		return 403, obj{"error": "这个邮箱不允许登录"}, "", nil
	}
	code := newCode()
	h.must(h.db.Exec("INSERT OR REPLACE INTO auth_codes (email, hash, expires, attempts) VALUES (?, ?, ?, 0)",
		email, sha256hex([]byte(email+":"+code)), now+codeTTL.Milliseconds()))
	if cli {
		h.kvSet("cli_code", obj{"email": email, "code": code, "expires": now + codeTTL.Milliseconds()})
		return 200, obj{"ok": true, "delivery": "cli"}, "", nil
	}
	return 0, nil, code, send
}

// checkCode: the emailed code AND the authenticator's TOTP. Returns the email, or a status and message.
func (h *Hub) checkCode(rawEmail, rawCode, rawTotp string, r *http.Request, via string) (string, int, string) {
	email, code, totpCode := normEmail(rawEmail), normCode(rawCode), strings.Join(strings.Fields(rawTotp), "")
	tf := h.totp()
	if tf == nil {
		return "", 403, totpMissingMsg
	}
	if !validEmail(email) || !codeRE.MatchString(code) || !sixDigits.MatchString(totpCode) {
		return "", 400, "请填写邮箱验证码和两步验证码"
	}
	var hash string
	var expires, attempts int64
	if err := h.db.QueryRow("SELECT hash, expires, attempts FROM auth_codes WHERE email = ?", email).Scan(&hash, &expires, &attempts); err != nil || expires < h.nowMs() {
		return "", 401, "验证码无效或已过期，请重新获取"
	}
	if attempts >= codeTries {
		return "", 401, "尝试次数太多，请重新获取验证码"
	}
	day := h.now().UTC().Format("2006-01-02")
	var fails struct {
		Day string `json:"day"`
		N   int    `json:"n"`
	}
	failed := 0
	if h.kvGet("auth_fails", &fails) && fails.Day == day {
		failed = fails.N
	}
	if failed >= failsPerDay {
		return "", 429, "今天验证失败次数太多，已锁定到 UTC 0 点"
	}
	h.must(h.db.Exec("UPDATE auth_codes SET attempts = attempts + 1 WHERE email = ?", email))
	fail := func(msg string) (string, int, string) {
		h.kvSet("auth_fails", obj{"day": day, "n": failed + 1})
		if failed+1 >= failsPerDay {
			h.must(h.db.Exec("DELETE FROM auth_codes"))
			h.alert("登录已锁定", append(append([]string{fmt.Sprintf("今天验证已经错了 %d 次，到 UTC 0 点前任何人都无法登录。", failsPerDay)}, h.origin(r)...),
				"", "如果不是你本人在试：有人在猜你的验证码。已有的登录不受影响。"))
		}
		return "", 401, msg
	}
	if !sameStr(sha256hex([]byte(email+":"+code)), hash) {
		return fail("邮箱验证码不对")
	}
	after := int64(-1)
	if tf.Last != nil {
		after = *tf.Last
	}
	step := totpMatch(tf.Secret, totpCode, after, h.now())
	if step < 0 {
		h.alert("两步验证码错误", append(append([]string{"有人输对了 " + email + " 的邮箱验证码，但两步验证码不对。"}, h.origin(r)...),
			"", "如果不是你本人：你的邮箱可能已经被盗，请立即修改邮箱密码。"))
		return fail("两步验证码不对（或已用过），请看验证器 App 上的最新数字")
	}
	tf.Last = &step
	h.kvSet("totp", tf)
	h.must(h.db.Exec("DELETE FROM auth_codes WHERE email = ?", email))
	h.kvDel("cli_code")
	h.alert("新登录", append(append([]string{"账号：" + email, "方式：" + via}, h.origin(r)...),
		"", "如果是你本人，无需处理。",
		"如果不是你：在你的主机上运行 noop revoke-sessions，立即踢掉所有登录（手机、浏览器），再检查这个邮箱是否被盗。"))
	return email, 200, ""
}

func (h *Hub) newSession(email, ua string) string {
	session := randHex(32)
	now := h.nowMs()
	h.must(h.db.Exec("INSERT INTO sessions (id, email, created, last_seen, ua, scope) VALUES (?, ?, ?, ?, ?, 'owner')",
		sha256hex([]byte(session)), email, now, now, truncRunes(ua, 300)))
	return session
}

// origin: where a request came from, for an alert.
func (h *Hub) origin(r *http.Request) []string {
	loc := time.FixedZone("CST", 8*3600)
	ip := r.Header.Get("x-forwarded-for")
	if ip == "" {
		ip = r.RemoteAddr
	}
	ua := r.UserAgent()
	if ua == "" {
		ua = "未知"
	}
	return []string{"时间：" + h.now().In(loc).Format("2006/1/2 15:04:05") + "（北京时间）", "IP：" + ip, "设备：" + truncRunes(ua, 200)}
}

// alert: a security event, put in the feed and mailed to every owner. Never blocks or fails the request.
func (h *Hub) alert(title string, lines []string) {
	kept := make([]string, 0, len(lines))
	for _, l := range lines {
		if l != "" {
			kept = append(kept, l)
		}
	}
	h.appendEvent(obj{"from": "hub", "kind": "notice", "text": "🔐 " + title + "\n" + strings.Join(kept, "\n")})
	send := h.sendMail
	if send == nil {
		return
	}
	text := "Noop 安全提醒：" + title + "\n\n" + strings.Join(lines, "\n") + "\n"
	for _, to := range h.owners() {
		go func(to string) {
			if err := send(to, "Noop 安全提醒："+title, text); err != nil {
				h.cfg.Logf("alert mail to %s: %v", to, err)
			}
		}(to)
	}
}

// twoFactor: binding the authenticator, from a machine only (the machine key is the root of trust).
//
//	GET /api/host/2fa → {bound, since} · POST /api/host/2fa/setup → {secret, uri}
//	POST /api/host/2fa/confirm {totp} → binds the pending secret once a code from the app matches it
func (h *Hub) twoFactor(w http.ResponseWriter, q *request) {
	if !q.who.machine {
		errJSON(w, 403, "forbidden")
		return
	}
	host := q.r.Header.Get("x-noop-host")
	if host == "" {
		host = "持有机器密钥的主机"
	}
	p, m := q.r.URL.Path, q.r.Method
	switch {
	case p == "/api/host/2fa" && m == "GET":
		t := h.totp()
		var since any
		if t != nil && t.Bound != nil {
			since = *t.Bound
		}
		writeJSON(w, 200, obj{"bound": t != nil, "since": since, "allow_ips": nil})
	case p == "/api/host/2fa/setup" && m == "POST":
		secret := newTOTPSecret()
		h.kvSet("totp_pending", obj{"secret": secret, "expires": h.nowMs() + 10*time.Minute.Milliseconds()})
		account := "owner"
		if o := h.owners(); len(o) > 0 {
			account = o[0]
		}
		writeJSON(w, 200, obj{"secret": secret, "uri": otpauthURI(secret, account)})
	case p == "/api/host/2fa/confirm" && m == "POST":
		var b struct {
			TOTP string `json:"totp"`
		}
		_ = q.json(&b)
		var pend struct {
			Secret  string `json:"secret"`
			Expires int64  `json:"expires"`
		}
		if !h.kvGet("totp_pending", &pend) || pend.Secret == "" || pend.Expires < h.nowMs() {
			errJSON(w, 400, "没有待确认的绑定（10 分钟内有效），重新运行 noop 2fa setup")
			return
		}
		step := totpMatch(pend.Secret, b.TOTP, -1, h.now())
		if step < 0 {
			errJSON(w, 400, "两步验证码不对：确认手机时间准确，输入验证器 App 上的最新数字")
			return
		}
		was := h.totp() != nil
		bound := h.nowMs()
		h.kvSet("totp", totpState{Secret: pend.Secret, Last: &step, Bound: &bound})
		h.kvDel("totp_pending")
		title, note := "两步验证已开启", "从现在起，登录需要邮箱验证码 + 验证器 App 上的两步验证码。"
		if was {
			title, note = "两步验证已换绑", "旧的验证器从现在起失效。如果不是你本人操作：有人拿到了你的机器密钥，立即检查你的主机。"
		}
		h.alert(title, []string{"操作方：" + host, "时间：" + h.now().In(time.FixedZone("CST", 8*3600)).Format("2006/1/2 15:04:05") + "（北京时间）", "", note})
		writeJSON(w, 200, obj{"ok": true, "replaced": was})
	default:
		errJSON(w, 404, "not found")
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func truncRunes(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

func atoiDefault(s string, d int) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return d
	}
	return n
}
