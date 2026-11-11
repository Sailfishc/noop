package hub

import (
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// 「换电脑继续」 (design step 5): a task stays on the computer that took it (teampool.go). When that computer (A) has
// been gone a while and the task needs to run, the agent's owner is asked once, on a card that never blocks: go on on
// another of the agent's computers (B), from the last checkpoint (teamcheckpoint.go), or wait. Nothing moves on its
// own. Left alone the card is "wait": when A comes back it goes, and the task goes on on A in its own session.
//
// A move gives the task to B, clears its session (sessions live on A) and counts it in tasks_v1.moves: every report
// of a run names the count it was claimed with (?moves=), and one that doesn't match is refused, so a run on A that
// comes back after the move stops there: it pushes nothing and opens no PR (src/teamwork.ts). B restores the
// checkpoint and starts a fresh session from the thread.
//
// Not done: moving on its own, moving back on its own, moving between a person's computer and a team machine (an
// agent's list never mixes them), asking twice about one absence.

const moveAfter = 10 * time.Minute // how long A is gone before anyone is asked

// moveView: the card. Since: when A was last seen (one absence, one card); State: proposed (waits for the owner) |
// waited (the owner chose to wait for A) | moved | withdrawn (A came back, or the task no longer needs to run).
type moveView struct {
	From      string `json:"from"`
	To        string `json:"to"`
	At        int64  `json:"at"`
	Since     int64  `json:"since"`
	State     string `json:"state"`
	DecidedBy string `json:"decided_by,omitempty"`
}

// needsRun: the task wants its computer now: a run that was going on, or a turn that waits for that computer.
func needsRun(t taskView) bool {
	return t.State == taskRunning || t.State == taskQueued
}

// gone: whether a machine is offline, and since when (its last report).
func (h *Hub) gone(machineID string) (bool, int64) {
	ms := h.scanMachines(h.db.Query("SELECT "+machineCols+" FROM machines WHERE id = ?", machineID))
	if len(ms) == 0 {
		return true, 0
	}
	if ms[0].Online {
		return false, 0
	}
	if ms[0].LastSeen == nil {
		return true, 0
	}
	return true, *ms[0].LastSeen
}

// moveTarget: the first other computer of the agent that can take work now ("" when none can).
func (h *Hub) moveTarget(a agentView, from string) string {
	team := h.count("SELECT COUNT(*) FROM machines WHERE id = ? AND team = 1", from) > 0
	for _, id := range h.agentMachineList(a.ID) {
		if id == from || (h.count("SELECT COUNT(*) FROM machines WHERE id = ? AND team = 1", id) > 0) != team {
			continue
		}
		if h.canTake(id, h.taskRuntime(a)) {
			return id
		}
	}
	return ""
}

// taskRuntime: the runtime the task runs with (its agent's; step 5 PR 3 lets one task use another).
func (h *Hub) taskRuntime(a agentView) string { return a.Runtime }

func (h *Hub) setMove(id string, m *moveView) {
	h.must(h.db.Exec("UPDATE tasks_v1 SET move = ? WHERE id = ?", jsonOrNil(m), id))
}

// tickMoves: put a card up where A has been gone a while, the task needs to run and B can take it; take it down when
// A is back or the task no longer needs a computer.
func (h *Hub) tickMoves() {
	ts := scanTasks(h.db.Query("SELECT " + taskCols + ` FROM tasks_v1 WHERE (state IN ('running', 'queued') AND claimed_by IS NOT NULL)
		OR json_extract(move, '$.state') IN ('proposed', 'waited')`))
	now := h.nowMs()
	for _, t := range ts {
		a, ok := h.agent(t.AgentID)
		from := h.holder(t)
		off, since := false, int64(0)
		if from != "" {
			off, since = h.gone(from)
		}
		open := t.Move != nil && (t.Move.State == "proposed" || t.Move.State == "waited")
		if !ok || from == "" || !off || !needsRun(t) {
			if open { // A is back (the task goes on there), or nothing to move any more
				m := *t.Move
				m.State = "withdrawn"
				h.setMove(t.ID, &m)
				h.taskChanged(t.ID)
			}
			continue
		}
		if now-max(since, t.Updated) < moveAfter.Milliseconds() {
			continue
		}
		if open && t.Move.Since == since {
			if t.Move.State == "proposed" { // the card names the computer that can take it now
				if to := h.moveTarget(a, from); to != "" && to != t.Move.To {
					m := *t.Move
					m.To = to
					h.setMove(t.ID, &m)
					h.taskChanged(t.ID)
				}
			}
			continue // one absence, one card
		}
		to := h.moveTarget(a, from)
		if to == "" {
			continue // nowhere to go: it waits for A (the task card says so)
		}
		h.setMove(t.ID, &moveView{From: from, To: to, At: now, Since: since, State: "proposed"})
		t.Move = nil
		h.noteCall(t, "move", a.OwnerID)
		h.taskChanged(t.ID)
	}
}

// v1TaskMove: the agent's owner answers the card: {to} goes on on that computer (default: the card's), {wait} waits
// for A.
func (h *Hub) v1TaskMove(w http.ResponseWriter, q *request) {
	t, ok := h.task(q.r.PathValue("id"))
	if !ok || !h.canRead(q.who, t.ChannelID) && !h.isOwnerOf(q.who.userID, t.AgentID) {
		errJSON(w, 404, "not found")
		return
	}
	a, _ := h.agent(t.AgentID)
	if a.OwnerID != q.who.userID {
		errJSON(w, 403, "只有 Agent 的主人能决定换哪台电脑")
		return
	}
	var b struct {
		To   string `json:"to"`
		Wait bool   `json:"wait"`
	}
	_ = q.json(&b)
	if b.Wait {
		if t.Move == nil || t.Move.State != "proposed" {
			errJSON(w, 409, "没有要回答的卡片")
			return
		}
		m := *t.Move
		m.State, m.DecidedBy = "waited", q.who.userID
		h.setMove(t.ID, &m)
		h.taskChanged(t.ID)
		t, _ = h.task(t.ID)
		writeJSON(w, 200, h.taskOut(q, t))
		return
	}
	from := h.holder(t)
	if from == "" || !needsRun(t) {
		errJSON(w, 409, "这个任务现在不需要换电脑")
		return
	}
	if off, _ := h.gone(from); !off {
		errJSON(w, 409, "原来的电脑在线，任务在那台接着做")
		return
	}
	to := b.To
	if to == "" && t.Move != nil {
		to = t.Move.To
	}
	if to == "" || to == from || !h.agentOn(a.ID, to) {
		errJSON(w, 400, "只能换到这个 Agent 的另一台电脑")
		return
	}
	if (h.count("SELECT COUNT(*) FROM machines WHERE id = ? AND team = 1", to) > 0) != (h.count("SELECT COUNT(*) FROM machines WHERE id = ? AND team = 1", from) > 0) {
		errJSON(w, 400, "个人电脑和团队电脑之间不换")
		return
	}
	if !h.canTake(to, h.taskRuntime(a)) {
		errJSON(w, 409, "那台电脑现在接不了活")
		return
	}
	m := moveView{From: from, To: to, At: h.nowMs(), State: "moved", DecidedBy: q.who.userID}
	if t.Move != nil {
		m.At, m.Since = t.Move.At, t.Move.Since
	}
	h.setMove(t.ID, &m)
	h.setTask(t.ID, map[string]any{"claimed_by": to, "session": "", "moves": t.Moves + 1, "state": taskQueued, "step": "", "news": 0, "failures": 0})
	names := map[string]string{}
	for _, id := range []string{from, to} {
		var n string
		_ = h.db.QueryRow("SELECT name FROM machines WHERE id = ?", id).Scan(&n)
		names[id] = n
	}
	how := "没有检查点，从头做"
	if t.Checkpoint != nil && (t.Checkpoint.Files != nil || hasCommit(t.Checkpoint)) {
		how = "从最新的检查点接着做"
	}
	h.insertMessage(t.ChannelID, &t.ThreadID, member{"agent", a.ID}, fmt.Sprintf("从 %s 换到 %s 继续，%s。", names[from], names[to], how))
	h.taskChanged(t.ID)
	t, _ = h.task(t.ID)
	writeJSON(w, 200, h.taskOut(q, t))
}

func hasCommit(c *checkpointView) bool {
	for _, r := range c.Repos {
		if r.Commit != "" {
			return true
		}
	}
	return false
}

// isOwnerOf: the person owns the agent.
func (h *Hub) isOwnerOf(userID, agentID string) bool {
	return userID != "" && h.count("SELECT COUNT(*) FROM agents WHERE id = ? AND owner_id = ?", agentID, userID) > 0
}

// staleRun: a machine's call names the move count its run was claimed with (?moves=), and the task moved since.
func staleRun(q *request, t taskView) bool {
	v := q.query("moves")
	if v == "" {
		return false
	}
	n, err := strconv.ParseInt(v, 10, 64)
	return err != nil || n != t.Moves
}

// v1CheckpointGet: the computer the task is on now takes its packed directory back (to go on with it). Nobody else.
func (h *Hub) v1CheckpointGet(w http.ResponseWriter, q *request) {
	t, _, ok := h.machineTask(w, q)
	if !ok {
		return
	}
	if t.Checkpoint == nil || t.Checkpoint.Files == nil {
		errJSON(w, 404, "没有检查点文件")
		return
	}
	rows, err := h.db.Query("SELECT data FROM checkpoint_blobs WHERE id = ? AND task_id = ? ORDER BY n", t.Checkpoint.Files.ID, t.ID)
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	var data []byte
	for rows.Next() {
		var d []byte
		_ = rows.Scan(&d)
		data = append(data, d...)
	}
	if len(data) == 0 {
		errJSON(w, 404, "检查点文件已经删除")
		return
	}
	w.Header().Set("content-type", "application/gzip")
	w.Header().Set("content-length", strconv.Itoa(len(data)))
	_, _ = w.Write(data)
}
