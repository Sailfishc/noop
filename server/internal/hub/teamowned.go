package hub

import (
	"net/http"
	"strings"
)

// Team ownership (the collaboration plan, stage 2). An agent the team relies on should not depend on one person's
// laptop or one person's say:
//
//   - a team Computer: an always-on machine, with the team's bot account, that any admin may put agents on and look
//     after (machines.team); its agents default to "anyone may ask, no confirmation";
//   - a team config repository: one git repository holding AGENTS.md (team conventions), skills/ and mcp.json; every
//     machine syncs it and gives its agents what is in it (the daemon's teamconfig.ts), and reports how that went;
//   - channel conventions: how a channel works, written by its members, read by every agent working there;
//   - takeover: anyone in the channel may take over a task whose asker is away, and it goes on in their name.

// maxConventions: characters of a channel's conventions.
const maxConventions = 4000

// teamConfigStatus: how the team config repository last synced on a machine (it reports this).
type teamConfigStatus struct {
	Repo         string `json:"repo"`
	Commit       string `json:"commit"`
	Synced       int64  `json:"synced"`
	Error        string `json:"error,omitempty"`
	Instructions bool   `json:"instructions"` // it has an AGENTS.md
}

// teamConfig: the team's config repository, set by an admin ("" = none).
type teamConfig struct {
	Repo string `json:"repo"`
}

func (h *Hub) teamConfig() teamConfig {
	var c teamConfig
	h.kvGet("team_config", &c)
	return c
}

func (h *Hub) v1TeamConfig(w http.ResponseWriter, q *request) {
	writeJSON(w, 200, h.teamConfig())
}

// v1TeamConfigPut: an admin names the team config repository (a git URL any machine can clone; "" clears it).
func (h *Hub) v1TeamConfigPut(w http.ResponseWriter, q *request) {
	if !h.isAdmin(q.who.userID) {
		errJSON(w, 403, "只有管理员能改团队配置")
		return
	}
	var b teamConfig
	_ = q.json(&b)
	repo := strings.TrimSpace(b.Repo)
	if repo != "" && normRemote(repo) == "" && !strings.HasPrefix(repo, "/") && !strings.HasPrefix(repo, "file://") {
		errJSON(w, 400, "请填仓库地址，比如 https://github.com/acme/remi-config 或 git@code.corp.com:team/remi-config.git")
		return
	}
	c := teamConfig{Repo: trimmed(repo, 300)}
	h.kvSet("team_config", c)
	h.broadcastPeople(obj{"type": "team_config", "team_config": c})
	writeJSON(w, 200, c)
}

// mayRunAgentsOn: the person may put agents on this machine: their own, or a team machine when they are an admin.
func (h *Hub) mayRunAgentsOn(userID, machineID string) bool {
	return h.count("SELECT COUNT(*) FROM machines WHERE id = ? AND owner_id = ?", machineID, userID) > 0 ||
		(h.isAdmin(userID) && h.count("SELECT COUNT(*) FROM machines WHERE id = ? AND team = 1", machineID) > 0)
}

// onTeamMachine: the agent runs on a team machine.
func (h *Hub) onTeamMachine(a agentView) bool {
	return a.MachineID != nil && h.count("SELECT COUNT(*) FROM machines WHERE id = ? AND team = 1", *a.MachineID) > 0
}

// mayManageAgent: its responsible person, or an admin when it is a team agent (on a team machine).
func (h *Hub) mayManageAgent(userID string, a agentView) bool {
	return a.OwnerID == userID || (h.isAdmin(userID) && h.onTeamMachine(a))
}

// takeoverView: someone took the task over from the person who asked.
type takeoverView struct {
	From string `json:"from"`
	To   string `json:"to"`
	At   int64  `json:"at"`
}

// v1TaskTakeover: a member of the task's channel takes it over: it goes on in their name (they accept it, they are
// asked), the mandate records who it came from. Not a task that ended.
func (h *Hub) v1TaskTakeover(w http.ResponseWriter, q *request) {
	t, ok := h.task(q.r.PathValue("id"))
	if !ok {
		errJSON(w, 404, "not found")
		return
	}
	me := q.who.userID
	if !h.isMember(t.ChannelID, "user", me) && !h.isAdmin(me) {
		errJSON(w, 403, "只有频道里的人能接手")
		return
	}
	if t.State == taskDone || t.State == taskClosed {
		errJSON(w, 409, "任务已经结束了")
		return
	}
	if t.CreatedBy == me {
		writeJSON(w, 200, t)
		return
	}
	m := mandateView{}
	if t.Mandate != nil {
		m = *t.Mandate
	}
	m.Takeovers = append(m.Takeovers, takeoverView{From: t.CreatedBy, To: me, At: h.nowMs()})
	m.By = me
	cols := map[string]any{"created_by": me, "mandate": jsonOrNil(m)}
	if t.Handler == t.CreatedBy {
		cols["handler"] = ""
	}
	h.setTask(t.ID, cols)
	from := "原发起人"
	if u, ok := h.user(t.CreatedBy); ok {
		from = "@" + u.Handle
	}
	h.insertMessage(t.ChannelID, &t.ThreadID, member{"user", me}, "接手了这个任务（之前是 "+from+" 发起的），之后由我来回答和验收")
	h.taskChanged(t.ID)
	t, _ = h.task(t.ID)
	writeJSON(w, 200, t)
}

// names: up to max short names (skills, MCP servers), trimmed, without duplicates.
func names(in []string, max int) []string {
	out, seen := []string{}, map[string]bool{}
	for _, s := range in {
		s = trimmed(s, 80)
		if s != "" && !seen[s] && len(out) < max {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
