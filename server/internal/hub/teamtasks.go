package hub

import (
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Tasks: a person @-mentions an agent in a channel and the agent takes the message up in a run (T-0001) whose thread
// is that message's thread. Not every run is a task people track (as in Raft, a task is a message someone has to act
// on): a question just gets its answer. A run becomes a tracked task when the person ticks "as task" in the composer,
// converts it later, or the agent claims it because the request needs it to act (change files, open a PR, submit to
// an outside service); a run that ends with something to accept or wait for is tracked too. The agent's owner
// confirms a run when the agent's dispatch rule asks for that; the agent's machine claims it (one claim wins), runs
// it, and reports back. Everything a person says in the thread later reaches the
// task: while it runs it waits for the next turn, after it stopped it reopens it.
//
// What people see is a task's status, one of five (as in Raft): todo, in_progress, in_review, done, closed; plus a
// "needs you" mark when a person has to act (confirm, decide, unblock, retry). Underneath, `state` is the run's own
// machine, which the machines and the server drive: pending (waits for the owner) → queued (waits for the machine) →
// running → review | needs_decision | blocked | failed | waiting (an outside result: teamwaits.go), and done
// (accepted) or closed (cancelled, declined, not allowed). statusOf maps one onto the other.

const (
	taskPending       = "pending"
	taskQueued        = "queued"
	taskRunning       = "running"
	taskNeedsDecision = "needs_decision"
	taskReview        = "review"
	taskBlocked       = "blocked"
	taskFailed        = "failed"
	taskDone          = "done"
	taskClosed        = "closed"
)

// Statuses: what people see (statusOf).
const (
	statusTodo       = "todo"
	statusInProgress = "in_progress"
	statusInReview   = "in_review"
	statusDone       = "done"
	statusClosed     = "closed"
)

// statusOf: a run state as people see it, the status and what a person must do ("" when nothing): confirm (the
// agent's owner says yes or no), decide (a decision card), unblock (it lacks something), retry (the run failed).
func statusOf(state string) (string, string) {
	switch state {
	case taskPending:
		return statusTodo, "confirm"
	case taskNeedsDecision:
		return statusInProgress, "decide"
	case taskBlocked:
		return statusInProgress, "unblock"
	case taskFailed:
		return statusInProgress, "retry"
	case taskReview:
		return statusInReview, ""
	case taskDone:
		return statusDone, ""
	case taskClosed:
		return statusClosed, ""
	}
	return statusInProgress, "" // queued, running, waiting
}

// statesOf: the run states a status covers.
func statesOf(status string) []string {
	out := []string{}
	for _, s := range []string{taskPending, taskQueued, taskRunning, taskWaiting, taskNeedsDecision, taskBlocked, taskFailed, taskReview, taskDone, taskClosed} {
		if st, _ := statusOf(s); st == status {
			out = append(out, s)
		}
	}
	return out
}

// stopped: a run ended there; a person's reply in the thread starts the next run.
var stoppedStates = map[string]bool{taskReview: true, taskNeedsDecision: true, taskBlocked: true, taskFailed: true, taskDone: true}

// what a machine may report when a run ends
var reportStates = map[string]bool{taskReview: true, taskNeedsDecision: true, taskBlocked: true, taskFailed: true, taskWaiting: true}

type decisionView struct {
	// Kind: "" a choice among options | align: before it starts, what "done" means (teamalign.go)
	Kind           string   `json:"kind,omitempty"`
	Question       string   `json:"question"`
	Options        []string `json:"options"`
	Recommendation string   `json:"recommendation,omitempty"`
	Answer         string   `json:"answer,omitempty"`
	AnsweredBy     string   `json:"answered_by,omitempty"`
	// align: the criteria it proposes (at most maxAlign), what it will leave alone, how it will go about it, and
	// whether it had already changed files when it stopped to align (it should only have read)
	Acceptance []string `json:"acceptance,omitempty"`
	NotDoing   []string `json:"not_doing,omitempty"`
	Approach   string   `json:"approach,omitempty"`
	Dirty      bool     `json:"dirty,omitempty"`
}

// prView: the change request the task produced (a GitHub PR, an Ant Code PR (GitLab MR)).
type prView struct {
	Provider string `json:"provider"` // github | gitlab
	URL      string `json:"url"`
	Number   int64  `json:"number"`
	Title    string `json:"title,omitempty"`
	State    string `json:"state"`  // open | merged | closed
	Checks   string `json:"checks"` // pending | success | failure | none
	Repo     string `json:"repo,omitempty"`
}

// mandateView: on whose word the agent works and how far it may go, fixed when the task is made.
type mandateView struct {
	By       string `json:"by"`               // who asked
	Rule     string `json:"rule"`             // the agent's dispatch scope then: owner | channel | team
	Confirm  bool   `json:"confirm"`          // it waited for the owner's yes (confirmed_by says who gave it)
	Joined   bool   `json:"joined,omitempty"` // the @mention brought the agent into the channel (team scope)
	Autonomy string `json:"autonomy"`         // cautious | assist | auto
	Branch   string `json:"branch"`           // the only branch it may push; changes go to a PR, never straight in
	Runtime  string `json:"runtime"`
	Model    string `json:"model,omitempty"`
	// Takeovers: people in the channel who took it over from the one who asked (teamowned.go); By is the last.
	Takeovers []takeoverView `json:"takeovers,omitempty"`
	// Via: the agents it came through, oldest first, when an agent handed it on ("@who via @A"); Parent: the task it was
	// handed on from; Trigger: the trigger that started it (teamtriggers.go).
	Via     []string `json:"via,omitempty"`
	Parent  string   `json:"parent,omitempty"`
	Trigger string   `json:"trigger,omitempty"`
	// Delegated: the parent's agent delegated it (remi delegate, teamdelegate.go): its result goes back to that agent,
	// not to a person's acceptance; Redos: how many times that agent sent it back
	Delegated bool `json:"delegated,omitempty"`
	Redos     int  `json:"redos,omitempty"`
}

type taskView struct {
	ID          string          `json:"id"`
	ChannelID   string          `json:"channel_id"`
	ThreadID    string          `json:"thread_id"`
	AgentID     string          `json:"agent_id"`
	CreatedBy   string          `json:"created_by"`
	Handler     string          `json:"handler"` // the person named to take it ("由 @x 验收"): accept, decide; "" = its creator
	Title       string          `json:"title"`
	Body        string          `json:"body"`
	Acceptance  string          `json:"acceptance"` // what "done" means; people write it, the agent may propose it
	Repo        string          `json:"repo"`       // where it runs: host/owner/name ("" = a general task); see teamrepos.go
	Mandate     *mandateView    `json:"mandate"`
	State       string          `json:"state"`  // the run's state (machines go by it)
	Status      string          `json:"status"` // todo | in_progress | in_review | done | closed (people go by it)
	Needs       string          `json:"needs"`  // what a person must do: confirm | decide | unblock | retry | ""
	Step        string          `json:"step"`
	Summary     string          `json:"summary"`
	Decision    *decisionView   `json:"decision"`
	PR          *prView         `json:"pr"`
	Outputs     []outputView    `json:"outputs"` // what came out: the PR, files, external results (teamoutputs.go)
	Wait        *waitView       `json:"wait"`    // what it waits for while waiting
	Result      string          `json:"result"`  // confirmed | unconfirmed: whether the agent saw the result ("" = not said)
	Branch      string          `json:"branch"`
	Session     string          `json:"session"`
	ClaimedBy   *string         `json:"claimed_by"`
	ConfirmedBy *string         `json:"confirmed_by"`
	Runs        int64           `json:"runs"`
	Tracked     bool            `json:"tracked"`      // a task people track (on the board); false: a conversation turn (an answer)
	Titled      bool            `json:"titled"`       // its title was given (by the agent or a person), not cut from the request
	Events      []taskEvent     `json:"events"`       // its status as it changed, oldest first: shown between the thread's replies
	Failures    int64           `json:"failures"`     // runs in a row that failed or died (teamhealth.go)
	LastFailure string          `json:"last_failure"` // why the last one did: auth, rate_limited, restart, …
	Usage       *usageView      `json:"usage"`        // tokens its runs used, added up
	News        bool            `json:"news"`         // something new for its running agent: the machine resumes it with that (teamsteer.go)
	Asked       []askedView     `json:"asked"`        // questions its agent put to people while it worked (remi ask)
	Repos       []string        `json:"repos"`        // repositories its agent declared it changes (remi repo), besides repo
	Handoffs    []handoffView   `json:"handoffs"`     // its agent's handoffs to other agents (remi handoff @agent): cards a person clicks
	Submits     []submitView    `json:"submits"`      // its agent's submissions to outside services (remi submit), at most maxSubmits
	Evidence    []evidenceView  `json:"evidence"`     // per acceptance criterion, how the agent verified it at its last delivery (teamevidence.go)
	Aligned     bool            `json:"aligned"`      // its agent aligned with people once (teamalign.go): it may not again
	Holder      *holderView     `json:"holder"`       // who has the ball now: whose move it is (teamhandoff.go); nil once it ended
	Delegates   []delegateView  `json:"delegates"`    // the tasks its agent delegated (teamdelegate.go), oldest first
	Calls       []callView      `json:"calls"`        // each time it needed a person, and why (calls.go)
	Checkpoint  *checkpointView `json:"checkpoint"`   // where it got to, kept off its computer (teamcheckpoint.go); nil: none yet
	Moves       int64           `json:"moves"`        // times it moved to another computer (teammove.go)
	Move        *moveView       `json:"move"`         // the 换电脑继续 card, its last one
	// Redacted: a task in a private channel shown to someone not in it (the agent's owner, who still confirms its
	// work): who, which agent and where it stands, without its title, words, channel or outputs
	Redacted bool  `json:"redacted,omitempty"`
	Created  int64 `json:"created"`
	Updated  int64 `json:"updated"`
	seenSeq  int64
}

const taskCols = `id, channel_id, thread_id, agent_id, created_by, title, body, state, step, summary, COALESCE(decision, ''),
	COALESCE(pr, ''), branch, session, claimed_by, confirmed_by, runs, created, updated, seen_seq, acceptance, COALESCE(mandate, ''), repo, COALESCE(wait, ''), result, tracked,
	failures, last_failure, COALESCE(usage, ''), titled, handler, news, asked, repos, handoffs, submits, aligned, evidence, COALESCE(checkpoint, ''), moves, COALESCE(move, '')`

func scanTasks(rows *sql.Rows, err error) []taskView {
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []taskView{}
	for rows.Next() {
		var t taskView
		var decision, pr, mandate, wait, usage, asked, repos, handoffs, submits, evidence, checkpoint, move string
		if err := rows.Scan(&t.ID, &t.ChannelID, &t.ThreadID, &t.AgentID, &t.CreatedBy, &t.Title, &t.Body, &t.State, &t.Step, &t.Summary,
			&decision, &pr, &t.Branch, &t.Session, &t.ClaimedBy, &t.ConfirmedBy, &t.Runs, &t.Created, &t.Updated, &t.seenSeq,
			&t.Acceptance, &mandate, &t.Repo, &wait, &t.Result, &t.Tracked, &t.Failures, &t.LastFailure, &usage, &t.Titled, &t.Handler, &t.News, &asked, &repos, &handoffs, &submits, &t.Aligned, &evidence, &checkpoint, &t.Moves, &move); err != nil {
			panic(err)
		}
		t.Status, t.Needs = statusOf(t.State)
		t.Asked, t.Repos = []askedView{}, []string{}
		_ = json.Unmarshal([]byte(asked), &t.Asked)
		_ = json.Unmarshal([]byte(repos), &t.Repos)
		t.Handoffs, t.Submits = []handoffView{}, []submitView{}
		_ = json.Unmarshal([]byte(handoffs), &t.Handoffs)
		_ = json.Unmarshal([]byte(submits), &t.Submits)
		t.Evidence = []evidenceView{}
		_ = json.Unmarshal([]byte(evidence), &t.Evidence)
		t.Checkpoint = parseCheckpoint(checkpoint)
		if move != "" {
			t.Move = &moveView{}
			_ = json.Unmarshal([]byte(move), t.Move)
		}
		if wait != "" {
			t.Wait = &waitView{}
			_ = json.Unmarshal([]byte(wait), t.Wait)
		}
		if usage != "" {
			t.Usage = &usageView{}
			_ = json.Unmarshal([]byte(usage), t.Usage)
		}
		if mandate != "" {
			t.Mandate = &mandateView{}
			_ = json.Unmarshal([]byte(mandate), t.Mandate)
		}
		if decision != "" {
			t.Decision = &decisionView{}
			_ = json.Unmarshal([]byte(decision), t.Decision)
		}
		if pr != "" {
			t.PR = &prView{}
			_ = json.Unmarshal([]byte(pr), t.PR)
		}
		out = append(out, t)
	}
	return out
}

func (h *Hub) task(id string) (taskView, bool) {
	ts := scanTasks(h.db.Query("SELECT "+taskCols+" FROM tasks_v1 WHERE id = ? OR num = ?", id, taskNum(id)))
	if len(ts) == 0 {
		return taskView{}, false
	}
	return h.withOutputs(ts)[0], true
}

var taskIDRE = regexp.MustCompile(`^T-(\d+)$`)

func taskNum(id string) int64 {
	var n int64 = -1
	if m := taskIDRE.FindStringSubmatch(id); m != nil {
		_, _ = fmt.Sscan(m[1], &n)
	}
	return n
}

// redact: the task as someone who cannot read its channel may see it (Redacted): who, which agent, where it stands
// and who has the ball, and a handoff card still to click (its id and agent only).
func redact(t taskView) taskView {
	r := taskView{ID: t.ID, AgentID: t.AgentID, CreatedBy: t.CreatedBy, Handler: t.Handler, State: t.State, Status: t.Status,
		Needs: t.Needs, Runs: t.Runs, Tracked: t.Tracked, Created: t.Created, Updated: t.Updated, Redacted: true,
		Outputs: []outputView{}, Events: []taskEvent{}, Calls: []callView{}, Asked: []askedView{}, Repos: []string{}, Handoffs: []handoffView{}, Submits: []submitView{}, Evidence: []evidenceView{},
		Holder: t.Holder, Delegates: []delegateView{}, Moves: t.Moves, Move: t.Move}
	// a handoff card still to click: its owner may be outside the channel (the card waits for them), so the row keeps
	// which card and which agent, not its words
	for _, x := range t.Handoffs {
		if x.State == "proposed" {
			r.Handoffs = append(r.Handoffs, handoffView{ID: x.ID, To: x.To, At: x.At, State: x.State})
		}
	}
	return r
}

// taskOut: the task as this person may see it: whole, or redacted when its channel is private and they are not in it.
func (h *Hub) taskOut(q *request, t taskView) taskView {
	if q.who.machineID == "" && !h.userCanRead(q.who.userID, t.ChannelID) {
		return redact(t)
	}
	return t
}

func (h *Hub) taskChanged(id string) {
	t, ok := h.task(id)
	if !ok {
		return
	}
	h.broadcastChannel(t.ChannelID, obj{"type": "task", "task": t})
	// its people outside the channel (the agent's owner who confirms it, a requester who left) see it in their inbox
	// too: the whole task where they may read the channel, else as redacted as the inbox shows it
	people := []string{t.CreatedBy, t.Handler}
	if a, ok := h.agent(t.AgentID); ok {
		people = append(people, a.OwnerID)
	}
	for _, x := range t.Handoffs { // the owner of an agent a card waits for clicks it
		if b, ok := h.agent(x.To); ok && x.State == "proposed" {
			people = append(people, b.OwnerID)
		}
	}
	told := map[string]bool{}
	for _, u := range people {
		if u == "" || told[u] || h.isMember(t.ChannelID, "user", u) {
			continue
		}
		told[u] = true
		out := t
		if !h.userCanRead(u, t.ChannelID) {
			out = redact(t)
		}
		b, _ := json.Marshal(obj{"type": "task", "task": out})
		h.socks.send("u:"+u, b)
	}
}

// taskEvent: the status a task came to (and what it then needed of a person), and when.
type taskEvent struct {
	At     int64  `json:"at"`
	Status string `json:"status"`
	Needs  string `json:"needs,omitempty"`
}

// noteStatus records the task's status when it differs from the last one recorded, with the person it now needs
// (attention.go's calls: who the task came to need, and for what).
// kind, when given, says what a person is needed for more precisely than the state does (align).
func (h *Hub) noteStatus(id, state string, kind ...string) {
	status, needs := statusOf(state)
	if state == taskReview {
		needs = "accept"
	}
	if len(kind) > 0 && kind[0] != "" && needs != "" {
		needs = kind[0]
	}
	var last, lastNeeds string
	_ = h.db.QueryRow("SELECT status, needs FROM task_events WHERE task_id = ? AND needs NOT IN "+sideKindsSQL+" ORDER BY at DESC, rowid DESC LIMIT 1", id).Scan(&last, &lastNeeds)
	if lastNeeds == "" && last == statusInReview {
		lastNeeds = "accept" // recorded before the kind was
	}
	if last == status && lastNeeds == needs {
		return
	}
	h.must(h.db.Exec("INSERT INTO task_events (task_id, at, status, needs, who) VALUES (?, ?, ?, ?, ?)", id, h.nowMs(), status, needs, h.calledFor(id, needs)))
}

// taskEvents: the task's status as it changed, and the calls on people among them (calls.go).
func (h *Hub) taskEvents(id string) ([]taskEvent, []callView) {
	rows, err := h.db.Query("SELECT at, status, needs, who FROM task_events WHERE task_id = ? ORDER BY at, rowid", id)
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out, calls := []taskEvent{}, []callView{}
	for rows.Next() {
		var e taskEvent
		var who string
		if err := rows.Scan(&e.At, &e.Status, &e.Needs, &who); err != nil {
			panic(err)
		}
		if who != "" {
			calls = append(calls, callView{At: e.At, Who: who, Kind: e.Needs})
		}
		if sideKinds[e.Needs] {
			continue // a call that changed no status: the agent's message says it in the thread
		}
		if e.Needs == "accept" {
			e.Needs = "" // in review says it
		}
		out = append(out, e)
	}
	return out, classify(calls)
}

func (h *Hub) setTask(id string, cols map[string]any) {
	needs, _ := cols["_needs"].(string) // what the new state needs a person for, when the state alone doesn't say (align)
	delete(cols, "_needs")
	if state, ok := cols["state"].(string); ok {
		h.noteStatus(id, state, needs)
	}
	sets, args := []string{"updated = ?"}, []any{h.nowMs()}
	for k, v := range cols {
		sets = append(sets, k+" = ?")
		args = append(args, v)
	}
	args = append(args, id)
	h.must(h.db.Exec("UPDATE tasks_v1 SET "+strings.Join(sets, ", ")+" WHERE id = ?", args...))
	if state, ok := cols["state"].(string); ok && returnedStates[state] {
		h.childReturned(id) // a delegated task came back: its parent may have all it waits for (teamdelegate.go)
	}
}

func jsonOrNil(v any) any {
	if v == nil {
		return nil
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// taskTitle: the message's first line without the agents' @handles, at most 60 characters.
func taskTitle(text string) string {
	line := strings.TrimSpace(strings.SplitN(strings.TrimSpace(text), "\n", 2)[0])
	line = strings.TrimSpace(mentionRE.ReplaceAllStringFunc(line, func(s string) string {
		if strings.HasPrefix(s, "@") {
			return ""
		}
		return s[:1]
	}))
	if line == "" {
		line = "（无标题）"
	}
	if utf8.RuneCountInString(line) > 60 {
		line = string([]rune(line)[:59]) + "…"
	}
	return line
}

// onPosted: what a new message means for tasks. A person's reply in a task's thread reaches its agent when they
// have a stake in it or @ it (wakes, teamsteer.go); a person's @agent elsewhere hands that agent a task (one per
// agent and thread).
func (h *Hub) onPosted(m messageView, asTask bool) {
	if m.Author.Kind != "user" {
		return
	}
	root := m.ID
	if m.ThreadID != nil {
		root = *m.ThreadID
		for _, t := range scanTasks(h.db.Query("SELECT "+taskCols+" FROM tasks_v1 WHERE thread_id = ?", root)) {
			if h.wakes(t, m) {
				h.answered(t, m)
				h.news(t)
			}
		}
	}
	for _, mm := range m.Mentions {
		if mm.Kind != "agent" {
			continue
		}
		joined := false
		if !h.isMember(m.ChannelID, "agent", mm.ID) {
			a, ok := h.agent(mm.ID)
			if !ok || a.Dispatch != "team" {
				continue // not here, and only a team-wide agent comes when called
			}
			h.addMember(m.ChannelID, member{"agent", a.ID})
			h.channelChanged(m.ChannelID)
			joined = true
		}
		if h.count("SELECT COUNT(*) FROM tasks_v1 WHERE thread_id = ? AND agent_id = ?", root, mm.ID) > 0 {
			continue // already on it: followUp took it
		}
		h.createTask(m, root, mm.ID, joined, asTask)
	}
}

// acceptanceRE: "验收：…" / "验收标准：…" / "Acceptance: …" on a line of its own starts the acceptance criteria.
var acceptanceRE = regexp.MustCompile(`(?im)^\s*(验收标准|验收|acceptance criteria|acceptance)\s*[:：]\s*`)

// splitAcceptance: the message without its acceptance criteria, and the criteria.
func splitAcceptance(text string) (string, string) {
	loc := acceptanceRE.FindStringIndex(text)
	if loc == nil {
		return text, ""
	}
	return strings.TrimSpace(text[:loc[0]]), strings.TrimSpace(text[loc[1]:])
}

// handlerRE: who takes the task when it stops for people, as the request names them: "处理人：@x" / "验收人：@x" /
// "Reviewer: @x" on a line of its own, or "由 @x 验收" (处理、确认、决定、审、看) anywhere.
var handlerRE = []*regexp.Regexp{
	regexp.MustCompile(`(?im)^\s*(?:处理人|验收人|审核人|reviewer|handler)\s*[:：]\s*@([a-z][a-z0-9_-]{1,31})`),
	regexp.MustCompile(`由\s*@([a-z][a-z0-9_-]{1,31})\s*(?:来\s*)?(?:处理|验收|确认|决定|审|看|review)`),
}

// taskHandler: the person a request names to take the task, "" for none (then it is its creator). Agents don't count.
func (h *Hub) taskHandler(text string) string {
	for _, re := range handlerRE {
		if m := re.FindStringSubmatch(text); m != nil {
			var id string
			if h.db.QueryRow("SELECT id FROM users WHERE handle = ? AND disabled = 0", m[1]).Scan(&id) == nil {
				return id
			}
		}
	}
	return ""
}

// takerOf: who takes a task that stopped for people (accepts it, decides): the person named, else its creator.
func takerOf(t taskView) string {
	if t.Handler != "" {
		return t.Handler
	}
	return t.CreatedBy
}

func (h *Hub) createTask(m messageView, root, agentID string, joined, tracked bool) {
	h.createTaskWith(m, root, agentID, joined, tracked, taskOrigin{})
}

// taskOrigin: a task not made by a person's own @: handed on by an agent (a handoff card someone clicked) or started
// by a trigger. By: the person it is in the name of (else the message's author); Confirmed: a person already said yes
// for the agent's owner (no "确认开工" again).
type taskOrigin struct {
	By        string
	Via       []string
	Parent    string
	Trigger   string
	Confirmed bool
	// Delegated: a part the parent's agent delegated (teamdelegate.go); Acceptance: what it asked for, its criteria
	Delegated  bool
	Acceptance string
}

func (h *Hub) createTaskWith(m messageView, root, agentID string, joined, tracked bool, o taskOrigin) string {
	a, ok := h.agent(agentID)
	if !ok {
		return ""
	}
	by := m.Author.ID
	if o.By != "" {
		by = o.By
	}
	state, summary := taskQueued, ""
	switch {
	case by == a.OwnerID:
	case a.Dispatch == "owner" && !o.Confirmed: // its owner said yes to this one (a handoff card): it takes it
		state, summary = taskClosed, "@"+a.Handle+" 只接主人派的活"
	case a.Confirm && !o.Confirmed:
		state = taskPending
	}
	var n int64
	_ = h.db.QueryRow("SELECT COALESCE(MAX(num), 0) + 1 FROM tasks_v1").Scan(&n)
	id := fmt.Sprintf("T-%04d", n)
	now := h.nowMs()
	text, acceptance := splitAcceptance(m.Text)
	if acceptance == "" {
		acceptance = o.Acceptance
	}
	if root != m.ID { // a reply: the task is about the thread
		if r, ok := h.message(root); ok {
			text = r.Text + "\n\n" + text
		}
	}
	repo := h.taskRepo(m.Text, root)
	branch := "agent/" + id
	mandate := mandateView{By: by, Rule: a.Dispatch, Confirm: state == taskPending, Joined: joined, Autonomy: a.Autonomy,
		Branch: branch, Runtime: a.Runtime, Model: a.Model, Via: o.Via, Parent: o.Parent, Trigger: o.Trigger, Delegated: o.Delegated}
	h.must(h.db.Exec(`INSERT INTO tasks_v1 (id, num, channel_id, thread_id, agent_id, created_by, title, body, acceptance, mandate, state, summary,
		branch, repo, tracked, handler, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, n, m.ChannelID, root, agentID, by,
		taskTitle(m.Text), text, clip(acceptance, 4000), jsonOrNil(mandate), state, summary, branch, repo, boolInt(tracked), h.taskHandler(m.Text), now, now))
	h.noteStatus(id, state)
	if state == taskClosed && summary != "" { // turned away: it says so in the thread, as a teammate would
		h.insertMessage(m.ChannelID, &root, member{"agent", a.ID}, summary)
	}
	h.taskChanged(id)
	return id
}

// followUp: a person said something in the task's thread.
func (h *Hub) followUp(t taskView) {
	if t.State == taskWaiting { // people said something: the agent hears it now, not after the wait
		w := t.Wait
		if w == nil {
			w = &waitView{}
		}
		h.wakeTask(t.ID, w, "message", "", "")
		return
	}
	if stoppedStates[t.State] {
		h.setTask(t.ID, map[string]any{"state": taskQueued, "step": ""})
		h.taskChanged(t.ID)
	}
	// pending / queued: the claim brings the message along; running: the report sees it and queues the next turn;
	// closed: not reopened (cancelled on purpose)
}

// unseen: people's messages in the thread the agent has not been given yet.
// A delegated task also hears the agent that delegated it (what to redo), and any task the answers to the questions it
// put to other agents (teamask.go).
func (h *Hub) unseen(t taskView) []messageView {
	parent := ""
	if t.Mandate != nil && t.Mandate.Delegated && len(t.Mandate.Via) > 0 {
		parent = t.Mandate.Via[len(t.Mandate.Via)-1]
	}
	return scanMessages(h.db.Query("SELECT "+messageCols+` FROM messages m WHERE (m.thread_id = ? OR m.id = ?) AND m.seq > ?
		AND (m.author_kind = 'user' OR (m.author_kind = 'agent' AND m.author_id = ?)
		OR m.id IN (SELECT answer_msg FROM agent_asks WHERE task_id = ?)) ORDER BY m.seq`, t.ThreadID, t.ThreadID, t.seenSeq, parent, t.ID))
}

// ---------------------------------------------------------------- people

func (h *Hub) v1Tasks(w http.ResponseWriter, q *request) {
	where, args := []string{"1 = 1"}, []any{}
	if c := q.query("channel"); c != "" {
		where, args = append(where, "channel_id = ?"), append(args, c)
	}
	if s := q.query("state"); s != "" {
		where, args = append(where, "state = ?"), append(args, s)
	}
	if s := q.query("status"); s != "" {
		states := statesOf(s)
		if len(states) == 0 {
			errJSON(w, 400, "status 只能是 todo、in_progress、in_review、done 或 closed")
			return
		}
		where = append(where, "state IN (?"+strings.Repeat(", ?", len(states)-1)+")")
		for _, st := range states {
			args = append(args, st)
		}
	}
	if q.query("tracked") == "1" {
		where = append(where, "tracked = 1")
	}
	if t := q.query("thread"); t != "" {
		where, args = append(where, "thread_id = ?"), append(args, t)
	}
	limit := clampInt(q.query("limit"), 100, 1, 500)
	ts := scanTasks(h.db.Query("SELECT "+taskCols+" FROM tasks_v1 WHERE "+strings.Join(where, " AND ")+" ORDER BY num DESC LIMIT ?", append(args, limit)...))
	out := []taskView{}
	for _, t := range ts {
		if h.canRead(q.who, t.ChannelID) {
			out = append(out, t)
		}
	}
	writeJSON(w, 200, obj{"tasks": h.withOutputs(out)})
}

func (h *Hub) v1Task(w http.ResponseWriter, q *request) {
	t, ok := h.task(q.r.PathValue("id"))
	if !ok || !h.canRead(q.who, t.ChannelID) {
		errJSON(w, 404, "not found")
		return
	}
	writeJSON(w, 200, h.taskOut(q, t))
}

// v1Inbox: what waits for this person: tasks for their agents to confirm, decisions and results to look at, questions
// an agent put to them.
func (h *Hub) v1Inbox(w http.ResponseWriter, q *request) {
	me := q.who.userID
	ts := scanTasks(h.db.Query("SELECT "+taskCols+` FROM tasks_v1 t WHERE
		(t.state = 'pending' AND t.agent_id IN (SELECT id FROM agents WHERE owner_id = ?))
		OR (t.state = 'needs_decision' AND (COALESCE(NULLIF(t.handler, ''), t.created_by) = ? OR t.agent_id IN (SELECT id FROM agents WHERE owner_id = ?)))
		OR (t.state = 'review' AND COALESCE(NULLIF(t.handler, ''), t.created_by) = ?)
		OR (t.state IN ('blocked', 'failed') AND (t.created_by = ? OR t.agent_id IN (SELECT id FROM agents WHERE owner_id = ?))
			AND NOT (t.state = 'failed' AND COALESCE(json_extract(t.mandate, '$.delegated'), 0) = 1))
		OR (t.state = 'waiting' AND json_extract(t.wait, '$.how') = 'quota' AND json_extract(t.wait, '$.stale') = 1
			AND (t.created_by = ? OR t.agent_id IN (SELECT id FROM agents WHERE owner_id = ?)))
		OR (t.state NOT IN ('done', 'closed') AND EXISTS (SELECT 1 FROM json_each(t.asked) q
			WHERE json_extract(q.value, '$.user') = ? AND COALESCE(json_extract(q.value, '$.answered'), 0) = 0))
		OR (json_extract(t.move, '$.state') = 'proposed' AND t.agent_id IN (SELECT id FROM agents WHERE owner_id = ?))
		OR (t.state NOT IN ('done', 'closed') AND EXISTS (SELECT 1 FROM json_each(t.handoffs) x WHERE json_extract(x.value, '$.state') = 'proposed'
			AND json_extract(x.value, '$.to') IN (SELECT id FROM agents WHERE owner_id = ?)))
		ORDER BY t.updated DESC LIMIT 200`, me, me, me, me, me, me, me, me, me, me, me))
	ts = h.withOutputs(ts)
	for i := range ts {
		ts[i] = h.taskOut(q, ts[i]) // an owner not in a private channel still confirms; they see no more than that
	}
	out := obj{"tasks": ts}
	if h.isAdmin(me) { // people asking to join wait for an admin
		out["signups"] = h.pendingSignups()
	}
	writeJSON(w, 200, out)
}

// taskFor: the task in the path, if this person may act on it as `who` ("owner": the agent's owner; "party": its
// creator, the person it names to take it, or the agent's owner; admins count as both, but not in a private channel
// they are not in). Someone else who cannot read its channel is told it does not exist.
func (h *Hub) taskFor(w http.ResponseWriter, q *request, who string, states ...string) (taskView, agentView, bool) {
	t, ok := h.task(q.r.PathValue("id"))
	if !ok {
		errJSON(w, 404, "not found")
		return t, agentView{}, false
	}
	a, _ := h.agent(t.AgentID)
	me := q.who.userID
	reads := h.userCanRead(me, t.ChannelID)
	allowed := me == a.OwnerID || (h.isAdmin(me) && reads) || (who == "party" && (me == t.CreatedBy || me == t.Handler))
	if !allowed && !reads {
		errJSON(w, 404, "not found")
		return t, a, false
	}
	if !allowed {
		if who == "owner" {
			errJSON(w, 403, "只有 Agent 的主人能做这个决定")
		} else {
			errJSON(w, 403, "只有发起人、处理人或 Agent 的主人能操作")
		}
		return t, a, false
	}
	for _, s := range states {
		if t.State == s {
			return t, a, true
		}
	}
	errJSON(w, 409, "任务现在是 "+t.State+"，不能这样操作")
	return t, a, false
}

func (h *Hub) v1TaskConfirm(w http.ResponseWriter, q *request) {
	t, _, ok := h.taskFor(w, q, "owner", taskPending)
	if !ok {
		return
	}
	h.setTask(t.ID, map[string]any{"state": taskQueued, "confirmed_by": q.who.userID})
	h.taskChanged(t.ID)
	t, _ = h.task(t.ID)
	writeJSON(w, 200, h.taskOut(q, t))
}

func (h *Hub) v1TaskDecline(w http.ResponseWriter, q *request) {
	t, _, ok := h.taskFor(w, q, "owner", taskPending)
	if !ok {
		return
	}
	var b struct{ Reason string }
	_ = q.json(&b)
	summary := "主人没有接这个活"
	if r := trimmed(b.Reason, 300); r != "" {
		summary += "：" + r
	}
	h.setTask(t.ID, map[string]any{"state": taskClosed, "summary": summary})
	h.taskChanged(t.ID)
	t, _ = h.task(t.ID)
	writeJSON(w, 200, h.taskOut(q, t))
}

func (h *Hub) v1TaskCancel(w http.ResponseWriter, q *request) {
	t, _, ok := h.taskFor(w, q, "party", taskPending, taskQueued, taskRunning, taskNeedsDecision, taskReview, taskBlocked, taskFailed, taskWaiting)
	if !ok {
		return
	}
	h.setTask(t.ID, map[string]any{"state": taskClosed, "step": "", "summary": strings.TrimSpace(t.Summary + "\n已取消"), "cancelled_at": h.nowMs()})
	h.taskChanged(t.ID)
	h.cancelDelegates(t.ID) // what it delegated and is not back yet goes too
	t, _ = h.task(t.ID)
	writeJSON(w, 200, h.taskOut(q, t))
}

// v1TaskPatch: the creator or the agent's owner writes down what "done" means, or (before it ever ran) where it runs.
func (h *Hub) v1TaskPatch(w http.ResponseWriter, q *request) {
	t, _, ok := h.taskFor(w, q, "party", taskPending, taskQueued, taskRunning, taskNeedsDecision, taskReview, taskBlocked, taskFailed, taskWaiting, taskDone, taskClosed)
	if !ok {
		return
	}
	var b struct {
		Title      *string `json:"title"`
		Acceptance *string `json:"acceptance"`
		Repo       *string `json:"repo"`
	}
	_ = q.json(&b)
	if b.Title != nil {
		title := trimmed(*b.Title, 60)
		if title == "" {
			errJSON(w, 400, "标题不能为空")
			return
		}
		h.setTask(t.ID, map[string]any{"title": title, "titled": 1})
		h.taskChanged(t.ID)
	}
	if (b.Repo != nil || b.Acceptance != nil) && (t.State == taskDone || t.State == taskClosed) {
		errJSON(w, 409, "任务已经结束了；重新打开再改")
		return
	}
	if b.Repo != nil {
		r := normRemote(*b.Repo)
		if r == "" && strings.TrimSpace(*b.Repo) != "" {
			errJSON(w, 400, "仓库要写成地址，比如 https://github.com/owner/name")
			return
		}
		if t.Runs > 0 && r != t.Repo {
			errJSON(w, 409, "任务已经开始过了，不能再换仓库；新开一个任务吧")
			return
		}
		h.setTask(t.ID, map[string]any{"repo": r})
		h.taskChanged(t.ID)
	}
	if b.Acceptance != nil {
		h.setTask(t.ID, map[string]any{"acceptance": clip(strings.TrimSpace(*b.Acceptance), 4000)})
		h.taskChanged(t.ID)
	}
	t, _ = h.task(t.ID)
	writeJSON(w, 200, h.taskOut(q, t))
}

// v1TaskAccept: done. From review, or (as people may judge it themselves) from a run that stopped for them.
func (h *Hub) v1TaskAccept(w http.ResponseWriter, q *request) {
	t, _, ok := h.taskFor(w, q, "party", taskReview, taskNeedsDecision, taskBlocked, taskFailed)
	if !ok {
		return
	}
	h.setTask(t.ID, map[string]any{"state": taskDone})
	h.taskChanged(t.ID)
	t, _ = h.task(t.ID)
	writeJSON(w, 200, h.taskOut(q, t))
}

// v1TaskTrack: "convert to task": a conversation turn becomes a task people track.
func (h *Hub) v1TaskTrack(w http.ResponseWriter, q *request) {
	t, _, ok := h.taskFor(w, q, "party", taskPending, taskQueued, taskRunning, taskWaiting, taskNeedsDecision, taskBlocked, taskFailed, taskReview, taskDone)
	if !ok {
		return
	}
	var b struct{ Title string }
	_ = q.json(&b)
	cols := map[string]any{"tracked": 1}
	if title := trimmed(b.Title, 60); title != "" {
		cols["title"], cols["titled"] = title, 1
	}
	h.setTask(t.ID, cols)
	h.taskChanged(t.ID)
	t, _ = h.task(t.ID)
	writeJSON(w, 200, h.taskOut(q, t))
}

// v1TaskReopen: a done or closed task goes back to work (in progress): its agent picks it up again with what the
// person said (or a plain "reopened") as the news in its thread.
func (h *Hub) v1TaskReopen(w http.ResponseWriter, q *request) {
	t, _, ok := h.taskFor(w, q, "party", taskDone, taskClosed)
	if !ok {
		return
	}
	var b struct{ Note string }
	_ = q.json(&b)
	text := "重新打开了这个任务"
	if n := trimmed(b.Note, 2000); n != "" {
		text += "：" + n
	}
	h.insertMessage(t.ChannelID, &t.ThreadID, member{"user", q.who.userID}, text)
	h.setTask(t.ID, map[string]any{"state": taskQueued, "step": ""})
	h.taskChanged(t.ID)
	t, _ = h.task(t.ID)
	writeJSON(w, 200, h.taskOut(q, t))
}

// v1TaskDecide: one of the decision card's options (or words of one's own). It is said in the thread, which sends
// the task back to its agent with the answer.
func (h *Hub) v1TaskDecide(w http.ResponseWriter, q *request) {
	t, _, ok := h.taskFor(w, q, "party", taskNeedsDecision)
	if !ok {
		return
	}
	var b struct {
		Choice     string
		Acceptance *string // align: the criteria as the person left them (edited or not)
	}
	_ = q.json(&b)
	if t.Decision != nil && t.Decision.Kind == "align" {
		h.alignGo(w, q, t, b.Acceptance)
		return
	}
	choice := trimmed(b.Choice, 2000)
	if choice == "" || t.Decision == nil {
		errJSON(w, 400, "choice required")
		return
	}
	t.Decision.Answer, t.Decision.AnsweredBy = choice, q.who.userID
	h.setTask(t.ID, map[string]any{"decision": jsonOrNil(t.Decision)})
	m := h.insertMessage(t.ChannelID, &t.ThreadID, member{"user", q.who.userID}, "决定："+choice)
	h.onPosted(m, false)
	t, _ = h.task(t.ID)
	h.taskChanged(t.ID)
	writeJSON(w, 200, h.taskOut(q, t))
}

// ---------------------------------------------------------------- machines

// machineTask: the task in the path, if it belongs to one of this machine's agents.
func (h *Hub) machineTask(w http.ResponseWriter, q *request) (taskView, agentView, bool) {
	t, ok := h.task(q.r.PathValue("id"))
	if !ok {
		errJSON(w, 404, "not found")
		return t, agentView{}, false
	}
	a, _ := h.agent(t.AgentID)
	if !h.agentOn(a.ID, q.who.machineID) {
		errJSON(w, 403, "这个任务的 Agent 不在这台机器上")
		return t, a, false
	}
	if hold := h.holder(t); hold != "" && hold != q.who.machineID { // it stays on the computer that took it
		errJSON(w, 409, "这个任务在另一台电脑上进行，留在那台")
		return t, a, false
	}
	if staleRun(q, t) { // it moved to another computer since this run was claimed (teammove.go)
		errJSON(w, 409, "这个任务已经换到另一台电脑，这次运行已经无效")
		return t, a, false
	}
	return t, a, true
}

// v1MachineTasks: the work waiting for this machine, and what it was running (to pick up after a restart).
// endedKeep: how long a machine keeps an ended task's worktree, in case someone picks the task up again.
const endedKeep = 7 * 24 * time.Hour

func (h *Hub) v1MachineTasks(w http.ResponseWriter, q *request) {
	if q.query("waiting") == "1" { // its tasks that wait on a check command it runs
		ts := scanTasks(h.db.Query("SELECT "+taskCols+` FROM tasks_v1 WHERE state = 'waiting' AND json_extract(wait, '$.how') = 'poll'
			AND claimed_by = ? ORDER BY num`, q.who.machineID))
		writeJSON(w, 200, obj{"tasks": ts})
		return
	}
	if q.query("prs") == "1" { // the open PRs of its agents' tasks, to follow their state and CI
		writeJSON(w, 200, obj{"tasks": scanTasks(h.db.Query("SELECT "+taskCols+` FROM tasks_v1 WHERE json_extract(pr, '$.state') = 'open'
			AND claimed_by = ? ORDER BY num`, q.who.machineID))})
		return
	}
	if ids := q.query("ended"); ids != "" { // of the task folders it keeps, the ones whose task ended a week ago or more
		list := strings.Split(ids, ",")
		if len(list) > 200 {
			list = list[:200]
		}
		since := h.nowMs() - endedKeep.Milliseconds()
		if q.query("age") == "0" { // ended at all (its checkpoints go at once)
			since = h.nowMs() + 1
		}
		args := []any{q.who.machineID, since}
		for _, id := range list {
			args = append(args, id)
		}
		ts := scanTasks(h.db.Query("SELECT "+taskCols+` FROM tasks_v1 WHERE state IN ('done', 'closed')
			AND claimed_by = ? AND updated < ?
			AND id IN (?`+strings.Repeat(", ?", len(list)-1)+`) ORDER BY num`, args...))
		writeJSON(w, 200, obj{"tasks": ts})
		return
	}
	ts := scanTasks(h.db.Query("SELECT "+taskCols+` FROM tasks_v1 WHERE state IN ('queued', 'running')
		AND `+onMachine("agent_id")+` ORDER BY num`, q.who.machineID))
	out := []taskView{}
	agents := map[string]agentView{}
	for _, t := range ts {
		if t.State == taskQueued {
			a, ok := agents[t.AgentID]
			if !ok {
				a, _ = h.agent(t.AgentID)
				agents[t.AgentID] = a
			}
			if ok, _ := h.pickable(t, a, q.who.machineID); !ok { // another of its computers takes it (teampool.go)
				continue
			}
			if ok, _ := h.runtimeGate(t, q.who.machineID, a.Runtime, false); ok { // held back by its runtime here: not offered
				out = append(out, t)
			}
		} else if t.ClaimedBy != nil && *t.ClaimedBy == q.who.machineID {
			out = append(out, t)
		}
	}
	writeJSON(w, 200, obj{"tasks": out, "asks": h.machineAsks(q.who.machineID)})
}

// contextMessages: the channel's latest messages the claim brings; the agent reads further itself (teamcontext.go).
const contextMessages = 6
const contextChars = 600

func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}

// v1TaskClaim: the machine takes a queued task (the first claim wins) and gets what the run needs: the task, the
// channel's purpose and latest messages, the thread, and the people's messages it has not seen yet. Claiming a task
// it already runs again (after the daemon restarted) is allowed.
func (h *Hub) v1TaskClaim(w http.ResponseWriter, q *request) {
	t, a, ok := h.machineTask(w, q)
	if !ok {
		return
	}
	mine := t.State == taskRunning && t.ClaimedBy != nil && *t.ClaimedBy == q.who.machineID
	if t.State != taskQueued && !mine {
		errJSON(w, 409, "任务现在是 "+t.State+"，不能认领")
		return
	}
	// claimed again by its own machine: a restart of the daemon (counted), unless it stopped the run to take up news
	// (a reply, an answer, a repository it asked for): that is the run going on, not dying
	if !h.mayRun(w, t, a, q.who.machineID, mine && !t.News) {
		return
	}
	fresh := h.unseen(t)
	thread := scanMessages(h.db.Query("SELECT "+messageCols+" FROM messages m WHERE m.id = ? OR m.thread_id = ? ORDER BY m.seq", t.ThreadID, t.ThreadID))
	var seen int64
	for _, m := range thread {
		seen = max(seen, m.Seq)
	}
	var woke *wake
	if t.Wait != nil {
		woke = t.Wait.Wake
	}
	cols := map[string]any{"state": taskRunning, "claimed_by": q.who.machineID, "seen_seq": seen, "step": "", "wait": nil, "news": 0}
	if !mine {
		cols["runs"] = t.Runs + 1
	}
	h.setTask(t.ID, cols)
	for _, m := range fresh { // the agent took them up: 👀 on each, the way a person would show they read it
		if m.Author.Kind == "user" {
			h.react(m.ID, member{"agent", a.ID}, "👀")
		}
	}
	recent := scanMessages(h.db.Query("SELECT "+messageCols+` FROM messages m WHERE m.channel_id = ? AND m.thread_id IS NULL
		ORDER BY m.seq DESC LIMIT ?`, t.ChannelID, contextMessages))
	for i, j := 0, len(recent)-1; i < j; i, j = i+1, j-1 {
		recent[i], recent[j] = recent[j], recent[i]
	}
	for i := range recent {
		recent[i].Text = clip(recent[i].Text, contextChars)
	}
	c, _ := h.channel(t.ChannelID)
	h.taskChanged(t.ID)
	t, _ = h.task(t.ID)
	people := map[string]string{}
	for _, m := range append(append([]messageView{}, thread...), recent...) {
		if m.Author.Kind == "user" {
			if u, ok := h.user(m.Author.ID); ok {
				people[u.ID] = u.Name + " (@" + u.Handle + ")"
			}
		} else if ag, ok := h.agent(m.Author.ID); ok {
			people[ag.ID] = ag.Name + " (@" + ag.Handle + ")"
		}
	}
	creator, _ := h.user(t.CreatedBy)
	writeJSON(w, 200, obj{"task": t, "agent": a, "channel": obj{"id": c.ID, "name": c.Name, "topic": c.Topic, "repo": c.Repo, "conventions": c.Conventions},
		"recent": recent, "thread": thread, "new": fresh, "names": people, "creator": creator, "resumed": mine,
		"wake": woke, "callback_url": h.callbackURL(q.r, h.callbackToken(t.ID)), "read_token": h.readToken(t.ID),
		"requester_preferences": h.preferences(t.CreatedBy), "memory_writable": h.memoryWritable(t, a),
		"agents": h.agentList(t, promptAgents), "checkpoint_files": h.checkpointFilesAllowed(q.who.machineID)})
}

// promptAgents: at most this many lines of `remi who` in the claim, for the start prompt's "who you can turn to".
const promptAgents = 10

// v1TaskReport: the machine says how the run goes. {step, session, branch} while it runs; {state, summary, decision}
// when the run ends; {pr} whenever the change request changes. The summary goes to the thread as the agent.
func (h *Hub) v1TaskReport(w http.ResponseWriter, q *request) {
	t, a, ok := h.machineTask(w, q)
	if !ok {
		return
	}
	var b struct {
		State    string        `json:"state"`
		Step     *string       `json:"step"`
		Summary  string        `json:"summary"`
		Session  *string       `json:"session"`
		Branch   *string       `json:"branch"`
		Decision *decisionView `json:"decision"`
		PR       *prView       `json:"pr"`
		// Acceptance: the agent's proposed criteria, kept only while people have written none
		Acceptance *string `json:"acceptance"`
		// Memory: the agent's memory.md as it wants it now (it learned something lasting)
		Memory *string `json:"memory"`
		// Outputs: results kept elsewhere (an external service), new or changed
		Outputs []outputReport `json:"outputs"`
		// Wait: with state waiting, what wakes it
		Wait *waitRequest `json:"wait"`
		// Result: confirmed | unconfirmed, whether the agent saw the outcome it worked for
		Result string `json:"result"`
		// Answer: with state review, the run changed nothing (no commits, PR, files or outside results): its summary is
		// the whole result, so the task is done without anyone's acceptance (a reply in the thread still goes on)
		Answer bool `json:"answer"`
		// Track: the agent claims the request as a task (it has to act on it), with a title of its own when it gives one
		Track bool   `json:"track"`
		Title string `json:"title"`
		// Reaction: the emoji the agent chose for the request as it read it; it takes the place of the 👀 put there at claim
		Reaction string `json:"reaction"`
		// Run: which run of the task this is (its runs when claimed). A final report of an earlier run is refused, so a
		// report the machine sends again (it kept it until the server took it) never lands twice.
		Run int64 `json:"run"`
		// Failure: with state blocked or failed, what kind of failure ended the run (teamhealth.go); with state waiting,
		// "quota": the runtime hit a usage limit, and the task waits for it to reset (teamquota.go)
		Failure string `json:"failure"`
		// RetryAt, Note: with failure quota, when the runtime said the limit resets (unix ms, 0: it did not say) and
		// what it said
		RetryAt int64  `json:"retry_at"`
		Note    string `json:"note"`
		// Usage: tokens this run used
		Usage *usageView `json:"usage"`
		// Evidence: with state review, how each acceptance criterion was verified (teamevidence.go)
		Evidence []evidenceView `json:"evidence"`
		// Align: with state align, what "done" will mean (teamalign.go)
		Align *alignReport `json:"align"`
	}
	if err := q.json(&b); err != nil {
		errJSON(w, 400, "bad json")
		return
	}
	if b.Memory != nil && h.memoryWritable(t, a) { // otherwise dropped: the run was told not to (teammemory.go)
		if m := clip(strings.TrimSpace(*b.Memory), memoryChars); m != a.Memory {
			h.must(h.db.Exec("UPDATE agents SET memory = ? WHERE id = ?", m, a.ID))
			a, _ = h.agent(a.ID)
			h.broadcastAgent(a)
		}
	}
	if len(b.Outputs) > 0 {
		h.applyOutputs(t.ID, b.Outputs)
	}
	if e := strings.TrimSpace(b.Reaction); isEmoji(e) {
		h.agentReacts(t, a.ID, e)
	}
	cols := map[string]any{}
	if b.Track && !t.Tracked {
		cols["tracked"] = 1
	}
	// the agent names the task once (its "task:" line), unless a person already did
	if title := trimmed(b.Title, 60); title != "" && !t.Titled {
		cols["title"], cols["titled"] = title, 1
	}
	if b.Acceptance != nil && t.Acceptance == "" {
		cols["acceptance"] = clip(strings.TrimSpace(*b.Acceptance), 4000)
	}
	if b.PR != nil {
		cols["pr"] = jsonOrNil(b.PR)
		if b.PR.State == "merged" && (t.State == taskReview || t.State == taskBlocked) {
			cols["state"] = taskDone
		}
	}
	if b.Session != nil {
		cols["session"] = trimmed(*b.Session, 200)
	}
	if b.Branch != nil {
		cols["branch"] = trimmed(*b.Branch, 200)
	}
	if b.State != "" || b.Step != nil {
		if t.State != taskRunning || t.ClaimedBy == nil || *t.ClaimedBy != q.who.machineID {
			errJSON(w, 409, "任务现在是 "+t.State+"，这次运行已经无效")
			return
		}
		if b.Run > 0 && b.Run != t.Runs {
			errJSON(w, 409, "这是任务的旧一次运行，已经无效")
			return
		}
	}
	if b.Usage != nil {
		cols["usage"] = jsonOrNil(t.Usage.add(*b.Usage))
	}
	if b.Step != nil {
		cols["step"] = clip(strings.TrimSpace(*b.Step), 200)
	}
	if b.State != "" {
		if b.State == "align" {
			d, msg, code := h.alignDecision(t, b.Align)
			if d == nil {
				errJSON(w, code, msg)
				return
			}
			b.State, b.Decision = taskNeedsDecision, d
			cols["aligned"], cols["tracked"], cols["_needs"] = 1, 1, "align"
		}
		if !reportStates[b.State] {
			errJSON(w, 400, "state 只能是 review、needs_decision、blocked、failed 或 waiting")
			return
		}
		quota := b.State == taskWaiting && b.Failure == "quota"
		if quota {
			s := h.runtimeFailed(q.who.machineID, a.Runtime, "quota", b.RetryAt, b.Note)
			cols["wait"] = jsonOrNil(quotaWait(q.who.machineID, a.Runtime, s, h.nowMs()))
		} else if b.State == taskWaiting {
			wt, msg := h.newWait(b.Wait)
			if wt == nil {
				errJSON(w, 400, msg)
				return
			}
			cols["wait"] = jsonOrNil(wt)
		}
		if b.Result == "confirmed" || b.Result == "unconfirmed" {
			cols["result"] = b.Result
		}
		h.runEnded(t, a, q.who.machineID, b.State, b.Failure, b.RetryAt, b.Note, cols)
		state := b.State
		summary := trimmed(b.Summary, 8000)
		cols["summary"], cols["step"] = summary, ""
		if state == taskNeedsDecision {
			if b.Decision == nil || strings.TrimSpace(b.Decision.Question) == "" {
				errJSON(w, 400, "needs_decision 要带 decision.question")
				return
			}
			if b.Decision.Kind == "align" {
				cols["decision"] = jsonOrNil(b.Decision) // made by alignDecision
			} else {
				d := decisionView{Question: trimmed(b.Decision.Question, 300), Recommendation: trimmed(b.Decision.Recommendation, 100)}
				for _, o := range b.Decision.Options {
					if o = trimmed(o, 300); o != "" && len(d.Options) < 6 {
						d.Options = append(d.Options, o)
					}
				}
				cols["decision"] = jsonOrNil(d)
			}
		}
		text := summary
		if state == taskNeedsDecision {
			text = strings.TrimSpace(summary + "\n\n" + b.Decision.Question)
			if b.Decision.Kind == "align" {
				text = strings.TrimSpace(summary + "\n\n" + alignText(*b.Decision))
			}
		}
		text = h.callHandler(t, state, text)
		if text != "" {
			h.insertMessage(t.ChannelID, &t.ThreadID, member{"agent", a.ID}, text)
		}
		if state == taskReview {
			criteria := t.Acceptance
			if c, ok := cols["acceptance"].(string); ok {
				criteria = c
			}
			cols["evidence"] = jsonOrNil(fillEvidence(criteria, b.Evidence))
		}
		if state == taskReview && t.Mandate != nil && t.Mandate.Delegated {
			state = taskDone // delivered back to the agent that delegated it: it checks it, not a person (teamdelegate.go)
		} else if state == taskReview && b.Answer && b.Result != "unconfirmed" && t.PR == nil && t.Handler == "" && !proposedHandoff(t) && !h.delegated(t) {
			state = taskDone
		} else if state == taskReview || (state == taskWaiting && !quota) {
			cols["tracked"] = 1 // something to accept or to wait for: people track it
		}
		if t.News {
			state = taskQueued // news came while it ran (and the machine did not resume it with it): the next run takes it
		}
		cols["state"] = state
	}
	if len(cols) > 0 {
		h.setTask(t.ID, cols)
	}
	if len(cols) > 0 || len(b.Outputs) > 0 {
		h.taskChanged(t.ID)
	}
	if cols["state"] == taskReview || cols["state"] == taskDone {
		h.delegatesDropped(t.ID) // delivered: what it delegated and is not back yet is not wanted any more
	}
	if cols["state"] == taskWaiting && b.Wait != nil && b.Wait.How == "delegates" {
		h.checkReceipt(t.ID) // everything it delegated may be back already
	}
	t, _ = h.task(t.ID)
	writeJSON(w, 200, h.taskOut(q, t))
}

// proposedHandoff: a handoff card on the task still waits for its click (the task is not over before that).
func proposedHandoff(t taskView) bool {
	for _, x := range t.Handoffs {
		if x.State == "proposed" {
			return true
		}
	}
	return false
}

// callHandler: when a task the request named someone to take stops for them (to accept, to decide), its message
// @-s them, so they hear of it whether or not the agent thought to. Their 待你处理 has it too (v1Inbox).
func (h *Hub) callHandler(t taskView, state, text string) string {
	if t.Handler == "" || (state != taskReview && state != taskNeedsDecision) {
		return text
	}
	u, ok := h.user(t.Handler)
	if !ok {
		return text
	}
	at := "@" + u.Handle
	for _, m := range h.mentions(text) {
		if m.Kind == "user" && m.ID == u.ID {
			return text // the agent already did
		}
	}
	if text == "" {
		if state == taskReview {
			return at + " 请你验收"
		}
		return at + " 请你决定"
	}
	return at + " " + text
}

// insertMessage posts a message (no checks) and sends it out.
func (h *Hub) insertMessage(channelID string, thread *string, author member, text string) messageView {
	var th any
	if thread != nil {
		th = *thread
	}
	mentions, _ := json.Marshal(h.mentions(text))
	id := newID("msg_")
	h.must(h.db.Exec(`INSERT INTO messages (id, channel_id, thread_id, author_kind, author_id, text, mentions, attachments, created)
		VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?)`, id, channelID, th, author.Kind, author.ID, text, string(mentions), h.nowMs()))
	m, _ := h.message(id)
	h.broadcastChannel(channelID, obj{"type": "message", "message": m})
	return m
}

// v1GitlabHook: Ant Code (GitLab-based) tells us a PR (merge request) changed: its state and pipeline reach the task
// whose branch it is. Push and TagPush events are acknowledged and ignored.
func (h *Hub) v1GitlabHook(w http.ResponseWriter, q *request) {
	secret := h.cfg.GitWebhookSecret
	if secret == "" || subtle.ConstantTimeCompare([]byte(q.r.Header.Get("X-Gitlab-Token")), []byte(secret)) != 1 {
		errJSON(w, 401, "unauthorized")
		return
	}
	var b struct {
		Kind  string `json:"object_kind"`
		Attrs struct {
			IID          int64  `json:"iid"`
			SourceBranch string `json:"source_branch"`
			State        string `json:"state"`
			URL          string `json:"url"`
			Title        string `json:"title"`
			Ref          string `json:"ref"`
			Status       string `json:"status"`
			Action       string `json:"action"`
			TargetBranch string `json:"target_branch"`
		} `json:"object_attributes"`
		Ref     string `json:"ref"` // push
		After   string `json:"after"`
		Commits []struct {
			Message string `json:"message"`
			URL     string `json:"url"`
		} `json:"commits"`
		MR *struct {
			IID          int64  `json:"iid"`
			SourceBranch string `json:"source_branch"`
		} `json:"merge_request"`
		Project struct {
			Path   string `json:"path_with_namespace"`
			WebURL string `json:"web_url"`
		} `json:"project"`
	}
	if err := q.json(&b); err != nil {
		errJSON(w, 400, "bad json")
		return
	}
	remote := normRemote(b.Project.WebURL)
	branch, state, checks := "", "", ""
	switch b.Kind {
	case "push": // triggers (teamtriggers.go); a deleted branch pushes all zeros
		pushed := strings.TrimPrefix(b.Ref, "refs/heads/")
		n := 0
		if strings.HasPrefix(b.Ref, "refs/heads/") && strings.Trim(b.After, "0") != "" {
			extra := "推送到 " + pushed
			if k := len(b.Commits); k > 0 {
				extra += "：" + oneLine(b.Commits[k-1].Message) + "\n" + b.Commits[k-1].URL
			}
			n = h.gitTriggers("push", remote, pushed, extra)
		}
		writeJSON(w, 200, obj{"ok": true, "fired": n})
		return
	case "merge_request":
		branch = b.Attrs.SourceBranch
		switch b.Attrs.State {
		case "merged":
			state = "merged"
		case "closed":
			state = "closed"
		default:
			state = "open"
		}
	case "pipeline":
		branch = b.Attrs.Ref
		if b.MR != nil && b.MR.SourceBranch != "" {
			branch = b.MR.SourceBranch
		}
		switch b.Attrs.Status {
		case "success":
			checks = "success"
		case "failed", "canceled":
			checks = "failure"
		default:
			checks = "pending"
		}
	default:
		writeJSON(w, 200, obj{"ok": true, "ignored": b.Kind})
		return
	}
	ev := gitEvent{Kind: b.Kind, Project: trimmed(b.Project.Path, 120), Branch: trimmed(branch, 120), Number: b.Attrs.IID, State: state + checks}
	if b.MR != nil && ev.Number == 0 {
		ev.Number = b.MR.IID
	}
	if !strings.HasPrefix(branch, "agent/") {
		h.noteGitEvent(ev)
		n := 0
		if b.Kind == "merge_request" && (b.Attrs.Action == "open" || b.Attrs.Action == "reopen") {
			n = h.gitTriggers("pr", remote, b.Attrs.TargetBranch, fmt.Sprintf("PR !%d %s\n%s", b.Attrs.IID, b.Attrs.Title, b.Attrs.URL))
		}
		writeJSON(w, 200, obj{"ok": true, "ignored": "not a task branch", "fired": n})
		return
	}
	ts := scanTasks(h.db.Query("SELECT "+taskCols+" FROM tasks_v1 WHERE branch = ? ORDER BY num DESC LIMIT 1", branch))
	if len(ts) == 0 {
		h.noteGitEvent(ev)
		writeJSON(w, 200, obj{"ok": true, "ignored": "no task"})
		return
	}
	t := ts[0]
	ev.Task = t.ID
	h.noteGitEvent(ev)
	pr := prView{Provider: "gitlab", State: "open", Checks: "none", Repo: b.Project.Path}
	if t.PR != nil {
		pr = *t.PR
	}
	if b.Kind == "merge_request" {
		pr.State, pr.Number, pr.Title = state, b.Attrs.IID, b.Attrs.Title
		if b.Attrs.URL != "" {
			pr.URL = b.Attrs.URL
		}
	} else {
		pr.Checks = checks
	}
	cols := map[string]any{"pr": jsonOrNil(pr)}
	if pr.State == "merged" && (t.State == taskReview || t.State == taskBlocked) {
		cols["state"] = taskDone
	}
	h.setTask(t.ID, cols)
	h.taskChanged(t.ID)
	writeJSON(w, 200, obj{"ok": true, "task": t.ID})
}

// agentReacts puts the agent's chosen emoji on the messages it took up in this task (those with its 👀), in place of the
// 👀; with none, on the thread's latest message from a person.
func (h *Hub) agentReacts(t taskView, agentID, emoji string) {
	var ids []string
	rows, err := h.db.Query(`SELECT message_id FROM reactions WHERE author_kind = 'agent' AND author_id = ? AND emoji = '👀'
		AND message_id IN (SELECT id FROM messages WHERE id = ? OR thread_id = ?)`, agentID, t.ThreadID, t.ThreadID)
	if err != nil {
		panic(err)
	}
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
	if len(ids) == 0 {
		var id string
		if h.db.QueryRow(`SELECT id FROM messages WHERE (id = ? OR thread_id = ?) AND author_kind = 'user' ORDER BY seq DESC LIMIT 1`,
			t.ThreadID, t.ThreadID).Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	for _, id := range ids {
		if emoji != "👀" {
			h.must(h.db.Exec("DELETE FROM reactions WHERE message_id = ? AND author_kind = 'agent' AND author_id = ? AND emoji = '👀'", id, agentID))
		}
		h.react(id, member{"agent", agentID}, emoji)
		if m, ok := h.message(id); ok { // the 👀 went even when the emoji was already there
			h.broadcastChannel(m.ChannelID, obj{"type": "message_edited", "message": m})
		}
	}
}

// isEmoji: one emoji (with its modifiers and joiners), no letters, digits or spaces.
func isEmoji(s string) bool {
	if s == "" || utf8.RuneCountInString(s) > 8 {
		return false
	}
	for i, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsSpace(r) || (i == 0 && r < 0x2000) {
			return false
		}
	}
	return true
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
