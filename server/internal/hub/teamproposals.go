package hub

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Proposals (design step 6 「长期职责」, 设计四). An agent that finds something worth doing does not do it: it proposes
// it (`remi propose`). A proposal is not a task: no board, no acceptance; the run goes on or ends. It goes to the
// person the run is for (who set up the trigger, or who asked for the task), and waits for that person's time of day:
// what came in since is put on one card in their inbox (a batch), numbered, each with 做 / 不做, and a box that takes
// "1 3" (do those, leave the rest) or "1 3 其余不做". 做 makes a normal task in that person's name with the proposal's
// plan as its request and acceptance, already aligned (they read the plan and said yes). An untouched proposal goes
// away after a week.
//
// One thing should not come back again and again: a newer proposal with the same key (the agent's short word for
// it) replaces an unanswered older one; a key the person declined is refused for 30 days; a key whose task is still
// open is refused. Urgent proposals come at once, on a card of their own: at most 2 per agent a day (more go into the
// next batch), held during the person's quiet hours. A batch card is one call on the person (a decision, in the
// metrics), whatever it holds; so is each urgent one.

const proposalsSchema = `
CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL, trigger_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, why TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL,
  key TEXT NOT NULL DEFAULT '', urgent INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, batch_id TEXT NOT NULL DEFAULT '',
  num INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, answered INTEGER NOT NULL DEFAULT 0,
  result_task TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS proposals_user ON proposals (user_id, state);
CREATE INDEX IF NOT EXISTS proposals_key ON proposals (agent_id, key);
CREATE TABLE IF NOT EXISTS proposal_batches (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, at INTEGER NOT NULL, urgent INTEGER NOT NULL DEFAULT 0,
  private INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS proposal_batches_user ON proposal_batches (user_id, at);
`

// A proposal's states: waiting (not on a card yet), open (on a card), accepted, declined, replaced (by a newer one
// with its key), expired.
const (
	propWaiting  = "waiting"
	propOpen     = "open"
	propAccepted = "accepted"
	propDeclined = "declined"
	propReplaced = "replaced"
	propExpired  = "expired"
)

const (
	maxProposalTitle  = 80
	maxProposalWhy    = 500
	maxProposalPlan   = 1000
	proposalsPerRun   = 5
	proposalsWaiting  = 20 // unanswered, per agent and person
	urgentPerDay      = 2  // per agent
	declinedFor       = 30 * 24 * time.Hour
	proposalsLast     = 7 * 24 * time.Hour
	defaultDigestAt   = "09:30"
	defaultDigestAt2  = "14:00"
	defaultQuietHours = "22:00-08:00"
)

var proposalKeyRE = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,39}$`)

type proposalView struct {
	ID         string `json:"id"`
	ChannelID  string `json:"channel_id"`
	AgentID    string `json:"agent_id"`
	TaskID     string `json:"task_id"`
	TriggerID  string `json:"trigger_id,omitempty"`
	Title      string `json:"title"`
	Why        string `json:"why"`
	Plan       string `json:"plan"`
	Key        string `json:"key,omitempty"`
	Urgent     bool   `json:"urgent"`
	State      string `json:"state"`
	Num        int64  `json:"num"`
	Created    int64  `json:"created"`
	ResultTask string `json:"result_task,omitempty"`
	userID     string
	batchID    string
}

const proposalCols = "id, user_id, channel_id, agent_id, task_id, trigger_id, title, why, plan, key, urgent, state, batch_id, num, created, result_task"

func scanProposals(rows *sql.Rows, err error) []proposalView {
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []proposalView{}
	for rows.Next() {
		var p proposalView
		if err := rows.Scan(&p.ID, &p.userID, &p.ChannelID, &p.AgentID, &p.TaskID, &p.TriggerID, &p.Title, &p.Why, &p.Plan, &p.Key, &p.Urgent,
			&p.State, &p.batchID, &p.Num, &p.Created, &p.ResultTask); err != nil {
			panic(err)
		}
		out = append(out, p)
	}
	return out
}

func (h *Hub) proposal(id string) (proposalView, bool) {
	ps := scanProposals(h.db.Query("SELECT "+proposalCols+" FROM proposals WHERE id = ?", id))
	if len(ps) == 0 {
		return proposalView{}, false
	}
	return ps[0], true
}

// ---------------------------------------------------------------- when they come: 「提案什么时候给我」

// digestView: a person's own setting. every: daily (each workday at At) | twice (each workday at At and At2) |
// weekly (Mondays at At); quiet: "22:00-08:00" holds urgent ones meanwhile ("" none). The server's time zone.
type digestView struct {
	Every string `json:"every"`
	At    string `json:"at"`
	At2   string `json:"at2"`
	Quiet string `json:"quiet"`
}

var digestClockRE = regexp.MustCompile(`^([01]?\d|2[0-3]):([0-5]\d)$`)

func defaultDigest() digestView {
	return digestView{Every: "daily", At: defaultDigestAt, At2: defaultDigestAt2, Quiet: defaultQuietHours}
}

func (h *Hub) digestOf(userID string) digestView {
	d := defaultDigest()
	var s string
	_ = h.db.QueryRow("SELECT digest FROM users WHERE id = ?", userID).Scan(&s)
	if s != "" {
		_ = json.Unmarshal([]byte(s), &d)
	}
	return d
}

// checkDigest: the setting as given, made whole (empty times take the defaults), or why not.
func checkDigest(d digestView) (digestView, string) {
	if d.Every == "" {
		d.Every = "daily"
	}
	if d.Every != "daily" && d.Every != "twice" && d.Every != "weekly" {
		return d, "every 只能是 daily、twice 或 weekly"
	}
	if d.At == "" {
		d.At = defaultDigestAt
	}
	if d.At2 == "" {
		d.At2 = defaultDigestAt2
	}
	if !digestClockRE.MatchString(d.At) || !digestClockRE.MatchString(d.At2) {
		return d, "时间写成 9:30 这样"
	}
	if d.Quiet != "" {
		a, b, ok := strings.Cut(d.Quiet, "-")
		if !ok || !digestClockRE.MatchString(a) || !digestClockRE.MatchString(b) {
			return d, "安静时段写成 22:00-08:00 这样"
		}
	}
	return d, ""
}

func clockOn(day time.Time, hhmm string) time.Time {
	m := digestClockRE.FindStringSubmatch(hhmm)
	if m == nil {
		return time.Time{}
	}
	hh, _ := strconv.Atoi(m[1])
	mm, _ := strconv.Atoi(m[2])
	return time.Date(day.Year(), day.Month(), day.Day(), hh, mm, 0, 0, day.Location())
}

// lastSlot: the latest of the person's times at or before now (zero if none within a week and a day).
func lastSlot(d digestView, now time.Time) time.Time {
	var best time.Time
	for i := 0; i <= 8; i++ {
		day := now.AddDate(0, 0, -i)
		wd := day.Weekday()
		if d.Every == "weekly" && wd != time.Monday || d.Every != "weekly" && (wd == time.Saturday || wd == time.Sunday) {
			continue
		}
		times := []string{d.At}
		if d.Every == "twice" {
			times = append(times, d.At2)
		}
		for _, x := range times {
			if s := clockOn(day, x); !s.After(now) && s.After(best) {
				best = s
			}
		}
	}
	return best
}

// nextSlot: the first of the person's times after now (for telling the agent when it arrives).
func nextSlot(d digestView, now time.Time) time.Time {
	for i := 0; i <= 8; i++ {
		day := now.AddDate(0, 0, i)
		wd := day.Weekday()
		if d.Every == "weekly" && wd != time.Monday || d.Every != "weekly" && (wd == time.Saturday || wd == time.Sunday) {
			continue
		}
		times := []string{d.At}
		if d.Every == "twice" {
			times = append(times, d.At2)
		}
		sort.Strings(times)
		for _, x := range times {
			if s := clockOn(day, x); s.After(now) {
				return s
			}
		}
	}
	return time.Time{}
}

// quietNow: now is in the person's quiet hours (22:00-08:00 wraps midnight).
func quietNow(d digestView, now time.Time) bool {
	a, b, ok := strings.Cut(d.Quiet, "-")
	if !ok {
		return false
	}
	from, to := clockOn(now, a), clockOn(now, b)
	if from.IsZero() || to.IsZero() || from.Equal(to) {
		return false
	}
	if from.Before(to) {
		return !now.Before(from) && now.Before(to)
	}
	return !now.Before(from) || now.Before(to)
}

// ---------------------------------------------------------------- the agent proposes

// v1AgentPropose: `remi propose [--key KEY] [--urgent] TITLE --why WHY --plan PLAN` (form fields title, why, plan,
// key, urgent; or the same as JSON).
func (h *Hub) v1AgentPropose(w http.ResponseWriter, q *request) {
	t, a, ok := h.reader(w, q)
	if !ok {
		return
	}
	var b struct {
		Title  string `json:"title"`
		Why    string `json:"why"`
		Plan   string `json:"plan"`
		Key    string `json:"key"`
		Urgent bool   `json:"urgent"`
	}
	if strings.HasPrefix(q.r.Header.Get("content-type"), "application/json") {
		_ = q.json(&b)
	} else if v, err := url.ParseQuery(string(q.body)); err == nil {
		b.Title, b.Why, b.Plan, b.Key = v.Get("title"), v.Get("why"), v.Get("plan"), v.Get("key")
		b.Urgent = v.Get("urgent") == "1" || v.Get("urgent") == "true"
	}
	title, why, plan := trimmed(oneLine(b.Title), maxProposalTitle), trimmed(b.Why, maxProposalWhy), trimmed(b.Plan, maxProposalPlan)
	key := strings.ToLower(strings.TrimSpace(b.Key))
	switch {
	case title == "" || plan == "":
		errJSON(w, 400, "提案要有标题（TITLE）和打算怎么做（--plan）")
		return
	case key != "" && !proposalKeyRE.MatchString(key):
		errJSON(w, 400, "--key 是一个短词：小写字母、数字、- . _，最多 40 个字符，比如 ci-main-red")
		return
	}
	to := t.CreatedBy
	now := h.nowMs()
	if h.count("SELECT COUNT(*) FROM proposals WHERE task_id = ?", t.ID) >= proposalsPerRun {
		errJSON(w, 429, fmt.Sprintf("一次运行最多提 %d 个提案；把最要紧的留下，其余写进结果", proposalsPerRun))
		return
	}
	if key != "" {
		if h.count("SELECT COUNT(*) FROM proposals WHERE agent_id = ? AND key = ? AND user_id = ? AND state = ? AND answered > ?",
			a.ID, key, to, propDeclined, now-declinedFor.Milliseconds()) > 0 {
			errJSON(w, 409, "这件事已经被拒绝过（30 天内不再提）："+key)
			return
		}
		var open string
		_ = h.db.QueryRow(`SELECT p.result_task FROM proposals p JOIN tasks_v1 t ON t.id = p.result_task
			WHERE p.agent_id = ? AND p.key = ? AND p.state = ? AND t.state NOT IN ('done', 'closed') LIMIT 1`, a.ID, key, propAccepted).Scan(&open)
		if open != "" {
			errJSON(w, 409, "这件事已经在做："+open)
			return
		}
	}
	replaced := int64(0)
	if key != "" {
		replaced = h.count("SELECT COUNT(*) FROM proposals WHERE agent_id = ? AND key = ? AND user_id = ? AND state IN (?, ?)", a.ID, key, to, propWaiting, propOpen)
		h.must(h.db.Exec("UPDATE proposals SET state = ?, answered = ? WHERE agent_id = ? AND key = ? AND user_id = ? AND state IN (?, ?)",
			propReplaced, now, a.ID, key, to, propWaiting, propOpen))
	}
	if h.count("SELECT COUNT(*) FROM proposals WHERE agent_id = ? AND user_id = ? AND state IN (?, ?)", a.ID, to, propWaiting, propOpen) >= proposalsWaiting {
		errJSON(w, 429, fmt.Sprintf("给这个人的提案还有 %d 个没回答，先不再提", proposalsWaiting))
		return
	}
	note := ""
	urgent := b.Urgent
	if urgent {
		y, m, d := h.now().Date()
		day := time.Date(y, m, d, 0, 0, 0, 0, h.now().Location()).UnixMilli()
		if h.count("SELECT COUNT(*) FROM proposals WHERE agent_id = ? AND urgent = 1 AND created >= ?", a.ID, day) >= urgentPerDay {
			urgent = false
			note = fmt.Sprintf("今天的紧急提案用完了（每天 %d 条），这条归入下一批。", urgentPerDay)
		}
	}
	trigger := ""
	if t.Mandate != nil {
		trigger = t.Mandate.Trigger
	}
	id := newID("prp_")
	h.must(h.db.Exec(`INSERT INTO proposals (id, user_id, channel_id, agent_id, task_id, trigger_id, title, why, plan, key, urgent, state, created)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, to, t.ChannelID, a.ID, t.ID, trigger, title, why, plan, key, boolInt(urgent), propWaiting, now))
	h.must(h.db.Exec("UPDATE trigger_runs SET outcome = ?, note = ? WHERE task_id = ? AND outcome = ?", runProposed, clip(title, 120), t.ID, runRunning))
	who := "@" + h.handleOf(to)
	h.insertMessage(t.ChannelID, &t.ThreadID, member{"agent", a.ID}, "提了一个案："+title+"（等 "+who+" 在提案卡片里决定做不做）")
	d := h.digestOf(to)
	when := ""
	switch {
	case urgent && quietNow(d, h.now()):
		when = "it is urgent, and reaches " + who + " when their quiet hours end"
	case urgent:
		h.deliverProposals(to, []string{id}, true)
		when = "it is urgent: " + who + " has it now"
	default:
		when = "it reaches " + who + " with their next batch, " + nextSlot(d, h.now()).Format("Mon 15:04")
	}
	if replaced > 0 {
		when += "; it replaces the unanswered one with the same key"
	}
	writeText(w, "proposed: "+id+"; "+when+".\n"+strings.TrimSpace(note+" A proposal is not done by you: the person decides.")+"\n")
}

func (h *Hub) handleOf(userID string) string {
	if u, ok := h.user(userID); ok {
		return u.Handle
	}
	return "?"
}

// ---------------------------------------------------------------- batches

type proposalBatchView struct {
	ID        string         `json:"id"`
	At        int64          `json:"at"`
	Urgent    bool           `json:"urgent"`
	Proposals []proposalView `json:"proposals"`
}

// deliverProposals: these proposals (all one person's) go onto a new card now, numbered by channel, agent and age.
func (h *Hub) deliverProposals(userID string, ids []string, urgent bool) {
	if len(ids) == 0 {
		return
	}
	marks := strings.Repeat(", ?", len(ids)-1)
	args := []any{}
	for _, id := range ids {
		args = append(args, id)
	}
	ps := scanProposals(h.db.Query("SELECT "+proposalCols+" FROM proposals WHERE id IN (?"+marks+") ORDER BY channel_id, agent_id, created, rowid", args...))
	now := h.nowMs()
	batch := newID("pb_")
	private := 1
	for _, p := range ps {
		if h.count("SELECT COUNT(*) FROM channels WHERE id = ? AND private = 1", p.ChannelID) == 0 {
			private = 0
		}
	}
	h.must(h.db.Exec("INSERT INTO proposal_batches (id, user_id, at, urgent, private) VALUES (?, ?, ?, ?, ?)", batch, userID, now, boolInt(urgent), private))
	for i, p := range ps {
		h.must(h.db.Exec("UPDATE proposals SET state = ?, batch_id = ?, num = ?, delivered = ? WHERE id = ?", propOpen, batch, i+1, now, p.ID))
	}
	h.proposalsChanged(userID)
}

func (h *Hub) proposalsChanged(userID string) {
	b, _ := json.Marshal(obj{"type": "proposals"})
	h.socks.send("u:"+userID, b)
}

// tickProposals: a week-old proposal goes away; urgent ones outside quiet hours come now; at a person's time, what
// came in before it goes onto one card. Tick calls it (with h.mu held).
func (h *Hub) tickProposals() {
	now := h.now()
	ms := now.UnixMilli()
	old := ms - proposalsLast.Milliseconds()
	var gone []string
	rows, err := h.db.Query("SELECT DISTINCT user_id FROM proposals WHERE state IN (?, ?) AND created < ?", propWaiting, propOpen, old)
	if err != nil {
		panic(err)
	}
	for rows.Next() {
		var u string
		_ = rows.Scan(&u)
		gone = append(gone, u)
	}
	rows.Close()
	if len(gone) > 0 {
		h.must(h.db.Exec("UPDATE proposals SET state = ?, answered = ? WHERE state IN (?, ?) AND created < ?", propExpired, ms, propWaiting, propOpen, old))
		for _, u := range gone {
			h.proposalsChanged(u)
		}
	}
	waiting := scanProposals(h.db.Query("SELECT "+proposalCols+" FROM proposals WHERE state = ? ORDER BY user_id, created, rowid", propWaiting))
	byUser := map[string][]proposalView{}
	var users []string
	for _, p := range waiting {
		if _, ok := byUser[p.userID]; !ok {
			users = append(users, p.userID)
		}
		byUser[p.userID] = append(byUser[p.userID], p)
	}
	for _, u := range users {
		d := h.digestOf(u)
		quiet := quietNow(d, now)
		slot := lastSlot(d, now).UnixMilli()
		var due []string
		for _, p := range byUser[u] {
			switch {
			case p.Urgent && !quiet:
				h.deliverProposals(u, []string{p.ID}, true)
			case !p.Urgent && p.Created < slot:
				due = append(due, p.ID)
			}
		}
		h.deliverProposals(u, due, false)
	}
}

// myBatches: the cards in this person's inbox: open proposals in channels they can still read, by card.
func (h *Hub) myBatches(userID string) []proposalBatchView {
	ps := scanProposals(h.db.Query("SELECT "+proposalCols+" FROM proposals WHERE user_id = ? AND state = ? ORDER BY batch_id, num", userID, propOpen))
	by := map[string]*proposalBatchView{}
	var order []string
	for _, p := range ps {
		if !h.userCanRead(userID, p.ChannelID) {
			continue // left a private channel: its proposals left the card
		}
		b, ok := by[p.batchID]
		if !ok {
			b = &proposalBatchView{ID: p.batchID}
			_ = h.db.QueryRow("SELECT at, urgent FROM proposal_batches WHERE id = ?", p.batchID).Scan(&b.At, &b.Urgent)
			by[p.batchID] = b
			order = append(order, p.batchID)
		}
		b.Proposals = append(b.Proposals, p)
	}
	out := []proposalBatchView{}
	for _, id := range order {
		out = append(out, *by[id])
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At > out[j].At })
	return out
}

// ---------------------------------------------------------------- the person answers

// answerProposal: 做 makes the task (in the person's name, the plan as its request and acceptance, aligned already);
// 不做 remembers the key. Returns the task, or why not.
func (h *Hub) answerProposal(p proposalView, me string, do bool) (string, string) {
	now := h.nowMs()
	if !do {
		h.must(h.db.Exec("UPDATE proposals SET state = ?, answered = ? WHERE id = ?", propDeclined, now, p.ID))
		return "", ""
	}
	a, ok := h.agent(p.AgentID)
	c, okc := h.channel(p.ChannelID)
	if !ok || !okc || c.Archived {
		return "", "这个 Agent 或频道已经不在了"
	}
	joined := false
	if !h.isMember(c.ID, "agent", a.ID) {
		if a.Dispatch != "team" {
			return "", "@" + a.Handle + " 已经不在 #" + c.Name
		}
		h.addMember(c.ID, member{"agent", a.ID})
		h.channelChanged(c.ID)
		joined = true
	}
	m := h.insertMessage(c.ID, nil, member{"user", me}, "@"+a.Handle+" 按提案做："+p.Title+"\n\n"+p.Plan)
	id := h.createTaskWith(m, m.ID, a.ID, joined, true, taskOrigin{Acceptance: p.Plan})
	if id == "" {
		return "", "没能开任务"
	}
	h.must(h.db.Exec("UPDATE tasks_v1 SET aligned = 1 WHERE id = ?", id)) // they read the plan and said yes: that was the alignment
	h.must(h.db.Exec("UPDATE proposals SET state = ?, answered = ?, result_task = ? WHERE id = ?", propAccepted, now, id, p.ID))
	h.taskChanged(id)
	return id, ""
}

// v1ProposalAnswer: {do}: one proposal on one's own card.
func (h *Hub) v1ProposalAnswer(w http.ResponseWriter, q *request) {
	me := q.who.userID
	p, ok := h.proposal(q.r.PathValue("id"))
	if !ok || p.userID != me || !h.userCanRead(me, p.ChannelID) {
		errJSON(w, 404, "没有这个提案")
		return
	}
	var b struct {
		Do *bool `json:"do"`
	}
	_ = q.json(&b)
	if b.Do == nil {
		errJSON(w, 400, "做还是不做")
		return
	}
	if p.State != propOpen {
		errJSON(w, 409, "这个提案已经处理过了")
		return
	}
	task, why := h.answerProposal(p, me, *b.Do)
	if why != "" {
		errJSON(w, 409, why)
		return
	}
	h.proposalsChanged(me)
	writeJSON(w, 200, obj{"task": task, "batches": h.myBatches(me)})
}

var restNoRE = regexp.MustCompile(`(?i)(其余|其他|剩下的?)(都)?不做|rest\s*no|others?\s*no`)
var numRE = regexp.MustCompile(`\d+`)

// v1ProposalBatchAnswer: {text}: "1 3" does those and leaves the rest; "1 3 其余不做" declines the rest of the card.
func (h *Hub) v1ProposalBatchAnswer(w http.ResponseWriter, q *request) {
	me := q.who.userID
	batch := q.r.PathValue("id")
	var owner string
	if h.db.QueryRow("SELECT user_id FROM proposal_batches WHERE id = ?", batch).Scan(&owner) != nil || owner != me {
		errJSON(w, 404, "没有这张卡片")
		return
	}
	var b struct {
		Text string `json:"text"`
	}
	_ = q.json(&b)
	open := map[int64]proposalView{}
	for _, p := range scanProposals(h.db.Query("SELECT "+proposalCols+" FROM proposals WHERE batch_id = ? AND state = ?", batch, propOpen)) {
		if h.userCanRead(me, p.ChannelID) {
			open[p.Num] = p
		}
	}
	var nums []int64
	seen := map[int64]bool{}
	for _, s := range numRE.FindAllString(b.Text, -1) {
		n, _ := strconv.ParseInt(s, 10, 64)
		if _, ok := open[n]; !ok {
			errJSON(w, 400, fmt.Sprintf("卡片上没有第 %d 条（或已经处理过）", n))
			return
		}
		if !seen[n] {
			seen[n] = true
			nums = append(nums, n)
		}
	}
	rest := restNoRE.MatchString(b.Text)
	if len(nums) == 0 && !rest {
		errJSON(w, 400, "写要做的编号，比如 1 3；加「其余不做」把剩下的都拒掉")
		return
	}
	type done struct {
		Num  int64  `json:"num"`
		Task string `json:"task,omitempty"`
		Err  string `json:"error,omitempty"`
	}
	out := []done{}
	for _, n := range nums {
		task, why := h.answerProposal(open[n], me, true)
		out = append(out, done{n, task, why})
	}
	declined := 0
	if rest {
		for n, p := range open {
			if !seen[n] {
				_, _ = h.answerProposal(p, me, false)
				declined++
			}
		}
	}
	h.proposalsChanged(me)
	writeJSON(w, 200, obj{"done": out, "declined": declined, "batches": h.myBatches(me)})
}

// proposalCalls: the cards that reached people since `since` (each one call, a decision): this person's, and the
// team's (cards of private channels only left out).
func (h *Hub) proposalCalls(since int64, userID string) (mine, team int) {
	rows, err := h.db.Query("SELECT user_id, private FROM proposal_batches WHERE at >= ?", since)
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	for rows.Next() {
		var u string
		var private bool
		_ = rows.Scan(&u, &private)
		if u == userID {
			mine++
		}
		if !private {
			team++
		}
	}
	return mine, team
}
