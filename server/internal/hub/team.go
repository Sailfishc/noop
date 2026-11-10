package hub

import (
	"database/sql"
	"encoding/json"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// People, invites and sign-in, machines and agents.
//
// There is no password and no mail. An admin invites a person (or `remi-server invite` does, for the first
// admin) and the invite link signs them in; or a person asks to join and an admin approves (teamsignup.go). Another device signs in with a one-time login code made on a device
// that is already signed in, or with a login link an admin makes. Accounts from before keep email + authenticator.

const (
	inviteTTL         = 7 * 24 * time.Hour
	loginFailsPerDay  = 10
	loginCodeTTL      = 15 * time.Minute
	adminLoginCodeTTL = 24 * time.Hour
	machineOnlineSpan = 3 * time.Minute
	memoryChars       = 8000
)

var (
	handleRE   = regexp.MustCompile(`^[a-z][a-z0-9_-]{1,31}$`)
	dispatches = map[string]bool{"owner": true, "channel": true, "team": true}   // 只有我 · 所在频道的成员 · 整个团队
	autonomies = map[string]bool{"cautious": true, "assist": true, "auto": true} // 谨慎 · 协助 · 自主
	runtimes   = map[string]bool{"codex": true, "claude": true, "pi": true}
	modelRE    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$`)
)

func newID(prefix string) string { return prefix + randHex(8) }

// ---------------------------------------------------------------- shapes

type userView struct {
	ID       string `json:"id"`
	Email    string `json:"email"`
	Handle   string `json:"handle"`
	Name     string `json:"name"`
	Role     string `json:"role"`
	Disabled bool   `json:"disabled"`
}

const userCols = "id, email, handle, name, role, disabled"

func scanUser(s interface{ Scan(...any) error }) (userView, error) {
	var u userView
	err := s.Scan(&u.ID, &u.Email, &u.Handle, &u.Name, &u.Role, &u.Disabled)
	return u, err
}

func (h *Hub) user(id string) (userView, bool) {
	u, err := scanUser(h.db.QueryRow("SELECT "+userCols+" FROM users WHERE id = ?", id))
	return u, err == nil
}

type machineView struct {
	ID          string   `json:"id"`
	OwnerID     string   `json:"owner_id"`
	Name        string   `json:"name"`
	OS          string   `json:"os"`
	Arch        string   `json:"arch"`
	Runtimes    []string `json:"runtimes"`
	MaxSessions int      `json:"max_sessions"`
	Online      bool     `json:"online"`
	LastSeen    *int64   `json:"last_seen"`
	machineInfo
}

// machineInfo: what the daemon found on its machine, for people to see before they pick a machine and a runtime.
// Never a secret: a Git credential is only "configured", and as whom.
type machineInfo struct {
	RuntimeInfo []runtimeInfo `json:"runtime_info"`
	Git         []gitCred     `json:"git"`
	Repos       []repoRef     `json:"repos"` // the remotes of the checkouts it has (never their paths)
}

type runtimeInfo struct {
	Name      string   `json:"name"`
	Version   string   `json:"version"`
	Installed bool     `json:"installed"`
	LoggedIn  *bool    `json:"logged_in"` // nil: unknown
	Models    []string `json:"models"`    // what its owner can pick for an agent (besides the runtime's default)
}

type gitCred struct {
	Provider   string `json:"provider"` // github | gitlab
	Host       string `json:"host"`
	Configured bool   `json:"configured"`
	User       string `json:"user"`
	Via        string `json:"via"` // token | gh
}

const machineCols = "id, owner_id, name, COALESCE(os, ''), COALESCE(arch, ''), COALESCE(runtimes, '[]'), max_sessions, last_seen, COALESCE(info, '{}')"

func (h *Hub) scanMachines(rows *sql.Rows, err error) []machineView {
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []machineView{}
	for rows.Next() {
		var m machineView
		var rt, info string
		if err := rows.Scan(&m.ID, &m.OwnerID, &m.Name, &m.OS, &m.Arch, &rt, &m.MaxSessions, &m.LastSeen, &info); err != nil {
			panic(err)
		}
		_ = json.Unmarshal([]byte(rt), &m.Runtimes)
		_ = json.Unmarshal([]byte(info), &m.machineInfo)
		if m.RuntimeInfo == nil { // a daemon from before: what it listed is installed, login unknown
			for _, r := range m.Runtimes {
				m.RuntimeInfo = append(m.RuntimeInfo, runtimeInfo{Name: r, Installed: true})
			}
		}
		if m.RuntimeInfo == nil {
			m.RuntimeInfo = []runtimeInfo{}
		}
		if m.Git == nil {
			m.Git = []gitCred{}
		}
		if m.Repos == nil {
			m.Repos = []repoRef{}
		}
		if m.Runtimes == nil {
			m.Runtimes = []string{}
		}
		m.Online = h.socks.count("m:"+m.ID) > 0 || (m.LastSeen != nil && h.nowMs()-*m.LastSeen < machineOnlineSpan.Milliseconds())
		out = append(out, m)
	}
	return out
}

type agentView struct {
	ID          string  `json:"id"`
	OwnerID     string  `json:"owner_id"`
	MachineID   *string `json:"machine_id"`
	Handle      string  `json:"handle"`
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Runtime     string  `json:"runtime"`
	// Dispatch: who may hand it work: owner (只有我), channel (members of a channel it is in), team (anyone; an
	// @mention in a channel it is not in brings it there). Confirm: work from people other than the owner waits for
	// the owner's yes.
	Dispatch string `json:"dispatch"`
	Confirm  bool   `json:"confirm"`
	Autonomy string `json:"autonomy"`
	// Model: the runtime's model to use ("" = the runtime's default).
	Model string `json:"model"`
	// Repo: a local checkout on its machine for tasks that name no repository (older setups); "" for none. A task's
	// own repository (teamrepos.go) comes first.
	Repo string `json:"repo"`
	// Memory: its memory.md, what it keeps between tasks. Its owner edits it; the agent rewrites it when it learns
	// something lasting.
	Memory string `json:"memory"`
	// Paused: why it takes no work now (its runtime is logged out, out of credit); nil = it does (teamhealth.go)
	Paused *pauseView `json:"paused"`
}

const agentCols = "id, owner_id, machine_id, handle, name, description, runtime, dispatch, confirm, autonomy, model, repo, memory, paused"

func scanAgents(rows *sql.Rows, err error) []agentView {
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []agentView{}
	for rows.Next() {
		var a agentView
		var paused string
		if err := rows.Scan(&a.ID, &a.OwnerID, &a.MachineID, &a.Handle, &a.Name, &a.Description, &a.Runtime, &a.Dispatch, &a.Confirm, &a.Autonomy, &a.Model, &a.Repo, &a.Memory, &paused); err != nil {
			panic(err)
		}
		if paused != "" {
			a.Paused = &pauseView{}
			_ = json.Unmarshal([]byte(paused), a.Paused)
		}
		out = append(out, a)
	}
	return out
}

func (h *Hub) agent(id string) (agentView, bool) {
	a := scanAgents(h.db.Query("SELECT "+agentCols+" FROM agents WHERE id = ?", id))
	if len(a) == 0 {
		return agentView{}, false
	}
	return a[0], true
}

// handleTaken: people and agents share one @namespace.
func (h *Hub) handleTaken(handle string) bool {
	return h.count("SELECT (SELECT COUNT(*) FROM users WHERE handle = ?) + (SELECT COUNT(*) FROM agents WHERE handle = ?)", handle, handle) > 0
}

func (h *Hub) isAdmin(userID string) bool {
	return h.count("SELECT COUNT(*) FROM users WHERE id = ? AND role = 'admin' AND disabled = 0", userID) == 1
}

// ---------------------------------------------------------------- invites and sign-in

// CreateInvite makes a one-time invite and returns its code (only its hash is stored).
func (h *Hub) CreateInvite(email, role, by string) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.createInvite(email, role, by)
}

type httpError struct {
	status int
	msg    string
}

func (e httpError) Error() string { return e.msg }

func (h *Hub) createInvite(email, role, by string) (string, error) {
	email = normEmail(email)
	if !validEmail(email) {
		return "", httpError{400, "邮箱格式不对"}
	}
	if role != "admin" && role != "member" {
		return "", httpError{400, "role 只能是 admin 或 member"}
	}
	if h.count("SELECT COUNT(*) FROM users WHERE email = ?", email) > 0 {
		return "", httpError{409, "这个邮箱已经是成员了"}
	}
	code := randHex(16)
	now := h.nowMs()
	var creator any
	if by != "" {
		creator = by
	}
	h.must(h.db.Exec("INSERT INTO invites (hash, email, role, created_by, created, expires) VALUES (?, ?, ?, ?, ?, ?)",
		sha256hex([]byte(code)), email, role, creator, now, now+inviteTTL.Milliseconds()))
	return code, nil
}

func (h *Hub) v1InviteCreate(w http.ResponseWriter, q *request) {
	if !h.isAdmin(q.who.userID) {
		errJSON(w, 403, "只有管理员能邀请成员")
		return
	}
	var b struct{ Email, Role string }
	_ = q.json(&b)
	if b.Role == "" {
		b.Role = "member"
	}
	code, err := h.createInvite(b.Email, b.Role, q.who.userID)
	if err != nil {
		e := err.(httpError)
		errJSON(w, e.status, e.msg)
		return
	}
	writeJSON(w, 200, obj{"code": code, "path": "/invite/" + code, "expires": h.nowMs() + inviteTTL.Milliseconds()})
}

type invite struct {
	email, role string
	pending     *string
}

func (h *Hub) liveInvite(code string) (invite, bool) {
	var iv invite
	err := h.db.QueryRow("SELECT email, role, pending_secret FROM invites WHERE hash = ? AND used_by IS NULL AND expires > ?",
		sha256hex([]byte(code)), h.nowMs()).Scan(&iv.email, &iv.role, &iv.pending)
	return iv, err == nil
}

func (h *Hub) v1InviteInfo(w http.ResponseWriter, q *request) {
	iv, ok := h.liveInvite(q.r.PathValue("code"))
	if !ok {
		errJSON(w, 404, "邀请链接无效或已过期")
		return
	}
	writeJSON(w, 200, obj{"email": iv.email, "role": iv.role})
}

// v1InviteAccept: {name, handle} → the account exists and {session, user} signs it in. The invite link is the
// credential: it is one-time, expires in a week and only reaches the person it was sent to.
func (h *Hub) v1InviteAccept(w http.ResponseWriter, q *request) {
	code := q.r.PathValue("code")
	iv, ok := h.liveInvite(code)
	if !ok {
		errJSON(w, 404, "邀请链接无效或已过期")
		return
	}
	var b struct{ Name, Handle string }
	_ = q.json(&b)
	name, handle := trimmed(b.Name, 60), strings.ToLower(strings.TrimSpace(b.Handle))
	if name == "" || !handleRE.MatchString(handle) {
		errJSON(w, 400, "请填写名字，以及 2 到 32 位的 @名（小写字母开头，可含数字、- 和 _）")
		return
	}
	if h.handleTaken(handle) {
		errJSON(w, 409, "@"+handle+" 已经被占用了")
		return
	}
	id := newID("u_")
	// totp_secret stays for accounts made before login codes; a new one is never shown, so it can't sign in
	h.must(h.db.Exec("INSERT INTO users (id, email, handle, name, role, totp_secret, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
		id, iv.email, handle, name, iv.role, newTOTPSecret(), h.nowMs()))
	h.must(h.db.Exec("UPDATE invites SET used_by = ?, used_at = ?, pending_secret = NULL WHERE hash = ?", id, h.nowMs(), sha256hex([]byte(code))))
	u, _ := h.user(id)
	h.broadcastPeople(obj{"type": "user", "user": u})
	writeJSON(w, 200, obj{"session": h.userSession(u, q.r.UserAgent()), "user": u})
}

// Login codes (newCode, normCode in auth.go) sign a person in on another device: one-time and short-lived.
func loginCodeOf(s string) string {
	if i := strings.LastIndex(s, "/login/"); i >= 0 { // a pasted …/login/ABCD-EFGH link
		s = s[i+len("/login/"):]
	}
	return normCode(strings.TrimSpace(s))
}

// v1LoginCodeCreate: a person makes a code for themselves (valid 15 minutes, to type on their other device); an
// admin makes one for a member who lost their device ({user_id}, valid a day, to send them as a link).
func (h *Hub) v1LoginCodeCreate(w http.ResponseWriter, q *request) {
	var b struct {
		UserID string `json:"user_id"`
	}
	_ = q.json(&b)
	ttl := loginCodeTTL
	target := q.who.userID
	if b.UserID != "" && b.UserID != q.who.userID {
		if !h.isAdmin(q.who.userID) {
			errJSON(w, 403, "只有管理员能给别人生成登录链接")
			return
		}
		if h.count("SELECT COUNT(*) FROM users WHERE id = ? AND disabled = 0", b.UserID) != 1 {
			errJSON(w, 404, "没有这个成员，或者已被停用")
			return
		}
		target, ttl = b.UserID, adminLoginCodeTTL
	}
	raw := newCode()
	code := raw[:4] + "-" + raw[4:]
	now := h.nowMs()
	h.must(h.db.Exec("DELETE FROM login_codes WHERE expires <= ?", now))
	h.must(h.db.Exec("INSERT INTO login_codes (hash, user_id, created, expires) VALUES (?, ?, ?, ?)",
		sha256hex([]byte(raw)), target, now, now+ttl.Milliseconds()))
	writeJSON(w, 200, obj{"code": code, "path": "/login/" + code, "expires": now + ttl.Milliseconds()})
}

func (h *Hub) loginWithCode(w http.ResponseWriter, q *request, code string) {
	now := h.nowMs()
	ip := q.r.RemoteAddr
	if host, _, err := net.SplitHostPort(ip); err == nil {
		ip = host
	}
	key := "code:" + ip
	h.must(h.db.Exec("DELETE FROM login_fails WHERE ts < ?", now-24*time.Hour.Milliseconds()))
	if h.count("SELECT COUNT(*) FROM login_fails WHERE email = ?", key) >= loginFailsPerDay {
		errJSON(w, 429, "这台设备今天输错登录码太多次，24 小时内无法用登录码登录")
		return
	}
	hash := sha256hex([]byte(loginCodeOf(code)))
	var id string
	err := h.db.QueryRow("SELECT c.user_id FROM login_codes c JOIN users u ON u.id = c.user_id WHERE c.hash = ? AND c.expires > ? AND u.disabled = 0",
		hash, now).Scan(&id)
	if err != nil {
		h.must(h.db.Exec("INSERT INTO login_fails (email, ts) VALUES (?, ?)", key, now))
		errJSON(w, 401, "登录码不对或已过期（每个登录码只能用一次）")
		return
	}
	h.must(h.db.Exec("DELETE FROM login_codes WHERE hash = ?", hash))
	u, _ := h.user(id)
	writeJSON(w, 200, obj{"session": h.userSession(u, q.r.UserAgent()), "user": u})
}

func (h *Hub) userSession(u userView, ua string) string {
	session := randHex(32)
	now := h.nowMs()
	h.must(h.db.Exec("INSERT INTO sessions (id, email, created, last_seen, ua, scope, user_id) VALUES (?, ?, ?, ?, ?, 'owner', ?)",
		sha256hex([]byte(session)), u.Email, now, now, truncRunes(ua, 300), u.ID))
	return session
}

func (h *Hub) v1Login(w http.ResponseWriter, q *request) {
	var b struct{ Email, TOTP, Code string }
	_ = q.json(&b)
	if b.Code != "" {
		h.loginWithCode(w, q, b.Code)
		return
	}
	email := normEmail(b.Email)
	now := h.nowMs()
	h.must(h.db.Exec("DELETE FROM login_fails WHERE ts < ?", now-24*time.Hour.Milliseconds()))
	if h.count("SELECT COUNT(*) FROM login_fails WHERE email = ?", email) >= loginFailsPerDay {
		errJSON(w, 429, "这个邮箱今天验证失败次数太多，24 小时内无法登录")
		return
	}
	var id, secret string
	var last int64
	var disabled bool
	err := h.db.QueryRow("SELECT id, totp_secret, totp_last, disabled FROM users WHERE email = ?", email).Scan(&id, &secret, &last, &disabled)
	step := int64(-1)
	if err == nil && !disabled {
		step = totpMatch(secret, b.TOTP, last, h.now())
	}
	if step < 0 {
		h.must(h.db.Exec("INSERT INTO login_fails (email, ts) VALUES (?, ?)", email, now))
		errJSON(w, 401, "邮箱或验证码不对（每个验证码只能用一次）")
		return
	}
	h.must(h.db.Exec("UPDATE users SET totp_last = ? WHERE id = ?", step, id))
	u, _ := h.user(id)
	writeJSON(w, 200, obj{"session": h.userSession(u, q.r.UserAgent()), "user": u})
}

func (h *Hub) v1Logout(w http.ResponseWriter, q *request) {
	h.must(h.db.Exec("DELETE FROM sessions WHERE id = ?", q.who.session))
	writeJSON(w, 200, obj{"ok": true})
}

func (h *Hub) v1Me(w http.ResponseWriter, q *request) {
	u, _ := h.user(q.who.userID)
	out := obj{"user": u, "public_url": h.cfg.PublicURL, "workspace": h.workspace(),
		"machines": h.scanMachines(h.db.Query("SELECT "+machineCols+" FROM machines WHERE owner_id = ? ORDER BY created", u.ID)),
		"agents":   scanAgents(h.db.Query("SELECT "+agentCols+" FROM agents WHERE owner_id = ? ORDER BY created", u.ID))}
	if q.who.machineID != "" {
		ms := h.scanMachines(h.db.Query("SELECT "+machineCols+" FROM machines WHERE id = ?", q.who.machineID))
		out["machine"] = ms[0]
		out["agents"] = scanAgents(h.db.Query("SELECT "+agentCols+" FROM agents WHERE machine_id = ? ORDER BY created", q.who.machineID))
	}
	writeJSON(w, 200, out)
}

// ---------------------------------------------------------------- people

func (h *Hub) v1Users(w http.ResponseWriter, q *request) {
	rows, err := h.db.Query("SELECT " + userCols + " FROM users ORDER BY created")
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []userView{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			panic(err)
		}
		out = append(out, u)
	}
	writeJSON(w, 200, obj{"users": out})
}

// v1UserPatch: anyone renames themselves; an admin changes roles and disables people (never themselves).
func (h *Hub) v1UserPatch(w http.ResponseWriter, q *request) {
	id := q.r.PathValue("id")
	if _, ok := h.user(id); !ok {
		errJSON(w, 404, "not found")
		return
	}
	var b struct {
		Name     *string `json:"name"`
		Role     *string `json:"role"`
		Disabled *bool   `json:"disabled"`
	}
	_ = q.json(&b)
	self, admin := id == q.who.userID, h.isAdmin(q.who.userID)
	if (b.Name != nil && !self && !admin) || ((b.Role != nil || b.Disabled != nil) && (!admin || self)) {
		errJSON(w, 403, "forbidden")
		return
	}
	if b.Name != nil {
		if n := trimmed(*b.Name, 60); n != "" {
			h.must(h.db.Exec("UPDATE users SET name = ? WHERE id = ?", n, id))
		}
	}
	if b.Role != nil {
		if *b.Role != "admin" && *b.Role != "member" {
			errJSON(w, 400, "role 只能是 admin 或 member")
			return
		}
		h.must(h.db.Exec("UPDATE users SET role = ? WHERE id = ?", *b.Role, id))
	}
	if b.Disabled != nil {
		h.must(h.db.Exec("UPDATE users SET disabled = ? WHERE id = ?", *b.Disabled, id))
		if *b.Disabled { // signed out everywhere; their machines' tokens stop working with them
			h.must(h.db.Exec("DELETE FROM sessions WHERE user_id = ?", id))
		}
	}
	u, _ := h.user(id)
	h.broadcastPeople(obj{"type": "user", "user": u})
	writeJSON(w, 200, u)
}

// ---------------------------------------------------------------- machines

func (h *Hub) v1Machines(w http.ResponseWriter, q *request) {
	writeJSON(w, 200, obj{"machines": h.scanMachines(h.db.Query("SELECT " + machineCols + " FROM machines ORDER BY created"))})
}

// v1MachineCreate: a person adds a machine and gets its token once ([server] token in that machine's config.local.toml).
func (h *Hub) v1MachineCreate(w http.ResponseWriter, q *request) {
	var b struct{ Name string }
	_ = q.json(&b)
	name := trimmed(b.Name, 60)
	if name == "" {
		errJSON(w, 400, "name required")
		return
	}
	id, token := newID("m_"), machineTokenPrefix+randHex(32)
	h.must(h.db.Exec("INSERT INTO machines (id, owner_id, name, token_hash, created) VALUES (?, ?, ?, ?, ?)",
		id, q.who.userID, name, sha256hex([]byte(token)), h.nowMs()))
	m := h.scanMachines(h.db.Query("SELECT "+machineCols+" FROM machines WHERE id = ?", id))[0]
	writeJSON(w, 200, obj{"machine": m, "token": token, "join": h.newJoinCode(id)})
}

func (h *Hub) v1MachineDelete(w http.ResponseWriter, q *request) {
	id := q.r.PathValue("id")
	if !h.mayManageMachine(w, q, id) {
		return
	}
	h.must(h.db.Exec("DELETE FROM machines WHERE id = ?", id))
	h.must(h.db.Exec("UPDATE agents SET machine_id = NULL WHERE machine_id = ?", id))
	writeJSON(w, 200, obj{"ok": true})
}

// v1MachineReport: the daemon says what it is and what it can run; it gets back the agents it hosts.
func (h *Hub) v1MachineReport(w http.ResponseWriter, q *request) {
	var b struct {
		OS          string        `json:"os"`
		Arch        string        `json:"arch"`
		Runtimes    []string      `json:"runtimes"`
		MaxSessions int           `json:"max_sessions"`
		RuntimeInfo []runtimeInfo `json:"runtime_info"`
		Git         []gitCred     `json:"git"`
		Repos       []repoRef     `json:"repos"`
	}
	_ = q.json(&b)
	var info machineInfo
	for _, r := range b.RuntimeInfo {
		if runtimes[r.Name] && len(info.RuntimeInfo) < 8 {
			r.Version = trimmed(r.Version, 40)
			models := []string{}
			for _, m := range r.Models {
				if modelRE.MatchString(m) && len(models) < 100 {
					models = append(models, m)
				}
			}
			r.Models = models
			info.RuntimeInfo = append(info.RuntimeInfo, r)
		}
	}
	for _, g := range b.Git {
		if (g.Provider == "github" || g.Provider == "gitlab") && len(info.Git) < 16 {
			g.Host, g.User, g.Via = trimmed(strings.ToLower(g.Host), 100), trimmed(g.User, 60), trimmed(g.Via, 20)
			info.Git = append(info.Git, g)
		}
	}
	seen := map[string]bool{}
	for _, r := range b.Repos {
		if rem := normRemote(r.Remote); rem != "" && !seen[rem] && len(info.Repos) < 300 {
			seen[rem] = true
			info.Repos = append(info.Repos, repoRef{Remote: rem, Name: repoName(rem)})
		}
	}
	infoJSON, _ := json.Marshal(info)
	var rts []string
	for _, r := range b.Runtimes {
		if runtimes[r] {
			rts = append(rts, r)
		}
	}
	rt, _ := json.Marshal(rts)
	maxS := min(max(b.MaxSessions, 1), 16)
	if b.MaxSessions == 0 {
		maxS = 3
	}
	h.must(h.db.Exec("UPDATE machines SET os = ?, arch = ?, runtimes = ?, max_sessions = ?, last_seen = ?, info = ? WHERE id = ?",
		trimmed(b.OS, 40), trimmed(b.Arch, 40), string(rt), maxS, h.nowMs(), string(infoJSON), q.who.machineID))
	m := h.scanMachines(h.db.Query("SELECT "+machineCols+" FROM machines WHERE id = ?", q.who.machineID))[0]
	h.broadcastPeople(obj{"type": "machine", "machine": m})
	h.resumeAgents(q.who.machineID, info.RuntimeInfo)
	writeJSON(w, 200, obj{"machine": m, "agents": scanAgents(h.db.Query("SELECT "+agentCols+" FROM agents WHERE machine_id = ? ORDER BY created", q.who.machineID))})
}

// ---------------------------------------------------------------- agents

func (h *Hub) v1Agents(w http.ResponseWriter, q *request) {
	writeJSON(w, 200, obj{"agents": scanAgents(h.db.Query("SELECT " + agentCols + " FROM agents ORDER BY created"))})
}

type agentBody struct {
	Handle      *string `json:"handle"`
	Name        *string `json:"name"`
	Description *string `json:"description"`
	MachineID   *string `json:"machine_id"`
	Runtime     *string `json:"runtime"`
	Dispatch    *string `json:"dispatch"`
	Confirm     *bool   `json:"confirm"`
	Autonomy    *string `json:"autonomy"`
	Model       *string `json:"model"`
	Repo        *string `json:"repo"`
	Memory      *string `json:"memory"`
}

// apply validates the fields present and writes them to agent id.
func (h *Hub) applyAgent(id, owner string, b agentBody) *httpError {
	set := func(col string, v any) { h.must(h.db.Exec("UPDATE agents SET "+col+" = ? WHERE id = ?", v, id)) }
	if b.Name != nil {
		n := trimmed(*b.Name, 40)
		if n == "" {
			return &httpError{400, "name required"}
		}
		set("name", n)
	}
	if b.Description != nil {
		set("description", trimmed(*b.Description, 300))
	}
	if b.MachineID != nil {
		if *b.MachineID == "" {
			set("machine_id", nil)
		} else if h.count("SELECT COUNT(*) FROM machines WHERE id = ? AND owner_id = ?", *b.MachineID, owner) == 0 {
			return &httpError{400, "只能用你自己的机器"}
		} else {
			set("machine_id", *b.MachineID)
		}
	}
	if b.Runtime != nil {
		if !runtimes[*b.Runtime] {
			return &httpError{400, "runtime 只能是 codex、claude 或 pi"}
		}
		set("runtime", *b.Runtime)
	}
	if b.Dispatch != nil {
		if !dispatches[*b.Dispatch] {
			return &httpError{400, "dispatch 只能是 owner、channel 或 team"}
		}
		set("dispatch", *b.Dispatch)
	}
	if b.Confirm != nil {
		set("confirm", *b.Confirm)
	}
	if b.Model != nil {
		m := strings.TrimSpace(*b.Model)
		if m != "" && !modelRE.MatchString(m) {
			return &httpError{400, "模型名只能含字母、数字和 . _ : / @ + -"}
		}
		set("model", m)
	}
	if b.Repo != nil {
		set("repo", trimmed(*b.Repo, 300))
	}
	if b.Memory != nil {
		set("memory", clip(strings.TrimSpace(*b.Memory), memoryChars))
	}
	if b.Autonomy != nil {
		if !autonomies[*b.Autonomy] {
			return &httpError{400, "autonomy 只能是 cautious、assist 或 auto"}
		}
		set("autonomy", *b.Autonomy)
	}
	return nil
}

func (h *Hub) v1AgentCreate(w http.ResponseWriter, q *request) {
	var b agentBody
	_ = q.json(&b)
	handle := ""
	if b.Handle != nil {
		handle = strings.ToLower(strings.TrimSpace(*b.Handle))
	}
	if !handleRE.MatchString(handle) {
		errJSON(w, 400, "@名要 2 到 32 位，小写字母开头，可含数字、- 和 _")
		return
	}
	if h.handleTaken(handle) {
		errJSON(w, 409, "@"+handle+" 已经被占用了")
		return
	}
	if b.Name == nil {
		b.Name = &handle
	}
	id := newID("a_")
	h.must(h.db.Exec("INSERT INTO agents (id, owner_id, handle, name, created) VALUES (?, ?, ?, ?, ?)", id, q.who.userID, handle, handle, h.nowMs()))
	if e := h.applyAgent(id, q.who.userID, b); e != nil { // all fields or none (the lock hides the half-made row)
		h.must(h.db.Exec("DELETE FROM agents WHERE id = ?", id))
		errJSON(w, e.status, e.msg)
		return
	}
	a, _ := h.agent(id)
	h.broadcastPeople(obj{"type": "agent", "agent": a})
	writeJSON(w, 200, a)
}

func (h *Hub) v1AgentPatch(w http.ResponseWriter, q *request) {
	a, ok := h.agent(q.r.PathValue("id"))
	if !ok {
		errJSON(w, 404, "not found")
		return
	}
	if a.OwnerID != q.who.userID {
		errJSON(w, 403, "只有 Agent 的主人能改它的设置")
		return
	}
	var b agentBody
	_ = q.json(&b)
	if b.Handle != nil && *b.Handle != a.Handle {
		errJSON(w, 400, "@名创建后不能改")
		return
	}
	if e := h.applyAgent(a.ID, a.OwnerID, b); e != nil {
		errJSON(w, e.status, e.msg)
		return
	}
	a, _ = h.agent(a.ID)
	h.broadcastPeople(obj{"type": "agent", "agent": a})
	writeJSON(w, 200, a)
}

func (h *Hub) v1AgentDelete(w http.ResponseWriter, q *request) {
	a, ok := h.agent(q.r.PathValue("id"))
	if !ok {
		errJSON(w, 404, "not found")
		return
	}
	if a.OwnerID != q.who.userID && !h.isAdmin(q.who.userID) {
		errJSON(w, 403, "forbidden")
		return
	}
	h.must(h.db.Exec("DELETE FROM agents WHERE id = ?", a.ID))
	h.must(h.db.Exec("DELETE FROM channel_members WHERE kind = 'agent' AND member_id = ?", a.ID))
	h.broadcastPeople(obj{"type": "agent_removed", "id": a.ID})
	writeJSON(w, 200, obj{"ok": true})
}
