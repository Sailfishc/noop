package hub

import (
	"net/http"
	"net/url"
	"strings"
)

// The team's Git platforms (set once by an admin), the Ant Code webhook's state, and the last events it brought.
// Push credentials are not here: they stay on each machine, which reports only whether it has one (machineInfo).

type gitPlatform struct {
	Kind string `json:"kind"` // gitlab (Ant Code and other GitLab-based) | github
	Name string `json:"name"`
	Host string `json:"host"`
	API  string `json:"api"`
}

type gitEvent struct {
	At      int64  `json:"at"`
	Kind    string `json:"kind"`
	Project string `json:"project"`
	Branch  string `json:"branch"`
	Number  int64  `json:"number"`
	State   string `json:"state"`
	Task    string `json:"task"`
}

const gitEventsKept = 20

func (h *Hub) gitPlatforms() []gitPlatform {
	ps := []gitPlatform{}
	h.kvGet("git_platforms", &ps)
	return ps
}

func (h *Hub) v1Git(w http.ResponseWriter, q *request) {
	evs := []gitEvent{}
	h.kvGet("git_events", &evs)
	writeJSON(w, 200, obj{
		"platforms": h.gitPlatforms(),
		"webhook":   obj{"path": "/api/v1/hooks/gitlab", "secret_set": h.cfg.GitWebhookSecret != ""},
		"events":    evs,
	})
}

func (h *Hub) v1GitPlatforms(w http.ResponseWriter, q *request) {
	if !h.isAdmin(q.who.userID) {
		errJSON(w, 403, "只有管理员能配置 Git 平台")
		return
	}
	var b struct {
		Platforms []gitPlatform `json:"platforms"`
	}
	if err := q.json(&b); err != nil || len(b.Platforms) > 8 {
		errJSON(w, 400, "格式不对")
		return
	}
	out := []gitPlatform{}
	for _, p := range b.Platforms {
		host := strings.ToLower(strings.TrimSpace(p.Host))
		host = strings.TrimPrefix(strings.TrimPrefix(host, "https://"), "http://")
		host = strings.TrimRight(host, "/")
		if (p.Kind != "gitlab" && p.Kind != "github") || host == "" || strings.ContainsAny(host, " /") {
			errJSON(w, 400, "平台类型只能是 gitlab 或 github，地址填域名（例如 code.corp.com）")
			return
		}
		api := strings.TrimSpace(p.API)
		if api == "" {
			if p.Kind == "github" {
				api = "https://api.github.com"
			} else {
				api = "https://" + host + "/api/v4"
			}
		}
		if u, err := url.Parse(api); err != nil || (u.Scheme != "http" && u.Scheme != "https") {
			errJSON(w, 400, "API 地址要以 http:// 或 https:// 开头")
			return
		}
		name := trimmed(p.Name, 40)
		if name == "" {
			name = host
		}
		out = append(out, gitPlatform{Kind: p.Kind, Name: name, Host: host, API: api})
	}
	h.kvSet("git_platforms", out)
	writeJSON(w, 200, obj{"platforms": out})
}

func (h *Hub) noteGitEvent(e gitEvent) {
	evs := []gitEvent{}
	h.kvGet("git_events", &evs)
	e.At = h.nowMs()
	evs = append([]gitEvent{e}, evs...)
	if len(evs) > gitEventsKept {
		evs = evs[:gitEventsKept]
	}
	h.kvSet("git_events", evs)
}

// ---------------------------------------------------------------- signed-in devices

func (h *Hub) v1Sessions(w http.ResponseWriter, q *request) {
	rows, err := h.db.Query("SELECT id, COALESCE(ua, ''), created, last_seen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC", q.who.userID)
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []obj{}
	for rows.Next() {
		var id, ua string
		var created, last int64
		if err := rows.Scan(&id, &ua, &created, &last); err != nil {
			panic(err)
		}
		out = append(out, obj{"id": id[:16], "ua": ua, "created": created, "last_seen": last, "current": id == q.who.session})
	}
	writeJSON(w, 200, obj{"sessions": out})
}

func (h *Hub) v1SessionDelete(w http.ResponseWriter, q *request) {
	id := q.r.PathValue("id")
	if len(id) != 16 {
		errJSON(w, 404, "没有这个设备")
		return
	}
	res, err := h.db.Exec("DELETE FROM sessions WHERE user_id = ? AND substr(id, 1, 16) = ?", q.who.userID, id)
	if err != nil {
		panic(err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		errJSON(w, 404, "没有这个设备")
		return
	}
	writeJSON(w, 200, obj{"ok": true})
}
