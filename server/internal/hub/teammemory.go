package hub

import (
	"encoding/json"
	"strings"
)

// An agent's memory and a person's preferences: the two texts that travel with work from one task to the next, and
// so the two ways a private channel's words could get out (design step 1, 「个人空间」).
//
// Memory is read only by those who may change the agent (its responsible person; for a team agent, the admins too)
// and by the agent's own machine; everyone else gets the agent without it. In a private channel, only a personal
// agent whose owner is in the channel may change its memory: what it keeps then is read by that owner alone.
//
// Preferences are a person's own: returned by GET /me, changed by PATCH /users/{me}, given to the machine with each
// task that person asked for, and never in a list or a broadcast.

const preferencesChars = 4000

// mayReadMemory: the asker may see the agent's memory.
func (h *Hub) mayReadMemory(w *principal, a agentView) bool {
	if w.machineID != "" {
		return h.agentOn(a.ID, w.machineID)
	}
	return h.mayManageAgent(w.userID, a)
}

// agentFor: the agent as this asker may see it.
func (h *Hub) agentFor(w *principal, a agentView) agentView {
	if !h.mayReadMemory(w, a) {
		a.Memory = ""
	}
	return a
}

// memoryReaders: the people who may read the agent's memory.
func (h *Hub) memoryReaders(a agentView) []string {
	out := []string{a.OwnerID}
	if h.onTeamMachine(a) {
		rows, err := h.db.Query("SELECT id FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?", a.OwnerID)
		if err != nil {
			panic(err)
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				panic(err)
			}
			out = append(out, id)
		}
	}
	return out
}

// broadcastAgent: the agent's frame to everyone, with its memory only to those who may read it.
func (h *Hub) broadcastAgent(a agentView) {
	readers := h.memoryReaders(a)
	skip := map[string]bool{}
	for _, id := range readers {
		skip["u:"+id] = true
		b, _ := json.Marshal(obj{"type": "agent", "agent": a})
		h.socks.send("u:"+id, b)
	}
	bare := a
	bare.Memory = ""
	b, _ := json.Marshal(obj{"type": "agent", "agent": bare})
	h.socks.sendExcept("people", b, skip)
}

// memoryWritable: the agent may change its memory on this task. Everywhere but in a private channel; there, only a
// personal agent (not on a team machine) whose owner is in the channel.
func (h *Hub) memoryWritable(t taskView, a agentView) bool {
	if !h.isPrivate(t.ChannelID) {
		return true
	}
	return !h.onTeamMachine(a) && h.isMember(t.ChannelID, "user", a.OwnerID)
}

// preferences: what the person wrote in 「我的偏好」.
func (h *Hub) preferences(userID string) string {
	var p string
	_ = h.db.QueryRow("SELECT preferences FROM users WHERE id = ?", userID).Scan(&p)
	return p
}

func (h *Hub) setPreferences(userID, text string) {
	h.must(h.db.Exec("UPDATE users SET preferences = ? WHERE id = ?", clip(strings.TrimSpace(text), preferencesChars), userID))
}
