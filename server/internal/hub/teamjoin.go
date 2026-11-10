package hub

import (
	_ "embed"
	"net/http"
	"strings"
	"time"
)

// Adding a machine in one line. A person asks the app for a command and runs it on the computer:
//
//	curl -fsSL <server>/api/v1/install.sh | bash -s -- <server> <code>
//
// The computer reports in by itself, the way Raft's Computers do: the code stands for the person (te_, an hour,
// any number of computers), and joining makes the machine from the computer's own name, OS and CPU. Each computer
// keeps a random id in its data dir; joining again from the same one finds its record (its agents stay) and
// replaces the token. A machine's own code (tj_, once) reconnects that machine. The token never sits in a shell
// history or a chat.

const (
	joinPrefix   = "tj_"
	enrollPrefix = "te_"
	joinTTL      = time.Hour
)

//go:embed install.sh
var installScript []byte

func (h *Hub) newJoinCode(machineID string) string {
	code := joinPrefix + randHex(12)
	h.must(h.db.Exec("UPDATE machines SET join_hash = ?, join_expires = ? WHERE id = ?", sha256hex([]byte(code)), h.nowMs()+joinTTL.Milliseconds(), machineID))
	return code
}

// v1MachineEnroll: a person gets a command that adds their computers.
func (h *Hub) v1MachineEnroll(w http.ResponseWriter, q *request) {
	code := enrollPrefix + randHex(12)
	h.must(h.db.Exec("DELETE FROM enroll_codes WHERE expires < ?", h.nowMs()))
	h.must(h.db.Exec("INSERT INTO enroll_codes (hash, user_id, expires) VALUES (?, ?, ?)", sha256hex([]byte(code)), q.who.userID, h.nowMs()+joinTTL.Milliseconds()))
	writeJSON(w, 200, obj{"join": code, "expires": h.nowMs() + joinTTL.Milliseconds()})
}

// v1MachineJoinCode: its owner (or an admin) makes a command that reconnects one machine.
func (h *Hub) v1MachineJoinCode(w http.ResponseWriter, q *request) {
	id := q.r.PathValue("id")
	if !h.mayManageMachine(w, q, id) {
		return
	}
	writeJSON(w, 200, obj{"join": h.newJoinCode(id)})
}

// v1MachinePatch: its owner (or an admin) renames it; an admin makes it a team machine (or no longer one).
func (h *Hub) v1MachinePatch(w http.ResponseWriter, q *request) {
	id := q.r.PathValue("id")
	if !h.mayManageMachine(w, q, id) {
		return
	}
	var b struct {
		Name           *string `json:"name"`
		Team           *bool   `json:"team"`
		SyncTeamConfig *bool   `json:"sync_team_config"`
	}
	_ = q.json(&b)
	if b.Team != nil && !h.isAdmin(q.who.userID) {
		errJSON(w, 403, "只有管理员能把机器设成团队机器")
		return
	}
	if b.SyncTeamConfig != nil {
		var owner string
		_ = h.db.QueryRow("SELECT owner_id FROM machines WHERE id = ?", id).Scan(&owner)
		if owner != q.who.userID { // it runs the repository's commands on someone's own computer: theirs to say
			errJSON(w, 403, "只有机器的主人能决定要不要同步团队配置")
			return
		}
		h.must(h.db.Exec("UPDATE machines SET sync_team_config = ? WHERE id = ?", boolInt(*b.SyncTeamConfig), id))
	}
	if b.Name != nil {
		name := trimmed(*b.Name, 60)
		if name == "" {
			errJSON(w, 400, "name required")
			return
		}
		h.must(h.db.Exec("UPDATE machines SET name = ? WHERE id = ?", name, id))
	}
	if b.Team != nil {
		h.must(h.db.Exec("UPDATE machines SET team = ? WHERE id = ?", boolInt(*b.Team), id))
	}
	m := h.scanMachines(h.db.Query("SELECT "+machineCols+" FROM machines WHERE id = ?", id))[0]
	h.broadcastPeople(obj{"type": "machine", "machine": m})
	writeJSON(w, 200, obj{"machine": m})
}

func (h *Hub) mayManageMachine(w http.ResponseWriter, q *request, id string) bool {
	var owner string
	if h.db.QueryRow("SELECT owner_id FROM machines WHERE id = ?", id).Scan(&owner) != nil {
		errJSON(w, 404, "not found")
		return false
	}
	if owner != q.who.userID && !h.isAdmin(q.who.userID) {
		errJSON(w, 403, "forbidden")
		return false
	}
	return true
}

// v1MachineJoin: the install script trades a code for this computer's token.
func (h *Hub) v1MachineJoin(w http.ResponseWriter, q *request) {
	var b struct{ Code, Host, OS, Arch, Key string }
	_ = q.json(&b)
	code := strings.TrimSpace(b.Code)
	key := ""
	if k := strings.TrimSpace(b.Key); len(k) >= 16 && len(k) <= 128 {
		key = sha256hex([]byte(k))
	}
	now := h.nowMs()
	var id string
	switch {
	case strings.HasPrefix(code, enrollPrefix):
		var userID string
		var expires int64
		if h.db.QueryRow("SELECT user_id, expires FROM enroll_codes WHERE hash = ?", sha256hex([]byte(code))).Scan(&userID, &expires) != nil {
			errJSON(w, 404, "接入码不对，请在客户端里重新生成")
			return
		}
		if now > expires {
			errJSON(w, 410, "接入码已过期，请在客户端里重新生成")
			return
		}
		if key == "" || h.db.QueryRow("SELECT id FROM machines WHERE owner_id = ? AND machine_key = ?", userID, key).Scan(&id) != nil {
			name := trimmed(b.Host, 60)
			if name == "" {
				name = "新机器"
			}
			id = newID("m_")
			h.must(h.db.Exec("INSERT INTO machines (id, owner_id, name, token_hash, created, machine_key) VALUES (?, ?, ?, ?, ?, ?)",
				id, userID, name, "pending:"+randHex(16), now, nullable(key)))
		}
	case strings.HasPrefix(code, joinPrefix):
		var expires int64
		if h.db.QueryRow("SELECT id, COALESCE(join_expires, 0) FROM machines WHERE join_hash = ?", sha256hex([]byte(code))).Scan(&id, &expires) != nil {
			errJSON(w, 404, "接入码不对或已经用过了，请在客户端里重新生成")
			return
		}
		if now > expires {
			errJSON(w, 410, "接入码已过期，请在客户端里重新生成")
			return
		}
		if key != "" {
			h.must(h.db.Exec("UPDATE machines SET machine_key = ? WHERE id = ?", key, id))
		}
	default:
		errJSON(w, 404, "接入码不对，请在客户端里重新生成")
		return
	}
	token := machineTokenPrefix + randHex(32)
	h.must(h.db.Exec("UPDATE machines SET token_hash = ?, join_hash = NULL, join_expires = NULL, os = COALESCE(NULLIF(?, ''), os), arch = COALESCE(NULLIF(?, ''), arch) WHERE id = ?",
		sha256hex([]byte(token)), trimmed(b.OS, 30), trimmed(b.Arch, 30), id))
	m := h.scanMachines(h.db.Query("SELECT "+machineCols+" FROM machines WHERE id = ?", id))[0]
	h.broadcastPeople(obj{"type": "machine", "machine": m})
	writeJSON(w, 200, obj{"token": token, "machine": obj{"id": id, "name": m.Name}})
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (h *Hub) v1InstallScript(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("content-type", "text/x-shellscript; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	_, _ = w.Write(installScript)
}
