package hub

import (
	"net"
	"net/http"
	"strings"
	"time"
)

// The workspace (one per server: this server is the team) and joining it by asking.
//
// Besides an admin's invite link, a person can ask to join: they fill in name, @handle and email on the sign-in
// screen and their device keeps a secret token. An admin approves (the account is made then) or rejects it, from
// 待你决定 or 成员与邀请. The device that asked trades its token for a session once, after the approval. Admins can
// turn asking off (PATCH /api/v1/workspace {signup: false}); invites keep working either way.

const (
	signupsPerIPDay = 5  // applications one address may send in a day
	signupsPending  = 30 // open applications at most; the rest wait until an admin clears some
	signupNoteChars = 200
)

const signupSchema = `
CREATE TABLE IF NOT EXISTS signups (id TEXT PRIMARY KEY, hash TEXT UNIQUE, email TEXT NOT NULL, handle TEXT NOT NULL, name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '', state TEXT NOT NULL, created INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER, user_id TEXT);
CREATE INDEX IF NOT EXISTS signups_state ON signups (state, created);
`

// ---------------------------------------------------------------- the workspace

type workspace struct {
	ID     string `json:"id"`
	Name   string `json:"name"`   // "" = unnamed (the app shows Remi)
	Signup bool   `json:"signup"` // people may ask to join
}

// workspace: this server's team, made on first use (a stable id, asking to join on). Call with h.mu held.
func (h *Hub) workspace() workspace {
	var ws workspace
	if !h.kvGet("workspace", &ws) || ws.ID == "" {
		ws = workspace{ID: newID("w_"), Signup: true}
		h.kvSet("workspace", ws)
	}
	return ws
}

func (h *Hub) v1Workspace(w http.ResponseWriter, q *request) {
	writeJSON(w, 200, h.workspace())
}

// v1WorkspacePatch: an admin renames the team or turns asking to join on or off.
func (h *Hub) v1WorkspacePatch(w http.ResponseWriter, q *request) {
	if !h.isAdmin(q.who.userID) {
		errJSON(w, 403, "只有管理员能改团队设置")
		return
	}
	var b struct {
		Name   *string `json:"name"`
		Signup *bool   `json:"signup"`
	}
	_ = q.json(&b)
	ws := h.workspace()
	if b.Name != nil {
		ws.Name = trimmed(*b.Name, 60)
	}
	if b.Signup != nil {
		ws.Signup = *b.Signup
	}
	h.kvSet("workspace", ws)
	h.broadcastPeople(obj{"type": "workspace", "workspace": ws})
	writeJSON(w, 200, ws)
}

// ---------------------------------------------------------------- asking to join

type signupView struct {
	ID      string `json:"id"`
	Email   string `json:"email"`
	Handle  string `json:"handle"`
	Name    string `json:"name"`
	Note    string `json:"note"`
	State   string `json:"state"` // pending | approved | rejected
	Created int64  `json:"created"`
}

const signupCols = "id, email, handle, name, note, state, created"

func (h *Hub) pendingSignups() []signupView {
	rows, err := h.db.Query("SELECT " + signupCols + " FROM signups WHERE state = 'pending' ORDER BY created")
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []signupView{}
	for rows.Next() {
		var s signupView
		if err := rows.Scan(&s.ID, &s.Email, &s.Handle, &s.Name, &s.Note, &s.State, &s.Created); err != nil {
			panic(err)
		}
		out = append(out, s)
	}
	return out
}

func clientIP(r *http.Request) string {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// v1SignupCreate: {email, name, handle, note?} → {id, token, state}. The token is the asking device's only way in
// once an admin approves; only its hash is kept. One open application per email: asking again replaces it.
func (h *Hub) v1SignupCreate(w http.ResponseWriter, q *request) {
	if !h.workspace().Signup {
		errJSON(w, 403, "这个团队没有开放申请加入，请找管理员要邀请链接")
		return
	}
	var b struct{ Email, Name, Handle, Note string }
	_ = q.json(&b)
	email, name, handle := normEmail(b.Email), trimmed(b.Name, 60), strings.ToLower(strings.TrimSpace(b.Handle))
	if !validEmail(email) {
		errJSON(w, 400, "邮箱格式不对")
		return
	}
	if name == "" || !handleRE.MatchString(handle) {
		errJSON(w, 400, "请填写名字，以及 2 到 32 位的 @名（小写字母开头，可含数字、- 和 _）")
		return
	}
	now := h.nowMs()
	key := "signup:" + clientIP(q.r)
	h.must(h.db.Exec("DELETE FROM login_fails WHERE ts < ?", now-24*time.Hour.Milliseconds()))
	if h.count("SELECT COUNT(*) FROM login_fails WHERE email = ?", key) >= signupsPerIPDay {
		errJSON(w, 429, "这台设备今天提交的申请太多了，明天再试")
		return
	}
	if h.count("SELECT COUNT(*) FROM users WHERE email = ?", email) > 0 {
		errJSON(w, 409, "这个邮箱已经是成员了，请用登录码登录")
		return
	}
	if h.handleTaken(handle) || h.count("SELECT COUNT(*) FROM signups WHERE state = 'pending' AND handle = ? AND email != ?", handle, email) > 0 {
		errJSON(w, 409, "@"+handle+" 已经被占用了")
		return
	}
	h.must(h.db.Exec("DELETE FROM signups WHERE state = 'pending' AND email = ?", email))
	if h.count("SELECT COUNT(*) FROM signups WHERE state = 'pending'") >= signupsPending {
		errJSON(w, 429, "待审批的申请太多了，请先联系管理员")
		return
	}
	h.must(h.db.Exec("INSERT INTO login_fails (email, ts) VALUES (?, ?)", key, now)) // counts toward the address's daily limit
	id, token := newID("s_"), "tsu_"+randHex(24)
	h.must(h.db.Exec("INSERT INTO signups (id, hash, email, handle, name, note, state, created) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
		id, sha256hex([]byte(token)), email, handle, name, trimmed(b.Note, signupNoteChars), now))
	h.broadcastPeople(obj{"type": "signup"})
	writeJSON(w, 201, obj{"id": id, "token": token, "state": "pending"})
}

// v1SignupStatus: what became of the application this token belongs to. An approved one that was not yet
// traded for a session says "approved"; once traded the token is gone (404).
func (h *Hub) v1SignupStatus(w http.ResponseWriter, q *request) {
	var s signupView
	err := h.db.QueryRow("SELECT "+signupCols+" FROM signups WHERE hash = ?", sha256hex([]byte(q.r.PathValue("token")))).
		Scan(&s.ID, &s.Email, &s.Handle, &s.Name, &s.Note, &s.State, &s.Created)
	if err != nil {
		errJSON(w, 404, "找不到这个申请，可能已被替换或已经用过")
		return
	}
	writeJSON(w, 200, obj{"state": s.State, "email": s.Email, "handle": s.Handle, "name": s.Name})
}

// v1SignupSession: the asking device's token → {session, user}, once, after an admin approved.
func (h *Hub) v1SignupSession(w http.ResponseWriter, q *request) {
	hash := sha256hex([]byte(q.r.PathValue("token")))
	var state string
	var userID *string
	if err := h.db.QueryRow("SELECT state, user_id FROM signups WHERE hash = ?", hash).Scan(&state, &userID); err != nil {
		errJSON(w, 404, "找不到这个申请，可能已被替换或已经用过")
		return
	}
	if state != "approved" || userID == nil {
		errJSON(w, 409, map[string]string{"pending": "还在等管理员审批", "rejected": "管理员没有通过这个申请"}[state])
		return
	}
	u, ok := h.user(*userID)
	if !ok || u.Disabled {
		errJSON(w, 403, "这个账号已被停用")
		return
	}
	h.must(h.db.Exec("UPDATE signups SET hash = NULL WHERE hash = ?", hash))
	writeJSON(w, 200, obj{"session": h.userSession(u, q.r.UserAgent()), "user": u})
}

func (h *Hub) v1Signups(w http.ResponseWriter, q *request) {
	if !h.isAdmin(q.who.userID) {
		errJSON(w, 403, "只有管理员能审批加入申请")
		return
	}
	writeJSON(w, 200, obj{"signups": h.pendingSignups()})
}

// v1SignupDecide: an admin approves ({role?}: the account is made now, as a member unless said otherwise) or rejects.
func (h *Hub) v1SignupDecide(approve bool) func(http.ResponseWriter, *request) {
	return func(w http.ResponseWriter, q *request) {
		if !h.isAdmin(q.who.userID) {
			errJSON(w, 403, "只有管理员能审批加入申请")
			return
		}
		var s signupView
		err := h.db.QueryRow("SELECT "+signupCols+" FROM signups WHERE id = ?", q.r.PathValue("id")).
			Scan(&s.ID, &s.Email, &s.Handle, &s.Name, &s.Note, &s.State, &s.Created)
		if err != nil {
			errJSON(w, 404, "not found")
			return
		}
		if s.State != "pending" {
			errJSON(w, 409, "这个申请已经处理过了")
			return
		}
		now := h.nowMs()
		if !approve {
			h.must(h.db.Exec("UPDATE signups SET state = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?", q.who.userID, now, s.ID))
			h.broadcastPeople(obj{"type": "signup"})
			writeJSON(w, 200, obj{"ok": true})
			return
		}
		var b struct{ Role string }
		_ = q.json(&b)
		if b.Role == "" {
			b.Role = "member"
		}
		if b.Role != "admin" && b.Role != "member" {
			errJSON(w, 400, "role 只能是 admin 或 member")
			return
		}
		if h.count("SELECT COUNT(*) FROM users WHERE email = ?", s.Email) > 0 {
			errJSON(w, 409, "这个邮箱已经是成员了")
			return
		}
		if h.handleTaken(s.Handle) {
			errJSON(w, 409, "@"+s.Handle+" 已经被占用了，请让对方换个 @名重新申请")
			return
		}
		id := newID("u_")
		h.must(h.db.Exec("INSERT INTO users (id, email, handle, name, role, totp_secret, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
			id, s.Email, s.Handle, s.Name, b.Role, newTOTPSecret(), now))
		h.must(h.db.Exec("UPDATE signups SET state = 'approved', decided_by = ?, decided_at = ?, user_id = ? WHERE id = ?", q.who.userID, now, id, s.ID))
		u, _ := h.user(id)
		h.broadcastPeople(obj{"type": "user", "user": u})
		h.broadcastPeople(obj{"type": "signup"})
		writeJSON(w, 200, obj{"user": u})
	}
}
