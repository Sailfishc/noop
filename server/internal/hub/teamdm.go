package hub

import (
	"net/http"
	"strings"
)

// A private chat with one agent: a private channel whose members are its creator and the agent (channels.dm_agent),
// at most one per person and agent. Everything about private channels holds; three things differ: a top-level
// message in it is taken as @-ing the agent, its members are fixed (no one added, nothing renamed, never public), and
// it is made only when the person first writes in it (POST /channels {dm_agent}, which returns the one there is).
// When the agent is gone, or no longer takes this person's work, the chat stays readable and takes no more messages.

// v1DMOpen: the person's private chat with the agent, made now if there is none.
func (h *Hub) v1DMOpen(w http.ResponseWriter, q *request, agentID string) {
	if q.who.machine {
		errJSON(w, 403, "forbidden")
		return
	}
	var id string
	if h.db.QueryRow("SELECT id FROM channels WHERE created_by = ? AND dm_agent = ?", q.who.userID, agentID).Scan(&id) == nil {
		c, _ := h.channel(id)
		writeJSON(w, 200, c)
		return
	}
	a, ok := h.agent(agentID)
	if !ok {
		errJSON(w, 404, "没有这个 Agent")
		return
	}
	if !h.mayBringAgent(q.who.userID, a) {
		errJSON(w, 403, "@"+a.Handle+" 不接整个团队的活，只有它的主人能和它私聊")
		return
	}
	slug := "p-" + randHex(4)
	for h.count("SELECT COUNT(*) FROM channels WHERE slug = ?", slug) > 0 {
		slug = "p-" + randHex(4)
	}
	id = newID("c_")
	if _, err := h.db.Exec("INSERT INTO channels (id, slug, name, topic, private, created_by, dm_agent, created) VALUES (?, ?, ?, '', 1, ?, ?, ?)",
		id, slug, a.Handle, q.who.userID, a.ID, h.nowMs()); err != nil {
		if !strings.Contains(err.Error(), "UNIQUE") {
			panic(err)
		}
		// made by a request of the same person a moment ago
		if err := h.db.QueryRow("SELECT id FROM channels WHERE created_by = ? AND dm_agent = ?", q.who.userID, agentID).Scan(&id); err != nil {
			panic(err)
		}
	} else {
		h.addMember(id, member{"user", q.who.userID})
		h.addMember(id, member{"agent", a.ID})
		h.channelChanged(id)
	}
	c, _ := h.channel(id)
	writeJSON(w, 200, c)
}

// postMentions: whom a message names. In a private chat, a person's top-level message names its agent even without
// an @.
func (h *Hub) postMentions(c channelView, topLevel bool, author member, text string) []mention {
	ms := h.mentions(text)
	if c.DMAgent == "" || !topLevel || author.Kind != "user" {
		return ms
	}
	for _, m := range ms {
		if m.Kind == "agent" && m.ID == c.DMAgent {
			return ms
		}
	}
	a, ok := h.agent(c.DMAgent)
	if !ok {
		return ms
	}
	return append([]mention{{"agent", a.ID, a.Handle}}, ms...)
}

// dmClosed: why the person may no longer write in this private chat ("" = they may).
func (h *Hub) dmClosed(c channelView, author member) string {
	if c.DMAgent == "" || author.Kind != "user" {
		return ""
	}
	a, ok := h.agent(c.DMAgent)
	if !ok {
		return "这个 Agent 已经删除了，私聊只能看历史"
	}
	if !h.mayBringAgent(author.ID, a) {
		return "@" + a.Handle + " 不再接你的活，私聊只能看历史"
	}
	return ""
}
