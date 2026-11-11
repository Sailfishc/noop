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

// takeoverView: someone took the task over from the person who asked. Pending: they asked to, and the agent's owner
// still has to say yes (an agent that needs its owner's confirmation).
type takeoverView struct {
	From    string `json:"from"`
	To      string `json:"to"`
	At      int64  `json:"at"`
	Pending bool   `json:"pending,omitempty"`
}

// v1TaskTakeover: a member of the task's channel takes it over: it goes on in their name (they accept it, they are
// asked), the mandate records who it came from. Not a task that ended.
func (h *Hub) v1TaskTakeover(w http.ResponseWriter, q *request) {
	t, ok := h.task(q.r.PathValue("id"))
	if !ok {
		errJSON(w, 404, "not found")
		return
	}
	var b struct {
		Approve *bool `json:"approve"` // the agent's owner on a pending takeover: yes or no
	}
	_ = q.json(&b)
	me := q.who.userID
	a, _ := h.agent(t.AgentID)
	reads := h.userCanRead(me, t.ChannelID)
	if !reads && me != a.OwnerID {
		errJSON(w, 404, "not found")
		return
	}
	if t.State == taskDone || t.State == taskClosed {
		errJSON(w, 409, "任务已经结束了")
		return
	}
	m := mandateView{}
	if t.Mandate != nil {
		m = *t.Mandate
	}
	last := len(m.Takeovers) - 1
	pending := last >= 0 && m.Takeovers[last].Pending
	if b.Approve != nil {
		if me != a.OwnerID && !(h.isAdmin(me) && reads) {
			errJSON(w, 403, "只有 @"+a.Handle+" 的主人能确认接手")
			return
		}
		if !pending {
			errJSON(w, 409, "没有等确认的接手")
			return
		}
		x := m.Takeovers[last]
		if !*b.Approve {
			m.Takeovers = m.Takeovers[:last]
			h.setTask(t.ID, map[string]any{"mandate": jsonOrNil(m)})
			h.insertMessage(t.ChannelID, &t.ThreadID, member{"user", me}, "没有同意 "+h.handle(x.To)+" 接手")
			h.taskChanged(t.ID)
			t, _ = h.task(t.ID)
			writeJSON(w, 200, h.taskOut(q, t))
			return
		}
		h.takeOver(w, q, t, m, x.To, me)
		return
	}
	if !h.memberOrAdmin(t.ChannelID, me) {
		errJSON(w, 403, "只有频道里的人能接手")
		return
	}
	if t.CreatedBy == me {
		writeJSON(w, 200, h.taskOut(q, t))
		return
	}
	// taking it over is asking the agent in one's own name: the agent's rules for who may ask hold
	if me != a.OwnerID && a.Dispatch == "owner" {
		errJSON(w, 403, "@"+a.Handle+" 只接主人派的活，不能接手")
		return
	}
	if me != a.OwnerID && a.Confirm {
		if pending && m.Takeovers[last].To == me {
			writeJSON(w, 200, h.taskOut(q, t))
			return
		}
		if pending {
			m.Takeovers = m.Takeovers[:last]
		}
		m.Takeovers = append(m.Takeovers, takeoverView{From: t.CreatedBy, To: me, At: h.nowMs(), Pending: true})
		h.setTask(t.ID, map[string]any{"mandate": jsonOrNil(m)})
		h.insertMessage(t.ChannelID, &t.ThreadID, member{"user", me}, h.handle(a.OwnerID)+" 我想接手这个任务（之前是 "+h.handle(t.CreatedBy)+" 发起的），@"+a.Handle+" 要你确认")
		h.taskChanged(t.ID)
		t, _ = h.task(t.ID)
		writeJSON(w, 200, h.taskOut(q, t))
		return
	}
	if pending {
		m.Takeovers = m.Takeovers[:last]
	}
	h.takeOver(w, q, t, m, me, me)
}

// takeOver: the task goes on in to's name; by is who said so (to, or the agent's owner confirming).
func (h *Hub) takeOver(w http.ResponseWriter, q *request, t taskView, m mandateView, to, by string) {
	last := len(m.Takeovers) - 1
	if last >= 0 && m.Takeovers[last].Pending {
		m.Takeovers[last].Pending = false
	} else {
		m.Takeovers = append(m.Takeovers, takeoverView{From: t.CreatedBy, To: to, At: h.nowMs()})
	}
	m.By = to
	cols := map[string]any{"created_by": to, "mandate": jsonOrNil(m)}
	if t.Handler == t.CreatedBy {
		cols["handler"] = ""
	}
	h.setTask(t.ID, cols)
	text := "接手了这个任务（之前是 " + h.handle(t.CreatedBy) + " 发起的），之后由我来回答和验收"
	if by != to {
		text = "同意 " + h.handle(to) + " 接手这个任务（之前是 " + h.handle(t.CreatedBy) + " 发起的）"
	}
	h.insertMessage(t.ChannelID, &t.ThreadID, member{"user", by}, text)
	h.taskChanged(t.ID)
	t, _ = h.task(t.ID)
	writeJSON(w, 200, h.taskOut(q, t))
}

// handle: "@handle" of a person, or "原发起人" when they are gone.
func (h *Hub) handle(userID string) string {
	if u, ok := h.user(userID); ok {
		return "@" + u.Handle
	}
	return "原发起人"
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
