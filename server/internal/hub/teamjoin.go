package hub

import (
	_ "embed"
	"net/http"
	"strings"
	"time"
)

// Adding a machine in one line. A person adds a machine in the app and gets a command:
//
//	curl -fsSL <server>/api/v1/install.sh | bash -s -- <server> <join code>
//
// The script installs the daemon and trades the one-time code (an hour) for the machine's token, so the token
// never sits in a shell history or a chat. A new code can be made for a machine any time; it changes the token.

const (
	joinPrefix = "tj_"
	joinTTL    = time.Hour
)

//go:embed install.sh
var installScript []byte

func (h *Hub) newJoinCode(machineID string) string {
	code := joinPrefix + randHex(12)
	h.must(h.db.Exec("UPDATE machines SET join_hash = ?, join_expires = ? WHERE id = ?", sha256hex([]byte(code)), h.nowMs()+joinTTL.Milliseconds(), machineID))
	return code
}

// v1MachineJoinCode: its owner (or an admin) makes a new install command for a machine.
func (h *Hub) v1MachineJoinCode(w http.ResponseWriter, q *request) {
	id := q.r.PathValue("id")
	var owner string
	if h.db.QueryRow("SELECT owner_id FROM machines WHERE id = ?", id).Scan(&owner) != nil {
		errJSON(w, 404, "not found")
		return
	}
	if owner != q.who.userID && !h.isAdmin(q.who.userID) {
		errJSON(w, 403, "forbidden")
		return
	}
	writeJSON(w, 200, obj{"join": h.newJoinCode(id)})
}

// v1MachineJoin: the install script trades a join code for the machine's token (once).
func (h *Hub) v1MachineJoin(w http.ResponseWriter, q *request) {
	var b struct{ Code string }
	_ = q.json(&b)
	code := strings.TrimSpace(b.Code)
	var id, name string
	var expires int64
	if !strings.HasPrefix(code, joinPrefix) || h.db.QueryRow("SELECT id, name, COALESCE(join_expires, 0) FROM machines WHERE join_hash = ?",
		sha256hex([]byte(code))).Scan(&id, &name, &expires) != nil {
		errJSON(w, 404, "接入码不对或已经用过了，请在客户端里重新生成")
		return
	}
	if h.nowMs() > expires {
		errJSON(w, 410, "接入码已过期，请在客户端里重新生成")
		return
	}
	token := machineTokenPrefix + randHex(32)
	h.must(h.db.Exec("UPDATE machines SET token_hash = ?, join_hash = NULL, join_expires = NULL WHERE id = ?", sha256hex([]byte(token)), id))
	writeJSON(w, 200, obj{"token": token, "machine": obj{"id": id, "name": name}})
}

func (h *Hub) v1InstallScript(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("content-type", "text/x-shellscript; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	_, _ = w.Write(installScript)
}
