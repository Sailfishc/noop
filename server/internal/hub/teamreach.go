package hub

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
)

// One agent acting on another (design step 4 「Agent 之间协作」). The one rule: whatever agent A does to agent B in a
// task counts as the task's requester @-ing B. Where the requester may use B without its owner's yes, A may too, and
// no card stops it; where the requester would wait for B's owner, so does A (a card only B's owner clicks); where
// the requester could not bring B in at all, A is refused. reach says which, for handoff, delegate, ask and the list
// `remi who` gives. structural is the other half: never back to an agent already on the chain (that would be an
// agent waiting on itself), and never longer than maxHops.

// reachView: how the task's requester may use agent B in the task's channel.
type reachView struct {
	Card   bool   // B's owner says yes first (a card in the thread)
	Join   bool   // B is not in the channel yet and comes in when used
	Refuse string // why the requester cannot use B here at all ("" = they can)
}

// reach: whether the requester of t may use b: free (b is theirs, or b takes work from them without its owner's
// yes), behind a card b's owner clicks, or not at all. b not in the channel comes in when the requester could bring it
// (mayBringAgent) in a public channel; in a private one only when it is the requester's own agent.
func (h *Hub) reach(t taskView, b agentView) reachView {
	by := t.CreatedBy
	var r reachView
	if !h.isMember(t.ChannelID, "agent", b.ID) {
		switch {
		case h.isPrivate(t.ChannelID) && b.OwnerID != by:
			// a person bringing someone else's agent into a private channel is told what then reaches whose computer
			// and decides; an agent doing it for them would skip that, so only their own agent comes in this way
			r.Refuse = "@" + b.Handle + " 不在这个私有频道里：请频道成员先把它加进来"
		case !h.mayBringAgent(by, b):
			r.Refuse = "@" + b.Handle + " 不在这个频道，也不接整个团队的活：请它的主人先把它加进来"
		default:
			r.Join = true
		}
		if r.Refuse != "" {
			return r
		}
	}
	switch {
	case b.OwnerID == by:
	case b.Dispatch == "owner":
		r.Card = true
	case b.Confirm:
		r.Card = true
	}
	return r
}

// structural: why A may not hand on, delegate to or ask b from t ("" = it may): not itself, not an agent already on
// the chain from the first task to this one, and not past maxHops agents.
func structural(t taskView, b agentView) string {
	if b.ID == t.AgentID {
		return "不能找自己"
	}
	c := chain(t)
	for _, id := range c {
		if id == b.ID {
			return "@" + b.Handle + " 已经在这条链上了（它在等这件事），不能再找它；需要的话请人来决定"
		}
	}
	if len(c) >= maxHops {
		return fmt.Sprintf("这条链已经有 %d 个 Agent 了（最多 %d 个）：自己做完，或者用 needs_decision 请人决定", len(c), maxHops)
	}
	return ""
}

// teamAgent: one agent the requester may use from this task, as `remi who` lists it.
type teamAgent struct {
	agentView
	reach   reachView
	canTake bool  // one of its computers can take work now (teampool.go)
	running int64 // its runs going on now
	inChan  bool
}

// teamAgents: the agents this task's agent may turn to: not itself or one on its chain, and only those the requester
// may use at all (reach); free ones first.
func (h *Hub) teamAgents(t taskView) []teamAgent {
	out := []teamAgent{}
	on := map[string]bool{}
	for _, id := range chain(t) {
		on[id] = true
	}
	for _, b := range scanAgents(h.db.Query("SELECT " + agentCols + " FROM agents ORDER BY handle")) {
		if on[b.ID] {
			continue
		}
		r := h.reach(t, b)
		if r.Refuse != "" {
			continue
		}
		x := teamAgent{agentView: b, reach: r, inChan: !r.Join}
		for _, m := range h.agentMachineList(b.ID) {
			if h.canTake(m, b.Runtime) {
				x.canTake = true
				break
			}
		}
		x.running = h.count("SELECT COUNT(*) FROM tasks_v1 WHERE agent_id = ? AND state = 'running'", b.ID)
		out = append(out, x)
	}
	sort.SliceStable(out, func(i, j int) bool { return !out[i].reach.Card && out[j].reach.Card })
	return out
}

// agentLine: the agent in one line for the agent that may turn to it.
func (h *Hub) agentLine(x teamAgent) string {
	parts := []string{}
	if x.canTake {
		parts = append(parts, "can take work now")
	} else {
		parts = append(parts, "cannot take work now (its computers are off or busy: it starts when one is free)")
	}
	parts = append(parts, fmt.Sprintf("%d running", x.running))
	if x.reach.Card {
		owner := "its owner"
		if u, ok := h.user(x.OwnerID); ok {
			owner = "@" + u.Handle
		}
		parts = append(parts, "needs a card ("+owner+" says yes first)")
	} else {
		parts = append(parts, "no card")
	}
	if x.inChan {
		parts = append(parts, "in this channel")
	} else {
		parts = append(parts, "joins this channel when you hand it work")
	}
	desc := ""
	if x.Description != "" {
		desc = ": " + clip(strings.ReplaceAll(x.Description, "\n", " "), 160)
	}
	return fmt.Sprintf("@%s (%s)%s [%s]", x.Handle, x.Name, desc, strings.Join(parts, "; "))
}

// agentList: the agents this task's agent may turn to, one line each, at most n ("" when there are none).
func (h *Hub) agentList(t taskView, n int, readonly bool) string {
	if readonly { // a patrol hands nothing on (teamduties.go)
		return ""
	}
	xs := h.teamAgents(t)
	var b strings.Builder
	for i, x := range xs {
		if i == n {
			fmt.Fprintf(&b, "(%d more: remi who)\n", len(xs)-n)
			break
		}
		b.WriteString(h.agentLine(x) + "\n")
	}
	return b.String()
}

// v1AgentWhoList: `remi who` with no handle: the agents this task's agent may turn to.
func (h *Hub) v1AgentWhoList(w http.ResponseWriter, t taskView) {
	s := h.agentList(t, 50, false)
	if s == "" {
		writeText(w, "(no other agent you may turn to in this task)\n")
		return
	}
	writeText(w, s)
}
