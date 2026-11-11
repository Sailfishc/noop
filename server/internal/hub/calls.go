package hub

// Calls on people: each time a task needs a person, task_events records who and why (step 2 of the positioning:
// people are needed at three moments only, to align, to decide and to accept). The metric is the count of these
// calls, in two groups: the three moments, and everything outside them, the number to bring down.
//
// The kinds, and the moment each belongs to:
//
//	align                                       align: before it starts, what "done" means (once per task)
//	confirm, decide, ask, handoff, handoff_card decide: the owner's yes, a decision card, `remi ask`, `remi handoff
//	                                            @person`, a card to hand the work to another agent
//	accept (the first)                          accept
//	accept (the second and later)               outside: it was not right the first time
//	unblock, retry                              outside: the agent could not go on by itself
//	move                                        outside: its computer went away (teammove.go)
//
// confirm, decide, align, accept, unblock and retry are status changes (noteStatus); ask, handoff and handoff_card
// change no status and are recorded beside them ("side" calls, left out of the status timeline). Nothing older than
// the who column is counted: there is no backfill.

// side calls: recorded in task_events without a status change of their own.
var sideKinds = map[string]bool{"ask": true, "handoff": true, "handoff_card": true, "move": true}

const sideKindsSQL = "('ask', 'handoff', 'handoff_card', 'move')"

// callView: the task needed this person, for this, then; Class is the moment it counts as: align | decide | accept |
// outside.
type callView struct {
	At    int64  `json:"at"`
	Who   string `json:"who"`
	Kind  string `json:"kind"`
	Class string `json:"class"`
}

// classify: the moment each of one task's calls (oldest first) counts as.
func classify(calls []callView) []callView {
	accepts := 0
	for i := range calls {
		switch calls[i].Kind {
		case "align":
			calls[i].Class = "align"
		case "accept":
			accepts++
			calls[i].Class = "accept"
			if accepts > 1 {
				calls[i].Class = "outside"
			}
		case "unblock", "retry", "move":
			calls[i].Class = "outside"
		default:
			calls[i].Class = "decide"
		}
	}
	return calls
}

// calledFor: the person a task needs for this (as holderOf has it): the agent's owner confirms; the person named to
// take it (else its creator) aligns, decides and accepts; its creator unblocks and retries. "" when it needs nobody.
func (h *Hub) calledFor(id, needs string) string {
	var by, handler, owner string
	_ = h.db.QueryRow("SELECT t.created_by, t.handler, COALESCE(a.owner_id, '') FROM tasks_v1 t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.id = ?", id).
		Scan(&by, &handler, &owner)
	switch needs {
	case "confirm", "move":
		return owner
	case "align", "decide", "accept", "handoff_card":
		if handler != "" {
			return handler
		}
		return by
	case "unblock":
		return by
	case "retry":
		if h.count("SELECT COUNT(*) FROM tasks_v1 WHERE id = ? AND COALESCE(json_extract(mandate, '$.delegated'), 0) = 1", id) > 0 {
			return "" // a delegated task that failed goes back to the agent that delegated it, not to a person
		}
		return by
	}
	return ""
}

// noteCall: a side call (ask, handoff, handoff_card) on this person; the task's status stays as it was.
func (h *Hub) noteCall(t taskView, kind, who string) {
	if who == "" {
		who = h.calledFor(t.ID, kind)
	}
	if who == "" {
		return
	}
	status, _ := statusOf(t.State)
	h.must(h.db.Exec("INSERT INTO task_events (task_id, at, status, needs, who) VALUES (?, ?, ?, ?, ?)", t.ID, h.nowMs(), status, kind, who))
}
