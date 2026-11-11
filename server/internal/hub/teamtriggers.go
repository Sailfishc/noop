package hub

import (
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Triggers (the collaboration plan, stage 3): work that starts by itself. A person in a channel sets one up for an
// agent there: on a schedule ("weekdays 9:00"), when a pull request is opened in a repository, or on a push to it.
// It is confirmed once, by the agent's owner when the agent asks for that, and then each firing is a task at once (no
// "确认开工" every morning), in the name of the person who set it up, said in the channel as them with a ⚡.
// Branches of agents' own tasks (agent/…) never fire a trigger: agents don't set each other off.
//
// It does not pile up: a schedule is skipped while the task it opened last is still queued or running (counted; if
// that task sits queued for half an hour, no machine is taking it, and the person who set it up is told once). A task
// that waits (on CI, on a person) or ended badly does not hold the next one back: otherwise a routine stalls for hours
// unseen (upstream noop #137, #158). A pull request or a push is never skipped for that: each is a different thing to
// look at. Every trigger fires at most max_per_day times a day (default 10, changeable), which keeps a busy repository
// from flooding the channel. Each firing is its own thread in the channel (a thread holds one task per agent).

const triggersSchema = `
CREATE TABLE IF NOT EXISTS triggers (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, agent_id TEXT NOT NULL, created_by TEXT NOT NULL,
  kind TEXT NOT NULL, text TEXT NOT NULL, repeat TEXT NOT NULL DEFAULT '', due INTEGER, repo TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '', confirmed_by TEXT, enabled INTEGER NOT NULL DEFAULT 1, fired INTEGER, fires INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS triggers_channel ON triggers (channel_id);
`

const (
	stuckAfter       = 30 * time.Minute // a schedule's last task queued this long: no machine is taking it
	maxTriggers      = 20               // per channel
	defaultMaxPerDay = 10               // firings a day
	ceilingMaxPerDay = 100              // the most anyone can set
)

var triggerKinds = map[string]bool{"schedule": true, "pr": true, "push": true}

type triggerView struct {
	ID          string  `json:"id"`
	ChannelID   string  `json:"channel_id"`
	AgentID     string  `json:"agent_id"`
	CreatedBy   string  `json:"created_by"`
	Kind        string  `json:"kind"` // schedule | pr | push
	Text        string  `json:"text"` // what the agent is asked
	Repeat      string  `json:"repeat,omitempty"`
	Due         *int64  `json:"due,omitempty"`    // schedule: the next time
	Repo        string  `json:"repo,omitempty"`   // pr | push: host/owner/name
	Branch      string  `json:"branch,omitempty"` // push: that branch only; pr: PRs into it ("" any)
	ConfirmedBy *string `json:"confirmed_by"`     // nil: waits for the agent's owner
	Enabled     bool    `json:"enabled"`
	Fired       *int64  `json:"fired"`
	Fires       int64   `json:"fires"`
	Created     int64   `json:"created"`
	MaxPerDay   int64   `json:"max_per_day"`
	Skipped     int64   `json:"skipped"`               // firings skipped: its last task still open, or the day's limit reached
	LastTask    *string `json:"last_task,omitempty"`   // the task it opened last
	SkippedRun  int64   `json:"skipped_run"`           // skipped in a row since it last fired, so people see it is stuck
	SkipReason  string  `json:"skip_reason,omitempty"` // busy (last_task is not over) | limit (the day's)
	Duty        string  `json:"duty"`                  // the duty it belongs to ("" none): one name, agent and channel are seen and paused together (teamduties.go)
	Readonly    bool    `json:"readonly"`              // its runs are patrols: read-only, and silent when they find nothing
	CheckCmd    string  `json:"check_cmd,omitempty"`   // schedule: run first on the agent's computer; no change, no firing (teamchecks.go)
	// CheckWaits: its check command waits for the agent's owner to confirm it (new, or changed since)
	CheckWaits     bool `json:"check_waits,omitempty"`
	checkHash      string
	checkConfirmed string
	checkPending   int64
	checkMachine   string
	// Recent: how its last seven days went, by outcome (nochange, nothing, spoke, proposed, failed, skipped, running)
	Recent     map[string]int64 `json:"recent,omitempty"`
	day        string
	dayFires   int64
	stuckNoted string
}

const triggerCols = "id, channel_id, agent_id, created_by, kind, text, repeat, due, repo, branch, confirmed_by, enabled, fired, fires, created, " +
	"max_per_day, skipped, last_task, day, day_fires, skipped_run, skip_reason, stuck_noted, duty, readonly, check_cmd, check_hash, check_confirmed, check_pending, check_machine"

func scanTriggers(rows *sql.Rows, err error) []triggerView {
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []triggerView{}
	for rows.Next() {
		var t triggerView
		if err := rows.Scan(&t.ID, &t.ChannelID, &t.AgentID, &t.CreatedBy, &t.Kind, &t.Text, &t.Repeat, &t.Due, &t.Repo, &t.Branch,
			&t.ConfirmedBy, &t.Enabled, &t.Fired, &t.Fires, &t.Created, &t.MaxPerDay, &t.Skipped, &t.LastTask, &t.day, &t.dayFires, &t.SkippedRun, &t.SkipReason, &t.stuckNoted, &t.Duty, &t.Readonly, &t.CheckCmd, &t.checkHash, &t.checkConfirmed, &t.checkPending, &t.checkMachine); err != nil {
			panic(err)
		}
		t.CheckWaits = t.CheckCmd != "" && t.CheckCmd != t.checkConfirmed
		out = append(out, t)
	}
	return out
}

func (h *Hub) trigger(id string) (triggerView, bool) {
	ts := scanTriggers(h.db.Query("SELECT "+triggerCols+" FROM triggers WHERE id = ?", id))
	if len(ts) == 0 {
		return triggerView{}, false
	}
	return ts[0], true
}

func (h *Hub) triggerChanged(t triggerView, removed bool) {
	if removed {
		h.broadcastChannel(t.ChannelID, obj{"type": "trigger_removed", "id": t.ID})
		return
	}
	t, _ = h.trigger(t.ID)
	t.Recent = h.triggerRecent(t.ID)
	h.broadcastChannel(t.ChannelID, obj{"type": "trigger", "trigger": t})
}

// v1Triggers: a channel's triggers (?channel=…), for its members.
func (h *Hub) v1Triggers(w http.ResponseWriter, q *request) {
	c, ok := h.channel(q.query("channel"))
	if !ok || !h.canRead(q.who, c.ID) {
		errJSON(w, 404, "没有这个频道")
		return
	}
	if !h.memberOrAdmin(c.ID, q.who.userID) {
		errJSON(w, 403, "先加入这个频道")
		return
	}
	writeJSON(w, 200, obj{"triggers": h.withRecent(scanTriggers(h.db.Query("SELECT "+triggerCols+" FROM triggers WHERE channel_id = ? ORDER BY created", c.ID)))})
}

// v1TriggerCreate: {channel_id, agent (handle or id), kind, text, when + repeat (schedule), repo + branch (pr, push),
// duty (a name, optional), readonly (default true: a new trigger's runs only look and speak)}.
func (h *Hub) v1TriggerCreate(w http.ResponseWriter, q *request) {
	var b struct {
		ChannelID string `json:"channel_id"`
		Agent     string `json:"agent"`
		Kind      string `json:"kind"`
		Text      string `json:"text"`
		When      string `json:"when"`
		Repeat    string `json:"repeat"`
		Repo      string `json:"repo"`
		Branch    string `json:"branch"`
		MaxPerDay *int64 `json:"max_per_day"`
		Duty      string `json:"duty"`
		Readonly  *bool  `json:"readonly"`
		CheckCmd  string `json:"check_cmd"`
	}
	_ = q.json(&b)
	me := q.who.userID
	readonly := b.Readonly == nil || *b.Readonly
	check, bad := checkCmdOf(b.Kind, b.CheckCmd)
	if bad != "" {
		errJSON(w, 400, bad)
		return
	}
	perDay := int64(defaultMaxPerDay)
	if b.MaxPerDay != nil {
		if *b.MaxPerDay < 1 || *b.MaxPerDay > ceilingMaxPerDay {
			errJSON(w, 400, fmt.Sprintf("每天最多触发 1 到 %d 次", ceilingMaxPerDay))
			return
		}
		perDay = *b.MaxPerDay
	}
	c, ok := h.channel(b.ChannelID)
	if !ok || !h.canRead(q.who, c.ID) {
		errJSON(w, 404, "没有这个频道")
		return
	}
	if !h.isMember(c.ID, "user", me) {
		errJSON(w, 403, "先加入这个频道")
		return
	}
	a, ok := h.agent(b.Agent)
	if !ok {
		var id string
		if h.db.QueryRow("SELECT id FROM agents WHERE handle = ?", strings.TrimPrefix(strings.TrimSpace(b.Agent), "@")).Scan(&id) == nil {
			a, ok = h.agent(id)
		}
	}
	if !ok || !h.isMember(c.ID, "agent", a.ID) {
		errJSON(w, 400, "选一个在这个频道里的 Agent")
		return
	}
	if a.Dispatch == "owner" && me != a.OwnerID {
		errJSON(w, 403, "@"+a.Handle+" 只接主人派的活")
		return
	}
	text := trimmed(strings.TrimSpace(b.Text), 2000)
	if !triggerKinds[b.Kind] || text == "" {
		errJSON(w, 400, "说清楚什么时候触发（schedule、pr 或 push），以及要 Agent 做什么")
		return
	}
	if h.count("SELECT COUNT(*) FROM triggers WHERE channel_id = ?", c.ID) >= maxTriggers {
		errJSON(w, 429, "一个频道最多 20 个触发器")
		return
	}
	var due any
	repeat, repo, branch := "", "", trimmed(strings.TrimSpace(b.Branch), 120)
	switch b.Kind {
	case "schedule":
		r, ok := repeats[strings.ToLower(strings.TrimSpace(b.Repeat))]
		if !ok || r == "" {
			errJSON(w, 400, "定时触发要选重复：daily、weekdays 或 weekly")
			return
		}
		now := h.now()
		words := strings.Fields(b.When)
		t, n := parseWhen(words, now)
		if n == 0 || n != len(words) {
			errJSON(w, 400, "看不懂这个时间："+b.When)
			return
		}
		repeat, due = r, t.UnixMilli()
	default:
		repo = normRemote(b.Repo)
		if repo == "" {
			errJSON(w, 400, "填仓库地址，比如 https://github.com/acme/pay")
			return
		}
	}
	var confirmed any
	checkOK := ""
	if me == a.OwnerID {
		checkOK = check
	}
	if me == a.OwnerID || (!a.Confirm && check == "") { // a check command always waits for the owner (teamchecks.go)
		confirmed = me
	} else if c.Private && !h.isMember(c.ID, "user", a.OwnerID) {
		// its owner would have to confirm it in the channel's triggers, which they cannot see
		errJSON(w, 403, "@"+a.Handle+" 的主人不在这个私有频道里，没法确认触发器；请主人进来，或换一个 Agent")
		return
	}
	id := newID("trg_")
	h.must(h.db.Exec("INSERT INTO triggers (id, channel_id, agent_id, created_by, kind, text, repeat, due, repo, branch, confirmed_by, created, max_per_day, duty, readonly, check_cmd, check_confirmed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		id, c.ID, a.ID, me, b.Kind, text, repeat, due, repo, branch, confirmed, h.nowMs(), perDay, dutyName(b.Duty), boolInt(readonly), check, checkOK))
	t, _ := h.trigger(id)
	if confirmed == nil {
		h.askTriggerConfirm(t, a, me, false)
	}
	h.triggerChanged(t, false)
	writeJSON(w, 200, t)
}

// askTriggerConfirm: the agent's owner is asked, in the channel, to confirm a trigger (its check command shown);
// changed: only its check command is new.
func (h *Hub) askTriggerConfirm(t triggerView, a agentView, by string, changed bool) {
	o, ok := h.user(a.OwnerID)
	if !ok {
		return
	}
	text := "@" + o.Handle + " 我给 @" + a.Handle + " 设了一个触发器（" + describeTrigger(t) + "：" + t.Text + "）"
	if changed {
		text = "@" + o.Handle + " 我改了 @" + a.Handle + " 的触发器（" + describeTrigger(t) + "：" + t.Text + "）的检查命令，改成每次先在 @" + a.Handle + " 的电脑上跑：\n```\n" + t.CheckCmd + "\n```\n"
	} else if t.CheckCmd != "" {
		text += "，它每次先在 @" + a.Handle + " 的电脑上跑检查命令：\n```\n" + t.CheckCmd + "\n```\n"
	}
	h.insertMessage(t.ChannelID, nil, member{"user", by}, text+"请在频道的「成员 → 触发器」里确认一次")
}

// describeTrigger: "每个工作日 09:00" / "acme/pay 有新 PR" / "推送到 acme/pay main".
func describeTrigger(t triggerView) string {
	switch t.Kind {
	case "schedule":
		at := ""
		if t.Due != nil {
			at = time.UnixMilli(*t.Due).Format("15:04")
		}
		return map[string]string{"daily": "每天 ", "weekdays": "每个工作日 ", "weekly": "每周 "}[t.Repeat] + at
	case "pr":
		return repoName(t.Repo) + " 有新 PR"
	}
	return strings.TrimSpace("推送到 " + repoName(t.Repo) + " " + t.Branch)
}

// mayManageTrigger: who set it up, the agent's owner, an admin.
func (h *Hub) mayManageTrigger(w http.ResponseWriter, q *request) (triggerView, agentView, bool) {
	t, ok := h.trigger(q.r.PathValue("id"))
	if !ok {
		errJSON(w, 404, "not found")
		return t, agentView{}, false
	}
	a, _ := h.agent(t.AgentID)
	me := q.who.userID
	if !h.userCanRead(me, t.ChannelID) { // a private channel's triggers: its members only
		errJSON(w, 404, "not found")
		return t, a, false
	}
	if me != t.CreatedBy && me != a.OwnerID && !h.isAdmin(me) {
		errJSON(w, 403, "只有设置它的人、Agent 的主人或管理员能改")
		return t, a, false
	}
	return t, a, true
}

// v1TriggerConfirm: the agent's owner says yes once.
func (h *Hub) v1TriggerConfirm(w http.ResponseWriter, q *request) {
	t, a, ok := h.mayManageTrigger(w, q)
	if !ok {
		return
	}
	if q.who.userID != a.OwnerID && (!h.isAdmin(q.who.userID) || t.CheckCmd != "") { // a command on their computer: the owner only (teamchecks.go)
		errJSON(w, 403, "由 @"+a.Handle+" 的主人确认")
		return
	}
	// {check_cmd}: a check command is confirmed as the owner saw it; changed meanwhile, they look again
	var b struct {
		CheckCmd *string `json:"check_cmd"`
	}
	_ = q.json(&b)
	if t.CheckCmd != "" && (b.CheckCmd == nil || *b.CheckCmd != t.CheckCmd) {
		errJSON(w, 409, "检查命令刚被改了，请看过新的再确认")
		return
	}
	h.must(h.db.Exec("UPDATE triggers SET confirmed_by = ?, check_confirmed = ? WHERE id = ?", q.who.userID, t.CheckCmd, t.ID))
	h.triggerChanged(t, false)
	t, _ = h.trigger(t.ID)
	writeJSON(w, 200, t)
}

// v1TriggerPatch: {enabled?, max_per_day?, duty?, readonly?}.
func (h *Hub) v1TriggerPatch(w http.ResponseWriter, q *request) {
	t, _, ok := h.mayManageTrigger(w, q)
	if !ok {
		return
	}
	var b struct {
		Enabled   *bool   `json:"enabled"`
		MaxPerDay *int64  `json:"max_per_day"`
		Duty      *string `json:"duty"`
		Readonly  *bool   `json:"readonly"`
		CheckCmd  *string `json:"check_cmd"`
	}
	_ = q.json(&b)
	if b.CheckCmd != nil {
		check, bad := checkCmdOf(t.Kind, *b.CheckCmd)
		if bad != "" {
			errJSON(w, 400, bad)
			return
		}
		if check != t.CheckCmd {
			a, _ := h.agent(t.AgentID)
			if q.who.userID == a.OwnerID || check == "" { // its owner's own command, or none: nothing to confirm
				h.must(h.db.Exec("UPDATE triggers SET check_cmd = ?, check_confirmed = ?, check_hash = '' WHERE id = ?", check, check, t.ID))
			} else { // another command on the owner's computer: it waits for them again
				h.must(h.db.Exec("UPDATE triggers SET check_cmd = ?, check_hash = '' WHERE id = ?", check, t.ID))
				t, _ = h.trigger(t.ID)
				h.askTriggerConfirm(t, a, q.who.userID, true)
			}
		}
	}
	if b.MaxPerDay != nil {
		if *b.MaxPerDay < 1 || *b.MaxPerDay > ceilingMaxPerDay {
			errJSON(w, 400, fmt.Sprintf("每天最多触发 1 到 %d 次", ceilingMaxPerDay))
			return
		}
		h.must(h.db.Exec("UPDATE triggers SET max_per_day = ? WHERE id = ?", *b.MaxPerDay, t.ID))
	}
	if b.Enabled != nil {
		h.must(h.db.Exec("UPDATE triggers SET enabled = ? WHERE id = ?", boolInt(*b.Enabled), t.ID))
	}
	if b.Duty != nil {
		h.must(h.db.Exec("UPDATE triggers SET duty = ? WHERE id = ?", dutyName(*b.Duty), t.ID))
	}
	if b.Readonly != nil {
		h.must(h.db.Exec("UPDATE triggers SET readonly = ? WHERE id = ?", boolInt(*b.Readonly), t.ID))
	}
	h.triggerChanged(t, false)
	t, _ = h.trigger(t.ID)
	writeJSON(w, 200, t)
}

func (h *Hub) v1TriggerDelete(w http.ResponseWriter, q *request) {
	t, _, ok := h.mayManageTrigger(w, q)
	if !ok {
		return
	}
	h.must(h.db.Exec("DELETE FROM triggers WHERE id = ?", t.ID))
	h.must(h.db.Exec("DELETE FROM trigger_runs WHERE trigger_id = ?", t.ID))
	h.triggerChanged(t, true)
	writeJSON(w, 200, obj{"ok": true})
}

// fire: the trigger asks its agent, in its channel, in its person's name; a task at once. extra: what happened (the
// PR, the push). It says "fired", "skipped" (its last task is still open, or it fired max_per_day times today), or
// "off" when it can no longer fire (the person left, the agent is gone): it is turned off.
func (h *Hub) fire(t triggerView, extra string) string {
	a, ok := h.agent(t.AgentID)
	c, okc := h.channel(t.ChannelID)
	if !ok || !okc || c.Archived || !h.isMember(c.ID, "user", t.CreatedBy) || !h.isMember(c.ID, "agent", a.ID) {
		h.must(h.db.Exec("UPDATE triggers SET enabled = 0 WHERE id = ?", t.ID))
		return "off"
	}
	today := h.now().Format("2006-01-02")
	fires := int64(0)
	if t.day == today {
		fires = t.dayFires
	}
	// a schedule whose last task is still queued or running: skip. One that waits (on CI, on a person), was handed to
	// a person, or waits to be accepted (a daily report nobody clicked 验收 on) has done its part, so the next one goes
	// ahead. A pull request or a push is never skipped for that. The day's limit holds for all.
	reason := ""
	if t.Kind == "schedule" && t.LastTask != nil {
		if last, ok := h.task(*t.LastTask); ok && (last.State == taskPending || last.State == taskQueued || last.State == taskRunning) {
			reason = "busy"
			h.noteStuckTrigger(t, last, a)
		}
	}
	if reason == "" && fires >= t.MaxPerDay {
		reason = "limit"
	}
	if reason != "" {
		h.must(h.db.Exec("UPDATE triggers SET skipped = skipped + 1, skipped_run = skipped_run + 1, skip_reason = ? WHERE id = ?", reason, t.ID))
		h.noteTriggerRun(t.ID, runSkipped, map[string]string{"busy": "上一个任务还没结束", "limit": "今天的次数到上限了"}[reason], "")
		return "skipped"
	}
	text := "⚡ @" + a.Handle + " " + t.Text
	if extra != "" {
		text += "\n\n" + extra
	}
	var id string
	if t.Readonly { // a patrol: its message goes up only when the agent first speaks; untracked until it delivers something
		m := messageView{ID: newID("msg_"), ChannelID: c.ID, Author: member{"user", t.CreatedBy}, Text: text}
		id = h.createTaskWith(m, m.ID, a.ID, false, false, taskOrigin{Trigger: t.ID, Confirmed: true, Readonly: true, Held: text})
	} else {
		m := h.insertMessage(c.ID, nil, member{"user", t.CreatedBy}, text)
		id = h.createTaskWith(m, m.ID, a.ID, false, true, taskOrigin{Trigger: t.ID, Confirmed: true})
	}
	h.noteTriggerRun(t.ID, runRunning, "", id)
	h.must(h.db.Exec("UPDATE triggers SET fired = ?, fires = fires + 1, last_task = ?, day = ?, day_fires = ?, skipped_run = 0, skip_reason = '' WHERE id = ?",
		h.nowMs(), id, today, fires+1, t.ID))
	return "fired"
}

// noteStuckTrigger: a schedule skipped because its last task has sat queued for stuckAfter (no machine takes it: the
// machine is offline, its runtime there out of quota or logged out) tells the person who set it up, once for that task, in the task's thread.
func (h *Hub) noteStuckTrigger(t triggerView, last taskView, a agentView) {
	if last.State != taskQueued || h.nowMs()-last.Updated < stuckAfter.Milliseconds() || t.stuckNoted == last.ID {
		return
	}
	mins := (h.nowMs() - last.Updated) / 60_000
	text := fmt.Sprintf("%s 触发器（%s）这次没有跑：上一次的 %s 已经排队 %d 分钟，还没有机器接手（机器离线，或 @%s 用的运行时在那台机器上额度用完、没有登录）。它跑起来以后，触发器会照常继续。",
		h.handle(t.CreatedBy), describeTrigger(t), last.ID, mins, a.Handle)
	h.insertMessage(last.ChannelID, &last.ThreadID, member{"agent", a.ID}, text)
	h.must(h.db.Exec("UPDATE triggers SET stuck_noted = ? WHERE id = ?", last.ID, t.ID))
}

// fireTriggers: the scheduled ones that are due. Tick calls it.
func (h *Hub) fireTriggers() {
	now := h.now()
	for _, t := range scanTriggers(h.db.Query("SELECT "+triggerCols+" FROM triggers WHERE kind = 'schedule' AND enabled = 1 AND due <= ?", now.UnixMilli())) {
		next := nextDue(time.UnixMilli(*t.Due).In(now.Location()), t.Repeat, now)
		h.must(h.db.Exec("UPDATE triggers SET due = ? WHERE id = ?", next.UnixMilli(), t.ID))
		switch {
		case !t.checkReady(): // not confirmed yet, or its check command waits for the owner again
		case t.CheckCmd != "":
			h.startCheck(t) // it fires, or not, when the check's output comes back (teamchecks.go)
		default:
			h.fire(t, "")
		}
		h.triggerChanged(t, false)
	}
}

// gitTriggers: a pull request was opened (kind "pr", branch: the one it goes into) or a branch was pushed ("push").
func (h *Hub) gitTriggers(kind, remote, branch, extra string) int {
	if remote == "" || strings.HasPrefix(branch, "agent/") {
		return 0
	}
	n := 0
	for _, t := range scanTriggers(h.db.Query("SELECT "+triggerCols+" FROM triggers WHERE kind = ? AND repo = ? AND enabled = 1 AND confirmed_by IS NOT NULL", kind, remote)) {
		if t.Branch != "" && t.Branch != branch {
			continue
		}
		if h.fire(t, extra) == "fired" {
			n++
		}
		h.triggerChanged(t, false)
	}
	return n
}

// v1GithubHook: GitHub tells us a pull request was opened or a branch pushed (triggers), or how a task's PR stands.
// Signed with the same webhook secret as GitLab's (X-Hub-Signature-256).
func (h *Hub) v1GithubHook(w http.ResponseWriter, q *request) {
	secret := h.cfg.GitWebhookSecret
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(q.body)
	want := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if secret == "" || !hmac.Equal([]byte(q.r.Header.Get("X-Hub-Signature-256")), []byte(want)) {
		errJSON(w, 401, "unauthorized")
		return
	}
	var b struct {
		Action string `json:"action"`
		Ref    string `json:"ref"`
		Repo   struct {
			URL string `json:"html_url"`
		} `json:"repository"`
		PR struct {
			Number int64  `json:"number"`
			Title  string `json:"title"`
			URL    string `json:"html_url"`
			Merged bool   `json:"merged"`
			State  string `json:"state"`
			Head   struct {
				Ref string `json:"ref"`
			} `json:"head"`
			Base struct {
				Ref string `json:"ref"`
			} `json:"base"`
		} `json:"pull_request"`
		Compare string `json:"compare"`
		Head    struct {
			Message string `json:"message"`
		} `json:"head_commit"`
		Deleted bool `json:"deleted"`
	}
	if err := json.Unmarshal(q.body, &b); err != nil {
		errJSON(w, 400, "bad json")
		return
	}
	remote := normRemote(b.Repo.URL)
	switch q.r.Header.Get("X-GitHub-Event") {
	case "pull_request":
		if strings.HasPrefix(b.PR.Head.Ref, "agent/") {
			h.githubTaskPR(b.PR.Head.Ref, b.PR.Number, b.PR.Title, b.PR.URL, b.PR.State, b.PR.Merged, remote)
			writeJSON(w, 200, obj{"ok": true})
			return
		}
		n := 0
		if b.Action == "opened" || b.Action == "reopened" {
			n = h.gitTriggers("pr", remote, b.PR.Base.Ref, fmt.Sprintf("PR #%d %s\n%s", b.PR.Number, b.PR.Title, b.PR.URL))
		}
		writeJSON(w, 200, obj{"ok": true, "fired": n})
	case "push":
		branch := strings.TrimPrefix(b.Ref, "refs/heads/")
		n := 0
		if !b.Deleted && strings.HasPrefix(b.Ref, "refs/heads/") {
			n = h.gitTriggers("push", remote, branch, strings.TrimSpace("推送到 "+branch+"："+oneLine(b.Head.Message)+"\n"+b.Compare))
		}
		writeJSON(w, 200, obj{"ok": true, "fired": n})
	default:
		writeJSON(w, 200, obj{"ok": true, "ignored": q.r.Header.Get("X-GitHub-Event")})
	}
}

// githubTaskPR: a task's own PR changed on GitHub (the machine also looks every two minutes).
func (h *Hub) githubTaskPR(branch string, number int64, title, url, state string, merged bool, remote string) {
	ts := scanTasks(h.db.Query("SELECT "+taskCols+" FROM tasks_v1 WHERE branch = ? ORDER BY num DESC LIMIT 1", branch))
	if len(ts) == 0 {
		return
	}
	t := ts[0]
	pr := prView{Provider: "github", Checks: "none", Repo: remote}
	if t.PR != nil {
		pr = *t.PR
	}
	pr.Number, pr.Title, pr.URL, pr.State = number, title, url, "open"
	if merged {
		pr.State = "merged"
	} else if state == "closed" {
		pr.State = "closed"
	}
	cols := map[string]any{"pr": jsonOrNil(pr)}
	if pr.State == "merged" && (t.State == taskReview || t.State == taskBlocked) {
		cols["state"] = taskDone
	}
	h.setTask(t.ID, cols)
	h.taskChanged(t.ID)
}
