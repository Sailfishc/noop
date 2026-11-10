package hub

import (
	"net/http"
	"sort"
	"time"
)

// The numbers that tell whether people and agents work well together (the dogfood measures):
//
//   - how long people take to answer what waits for them (待你处理: confirm, decide, unblock, retry, accept), from the
//     moment the task came to need them to its next status;
//   - how many runs a task takes (each run is a start of work: a request, a reply, a retry);
//   - how many tasks were cancelled and asked again (the same person, the same channel, within a day): the agent went
//     the wrong way and the only fix was to start over.
//
// And per agent: how many tasks it got and from how many people, which shows whether people go to a shared team
// agent or to their own. All of it is read from what tasks already record (task_events, runs, cancelled_at).

// redoWindow: a task asked within this long after the same person cancelled one in the same channel counts as a redo.
const redoWindow = 24 * time.Hour

type durationStats struct {
	Count  int   `json:"count"`  // answered
	Median int64 `json:"median"` // ms
	P90    int64 `json:"p90"`    // ms
	Open   int   `json:"open"`   // still waiting now
	Oldest int64 `json:"oldest"` // ms the oldest open one has waited
}

type agentMetrics struct {
	AgentID string `json:"agent_id"`
	Tasks   int64  `json:"tasks"`
	People  int64  `json:"people"`  // distinct people who asked it
	Others  int64  `json:"others"`  // tasks asked by someone other than its owner
	Team    bool   `json:"team"`    // anyone in the team may hand it work (dispatch team) without the owner's yes
	Machine string `json:"machine"` // its computer's name
}

type metricsView struct {
	Days  int   `json:"days"`
	Since int64 `json:"since"`
	// Reply: from needing a person to their answer, all kinds together and by kind (confirm, decide, unblock, retry, accept)
	Reply   durationStats            `json:"reply"`
	ReplyBy map[string]durationStats `json:"reply_by"`
	// Runs: per task people track (made in the window, run at least once)
	Runs struct {
		Tasks     int     `json:"tasks"`
		Mean      float64 `json:"mean"`
		Median    int64   `json:"median"`
		Max       int64   `json:"max"`
		ThreePlus int     `json:"three_plus"` // tasks that took 3 runs or more
	} `json:"runs"`
	Cancelled int            `json:"cancelled"` // tasks cancelled in the window
	Redone    int            `json:"redone"`    // of those, asked again
	Agents    []agentMetrics `json:"agents"`
}

func percentile(sorted []int64, p float64) int64 {
	if len(sorted) == 0 {
		return 0
	}
	i := int(float64(len(sorted)-1)*p + 0.5)
	return sorted[i]
}

func durations(answered []int64, open []int64) durationStats {
	sort.Slice(answered, func(i, j int) bool { return answered[i] < answered[j] })
	s := durationStats{Count: len(answered), Median: percentile(answered, 0.5), P90: percentile(answered, 0.9), Open: len(open)}
	for _, o := range open {
		s.Oldest = max(s.Oldest, o)
	}
	return s
}

// metrics: the numbers for the last `days` days.
func (h *Hub) metrics(days int) metricsView {
	now := h.nowMs()
	since := now - int64(days)*24*time.Hour.Milliseconds()
	v := metricsView{Days: days, Since: since, ReplyBy: map[string]durationStats{}}

	// reply: each status that needed a person, until the task's next status
	type ev struct {
		task, status, needs string
		at                  int64
	}
	rows, err := h.db.Query(`SELECT e.task_id, e.at, e.status, e.needs FROM task_events e JOIN tasks_v1 t ON t.id = e.task_id
		WHERE t.created >= ? OR e.at >= ? ORDER BY e.task_id, e.at, e.rowid`, since, since)
	if err != nil {
		panic(err)
	}
	var evs []ev
	for rows.Next() {
		var e ev
		if err := rows.Scan(&e.task, &e.at, &e.status, &e.needs); err != nil {
			panic(err)
		}
		evs = append(evs, e)
	}
	rows.Close()
	all, allOpen := []int64{}, []int64{}
	byKind, byKindOpen := map[string][]int64{}, map[string][]int64{}
	for i, e := range evs {
		kind := e.needs
		if kind == "" && e.status == statusInReview {
			kind = "accept"
		}
		if kind == "" || e.at < since {
			continue
		}
		if i+1 < len(evs) && evs[i+1].task == e.task {
			d := evs[i+1].at - e.at
			all, byKind[kind] = append(all, d), append(byKind[kind], d)
		} else {
			allOpen, byKindOpen[kind] = append(allOpen, now-e.at), append(byKindOpen[kind], now-e.at)
		}
	}
	v.Reply = durations(all, allOpen)
	for _, k := range []string{"confirm", "decide", "unblock", "retry", "accept"} {
		if len(byKind[k])+len(byKindOpen[k]) > 0 {
			v.ReplyBy[k] = durations(byKind[k], byKindOpen[k])
		}
	}

	// runs per tracked task
	runs := []int64{}
	rows, err = h.db.Query("SELECT runs FROM tasks_v1 WHERE tracked = 1 AND runs > 0 AND created >= ? ORDER BY runs", since)
	if err != nil {
		panic(err)
	}
	var sum int64
	for rows.Next() {
		var n int64
		_ = rows.Scan(&n)
		runs = append(runs, n)
		sum += n
		if n >= 3 {
			v.Runs.ThreePlus++
		}
	}
	rows.Close()
	if len(runs) > 0 {
		v.Runs.Tasks, v.Runs.Mean, v.Runs.Median, v.Runs.Max = len(runs), float64(sum)/float64(len(runs)), percentile(runs, 0.5), runs[len(runs)-1]
	}

	// cancelled, and asked again
	rows, err = h.db.Query(`SELECT c.id, EXISTS (SELECT 1 FROM tasks_v1 n WHERE n.created_by = c.created_by AND n.channel_id = c.channel_id
		AND n.id != c.id AND n.created >= c.cancelled_at AND n.created < c.cancelled_at + ?)
		FROM tasks_v1 c WHERE c.cancelled_at IS NOT NULL AND c.cancelled_at >= ?`, redoWindow.Milliseconds(), since)
	if err != nil {
		panic(err)
	}
	for rows.Next() {
		var id string
		var redone bool
		_ = rows.Scan(&id, &redone)
		v.Cancelled++
		if redone {
			v.Redone++
		}
	}
	rows.Close()

	// per agent
	rows, err = h.db.Query(`SELECT a.id, COUNT(t.id), COUNT(DISTINCT t.created_by), COALESCE(SUM(t.created_by != a.owner_id), 0),
		a.dispatch = 'team' AND a.confirm = 0, COALESCE(m.name, '')
		FROM agents a LEFT JOIN tasks_v1 t ON t.agent_id = a.id AND t.created >= ? LEFT JOIN machines m ON m.id = a.machine_id
		GROUP BY a.id ORDER BY COUNT(t.id) DESC, a.handle`, since)
	if err != nil {
		panic(err)
	}
	v.Agents = []agentMetrics{}
	for rows.Next() {
		var a agentMetrics
		if err := rows.Scan(&a.AgentID, &a.Tasks, &a.People, &a.Others, &a.Team, &a.Machine); err != nil {
			panic(err)
		}
		v.Agents = append(v.Agents, a)
	}
	rows.Close()
	return v
}

// v1Metrics: GET /api/v1/metrics?days=7, for anyone in the team (the numbers are about how the team works, not about
// what anyone wrote).
func (h *Hub) v1Metrics(w http.ResponseWriter, q *request) {
	writeJSON(w, 200, h.metrics(clampInt(q.query("days"), 7, 1, 90)))
}
