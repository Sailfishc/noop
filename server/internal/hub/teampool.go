package hub

// A personal agent on several of its owner's computers (design step 3 「机器成池」). It is still one agent: one name,
// description, memory and dispatch rule; what differs per computer is what that computer has (its runtime's login and
// limit, its keys, its checkouts). The owner ranks the computers, and a new task goes to the first one that can take
// work now; there is no scheduler: a machine sees a queued task only when every computer ranked above it cannot take
// work (canTake), and the first claim still wins. A task stays on the computer that claimed it (the runtime's session
// lives there): its follow-ups, rework and waits go back to that one, and when it is off they wait for it. Moving a
// task to another computer is a person's call (step 5).
//
// agent_machines holds the list (rank 0 first); agents.machine_id stays the first of it, for what reads one machine.
// A team machine's agent has just that one; a list of several holds only its owner's own machines.

const agentMachinesSchema = `
CREATE TABLE IF NOT EXISTS agent_machines (agent_id TEXT NOT NULL, machine_id TEXT NOT NULL, rank INTEGER NOT NULL,
  PRIMARY KEY (agent_id, machine_id));
CREATE INDEX IF NOT EXISTS agent_machines_machine ON agent_machines (machine_id);
INSERT OR IGNORE INTO agent_machines (agent_id, machine_id, rank)
  SELECT id, machine_id, 0 FROM agents WHERE machine_id IS NOT NULL AND id NOT IN (SELECT agent_id FROM agent_machines);
`

// onMachine: an SQL condition on col (an agent id): the agent runs on the machine (the one argument).
func onMachine(col string) string {
	return col + " IN (SELECT agent_id FROM agent_machines WHERE machine_id = ?)"
}

// setAgentMachines: the agent's computers, in order (none: it runs nowhere for now).
func (h *Hub) setAgentMachines(agentID string, ids []string) {
	h.must(h.db.Exec("DELETE FROM agent_machines WHERE agent_id = ?", agentID))
	var first any
	for i, id := range ids {
		if i == 0 {
			first = id
		}
		h.must(h.db.Exec("INSERT INTO agent_machines (agent_id, machine_id, rank) VALUES (?, ?, ?)", agentID, id, i))
	}
	h.must(h.db.Exec("UPDATE agents SET machine_id = ? WHERE id = ?", first, agentID))
}

// checkMachines: whether this list may be the agent's (owner: its responsible person; actor: who changes it).
// One computer: as before, one of theirs, or (an admin) a team machine. Several: the owner's own computers only.
func (h *Hub) checkMachines(owner, actor string, ids []string) *httpError {
	if len(ids) > 8 {
		return &httpError{400, "最多 8 台电脑"}
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			return &httpError{400, "同一台电脑只能选一次"}
		}
		seen[id] = true
		if len(ids) == 1 {
			if !h.mayRunAgentsOn(actor, id) && !h.mayRunAgentsOn(owner, id) {
				return &httpError{400, "只能用你自己的机器，或者（管理员）团队机器"}
			}
			continue
		}
		if h.count("SELECT COUNT(*) FROM machines WHERE id = ? AND owner_id = ? AND team = 0", id, owner) == 0 {
			return &httpError{400, "多台电脑只能是 Agent 负责人自己的电脑，团队机器上的 Agent 只能有一台"}
		}
	}
	return nil
}

// agentOn: the agent runs on the machine.
func (h *Hub) agentOn(agentID, machineID string) bool {
	return machineID != "" && h.count("SELECT COUNT(*) FROM agent_machines WHERE agent_id = ? AND machine_id = ?", agentID, machineID) > 0
}

// agentMachineList: the agent's computers, in order.
func (h *Hub) agentMachineList(agentID string) []string {
	rows, err := h.db.Query("SELECT machine_id FROM agent_machines WHERE agent_id = ? ORDER BY rank", agentID)
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		out = append(out, id)
	}
	return out
}

// holder: the computer the task stays on: the one that claimed it, while it is still one of its agent's ("": none
// yet, or that computer was taken off the agent, so any of them may take it as if new).
func (h *Hub) holder(t taskView) string {
	if t.ClaimedBy == nil || !h.agentOn(t.AgentID, *t.ClaimedBy) {
		return ""
	}
	return *t.ClaimedBy
}

// canTake: whether a computer can take a new task of this runtime now: online, the runtime installed and not logged
// out, the runtime not held back (a limit, no credit), and fewer tasks running there than it runs at a time.
func (h *Hub) canTake(machineID, runtime string) bool {
	ms := h.scanMachines(h.db.Query("SELECT "+machineCols+" FROM machines WHERE id = ?", machineID))
	if len(ms) == 0 || !ms[0].Online {
		return false
	}
	m := ms[0]
	ok := false
	for _, r := range m.RuntimeInfo {
		if r.Name == runtime {
			ok = r.Installed && (r.LoggedIn == nil || *r.LoggedIn)
		}
	}
	if !ok {
		return false
	}
	if _, held := m.RuntimeStatus[runtime]; held {
		return false
	}
	return h.count("SELECT COUNT(*) FROM tasks_v1 WHERE state = 'running' AND claimed_by = ?", machineID) < int64(max(m.MaxSessions, 1))
}

// pickable: whether machineID is the computer for this task now, as far as the agent's list goes: the one holding it,
// or, for a task no computer holds, the first in the list that can take it (those above it cannot). Why not, else.
func (h *Hub) pickable(t taskView, a agentView, machineID string) (bool, string) {
	if hold := h.holder(t); hold != "" {
		if hold != machineID {
			return false, "这个任务在另一台电脑上进行，留在那台"
		}
		return true, ""
	}
	for _, id := range h.agentMachineList(a.ID) {
		if id == machineID {
			return true, ""
		}
		if h.canTake(id, a.Runtime) {
			return false, "排在前面的电脑能接这个任务"
		}
	}
	return false, "这个 Agent 不在这台机器上"
}
