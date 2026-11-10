package hub

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Reminders: "remind me (or @someone) of this later", once or again and again. A task's own waiting is in
// teamwaits.go; this is for everything outside a task. It is set from a message's menu ("remind me later"), the
// composer (/remind …) or by an agent while it runs (remi remind …).
//
// When one is due: a person gets it in "Waiting for you" (and a live frame); an agent is @-ed in the channel or
// thread, in the name of the person who set it, so it goes through dispatch like any other @. That also covers the
// "every morning, have @agent do X" kind of recurring work.

const remindersSchema = `
CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, by_user TEXT NOT NULL, by_agent TEXT,
  target_kind TEXT NOT NULL, target_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_id TEXT, message_id TEXT,
  text TEXT NOT NULL, due INTEGER NOT NULL, repeat TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL,
  fired INTEGER, seen INTEGER, done INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders (done, due);
`

const (
	maxReminderText     = 500
	maxAgentReminders   = 20 // scheduled ones an agent may have set at a time
	reminderDefaultHour = 9
)

// repeats: what a reminder does after it fires. "" = once.
var repeats = map[string]string{"": "", "daily": "daily", "每天": "daily", "weekdays": "weekdays", "工作日": "weekdays", "每个工作日": "weekdays",
	"weekly": "weekly", "每周": "weekly"}

type reminderView struct {
	ID        string  `json:"id"`
	By        string  `json:"by"`                 // the person it is set in the name of
	ByAgent   *string `json:"by_agent,omitempty"` // the agent that set it, if one did
	Target    member  `json:"target"`             // who is reminded
	ChannelID string  `json:"channel_id"`
	ThreadID  *string `json:"thread_id"`
	MessageID *string `json:"message_id"`
	Text      string  `json:"text"`
	Due       int64   `json:"due"`    // the next time it fires (unix ms)
	Repeat    string  `json:"repeat"` // "" | daily | weekdays | weekly
	Created   int64   `json:"created"`
	Fired     *int64  `json:"fired"` // the last time it fired
	Seen      *int64  `json:"seen"`  // the last time its person dismissed it
	Done      bool    `json:"done"`  // nothing more scheduled
}

const reminderCols = `id, by_user, by_agent, target_kind, target_id, channel_id, thread_id, message_id, text, due, repeat, created,
	fired, seen, done`

func scanReminders(rows *sql.Rows, err error) []reminderView {
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []reminderView{}
	for rows.Next() {
		var r reminderView
		if err := rows.Scan(&r.ID, &r.By, &r.ByAgent, &r.Target.Kind, &r.Target.ID, &r.ChannelID, &r.ThreadID, &r.MessageID, &r.Text,
			&r.Due, &r.Repeat, &r.Created, &r.Fired, &r.Seen, &r.Done); err != nil {
			panic(err)
		}
		out = append(out, r)
	}
	return out
}

func (h *Hub) reminder(id string) (reminderView, bool) {
	rs := scanReminders(h.db.Query("SELECT "+reminderCols+" FROM reminders WHERE id = ?", id))
	if len(rs) == 0 {
		return reminderView{}, false
	}
	return rs[0], true
}

// ---------------------------------------------------------------- when

var (
	relRE   = regexp.MustCompile(`^(\d+)\s*(m|min|mins|分钟|h|hr|hrs|小时|个小时|d|day|days|天)后?$`)
	clockRE = regexp.MustCompile(`^(\d{1,2})(?:[:：](\d{2})|点(?:(\d{1,2})分?|半)?)$`)
	dateRE  = regexp.MustCompile(`^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$`)
)

var weekdays = map[string]time.Weekday{
	"周日": time.Sunday, "周天": time.Sunday, "星期日": time.Sunday, "星期天": time.Sunday, "sun": time.Sunday, "sunday": time.Sunday,
	"周一": time.Monday, "星期一": time.Monday, "mon": time.Monday, "monday": time.Monday,
	"周二": time.Tuesday, "星期二": time.Tuesday, "tue": time.Tuesday, "tuesday": time.Tuesday,
	"周三": time.Wednesday, "星期三": time.Wednesday, "wed": time.Wednesday, "wednesday": time.Wednesday,
	"周四": time.Thursday, "星期四": time.Thursday, "thu": time.Thursday, "thursday": time.Thursday,
	"周五": time.Friday, "星期五": time.Friday, "fri": time.Friday, "friday": time.Friday,
	"周六": time.Saturday, "星期六": time.Saturday, "sat": time.Saturday, "saturday": time.Saturday,
}

// clock: "9:30", "14:00", "9点", "9点半", "9点15" → hour, minute.
func clock(s string) (int, int, bool) {
	m := clockRE.FindStringSubmatch(s)
	if m == nil {
		return 0, 0, false
	}
	hh, _ := strconv.Atoi(m[1])
	mm := 0
	switch {
	case m[2] != "":
		mm, _ = strconv.Atoi(m[2])
	case m[3] != "":
		mm, _ = strconv.Atoi(m[3])
	case strings.HasSuffix(s, "半"):
		mm = 30
	}
	if hh > 23 || mm > 59 {
		return 0, 0, false
	}
	return hh, mm, true
}

func at(day time.Time, hh, mm int) time.Time {
	return time.Date(day.Year(), day.Month(), day.Day(), hh, mm, 0, 0, day.Location())
}

// parseWhen reads a time from the start of the words: "20m", "2h", "1d", "9:30" (today, or tomorrow once past),
// "明天" / "tomorrow" [time], "后天", "周五" / "fri" [time], "2026-11-20" / "11-20" [time]. A day without a time is 9:00.
// It returns the time and how many words it used (0: none).
func parseWhen(words []string, now time.Time) (time.Time, int) {
	if len(words) == 0 {
		return time.Time{}, 0
	}
	w := strings.ToLower(words[0])
	if m := relRE.FindStringSubmatch(w); m != nil {
		n, _ := strconv.Atoi(m[1])
		if n <= 0 {
			return time.Time{}, 0
		}
		unit := time.Hour
		if strings.HasPrefix(m[2], "天") || strings.HasPrefix(m[2], "d") {
			unit = 24 * time.Hour
		} else if strings.HasPrefix(m[2], "分") || strings.HasPrefix(m[2], "m") {
			unit = time.Minute
		}
		return now.Add(time.Duration(n) * unit), 1
	}
	if hh, mm, ok := clock(w); ok {
		t := at(now, hh, mm)
		if !t.After(now) {
			t = t.AddDate(0, 0, 1)
		}
		return t, 1
	}
	var day time.Time
	wd, isWeekday := weekdays[w]
	switch {
	case w == "今天" || w == "today":
		day = now
	case w == "明天" || w == "tomorrow":
		day = now.AddDate(0, 0, 1)
	case w == "后天":
		day = now.AddDate(0, 0, 2)
	case isWeekday:
		d := (int(wd) - int(now.Weekday()) + 7) % 7
		day = now.AddDate(0, 0, d)
	default:
		m := dateRE.FindStringSubmatch(w)
		if m == nil {
			return time.Time{}, 0
		}
		y := now.Year()
		if m[1] != "" {
			y, _ = strconv.Atoi(m[1])
		}
		mo, _ := strconv.Atoi(m[2])
		d, _ := strconv.Atoi(m[3])
		if mo < 1 || mo > 12 || d < 1 || d > 31 {
			return time.Time{}, 0
		}
		day = time.Date(y, time.Month(mo), d, 0, 0, 0, 0, now.Location())
		if m[1] == "" && at(day, 23, 59).Before(now) {
			day = day.AddDate(1, 0, 0) // "1-5" in December: next January
		}
	}
	used := 1
	hh, mm := reminderDefaultHour, 0
	if len(words) > 1 {
		if h2, m2, ok := clock(words[1]); ok {
			hh, mm, used = h2, m2, 2
		}
	}
	t := at(day, hh, mm)
	if !t.After(now) {
		if !isWeekday {
			return time.Time{}, 0 // "今天 8:00" at 10, a date that has passed
		}
		t = t.AddDate(0, 0, 7) // "周五 9:00" on Friday at 10: next Friday
	}
	return t, used
}

// nextDue: when a repeating reminder fires next after `due`, past `now`.
func nextDue(due time.Time, repeat string, now time.Time) time.Time {
	for {
		switch repeat {
		case "daily":
			due = due.AddDate(0, 0, 1)
		case "weekly":
			due = due.AddDate(0, 0, 7)
		case "weekdays":
			due = due.AddDate(0, 0, 1)
			for due.Weekday() == time.Saturday || due.Weekday() == time.Sunday {
				due = due.AddDate(0, 0, 1)
			}
		default:
			return due
		}
		if due.After(now) {
			return due
		}
	}
}

// parseRemind reads "/remind" words: [repeat] when [repeat] [@who] what. A repeat without a time starts at 9:00.
func parseRemind(s string, now time.Time) (due time.Time, repeat, who, what, problem string) {
	words := strings.Fields(s)
	takeRepeat := func() bool {
		if len(words) > 0 {
			if r, ok := repeats[strings.ToLower(words[0])]; ok && r != "" && repeat == "" {
				repeat, words = r, words[1:]
				return true
			}
		}
		return false
	}
	takeRepeat()
	t, n := parseWhen(words, now)
	words = words[n:]
	takeRepeat()
	if n == 0 {
		if repeat == "" {
			return due, "", "", "", "说一下什么时候：如 20m、2h、明天 9:00、周五 15:00、2026-12-01 10:00"
		}
		t = at(now, reminderDefaultHour, 0)
		if !t.After(now) {
			t = t.AddDate(0, 0, 1)
		}
	}
	if repeat == "weekdays" {
		for t.Weekday() == time.Saturday || t.Weekday() == time.Sunday {
			t = t.AddDate(0, 0, 1)
		}
	}
	if len(words) > 0 && strings.HasPrefix(words[0], "@") {
		who, words = strings.TrimPrefix(words[0], "@"), words[1:]
	}
	return t, repeat, who, strings.Join(words, " "), ""
}

// ---------------------------------------------------------------- making one

type remindRequest struct {
	Command   string `json:"command"`    // the words after /remind (or remi remind)
	When      string `json:"when"`       // or: a time in parseWhen's words…
	At        int64  `json:"at"`         // …or in unix ms
	Repeat    string `json:"repeat"`     // "" | daily | weekdays | weekly
	Target    string `json:"target"`     // a handle; "" = the one setting it
	Text      string `json:"text"`       // what to remind of ("" with a message: the message)
	MessageID string `json:"message_id"` // the message it is about
	ChannelID string `json:"channel_id"`
	ThreadID  string `json:"thread_id"`
}

// newReminder checks a request and stores it. by: the person it is in the name of; byAgent: the agent setting it
// ("" for a person); self: who is reminded when nobody is named.
func (h *Hub) newReminder(b remindRequest, by, byAgent string, self member) (reminderView, int, string) {
	now := h.now()
	var due time.Time
	repeat, ok := repeats[strings.ToLower(strings.TrimSpace(b.Repeat))]
	if !ok {
		return reminderView{}, 400, "repeat 只能是 daily、weekdays 或 weekly"
	}
	who, text := strings.TrimPrefix(strings.TrimSpace(b.Target), "@"), strings.TrimSpace(b.Text)
	switch {
	case strings.TrimSpace(b.Command) != "":
		var problem, w2, t2 string
		due, repeat, w2, t2, problem = parseRemind(b.Command, now)
		if problem != "" {
			return reminderView{}, 400, problem
		}
		if w2 != "" {
			who = w2
		}
		if t2 != "" {
			text = t2
		}
	case b.At > 0:
		due = time.UnixMilli(b.At).In(now.Location())
	case strings.TrimSpace(b.When) != "":
		words := strings.Fields(b.When)
		t, n := parseWhen(words, now)
		if n == 0 || n != len(words) {
			return reminderView{}, 400, "看不懂这个时间：" + b.When
		}
		due = t
	default:
		return reminderView{}, 400, "说一下什么时候"
	}
	if !due.After(now) {
		return reminderView{}, 400, "这个时间已经过了"
	}
	if due.Sub(now) > 366*24*time.Hour {
		return reminderView{}, 400, "最多提前一年"
	}

	// where: the message's thread, or the channel (and thread) named
	channelID, thread := b.ChannelID, b.ThreadID
	var messageID any
	if b.MessageID != "" {
		m, ok := h.message(b.MessageID)
		if !ok {
			return reminderView{}, 404, "没有这条消息"
		}
		channelID, thread, messageID = m.ChannelID, m.ID, m.ID
		if m.ThreadID != nil {
			thread = *m.ThreadID
		}
		if text == "" {
			text = oneLine(m.Text)
			if text == "" {
				text = "看一下这条消息"
			}
		}
	}
	if channelID == "" {
		return reminderView{}, 400, "在哪个频道提醒？"
	}
	c, ok := h.channel(channelID)
	if !ok {
		return reminderView{}, 404, "没有这个频道"
	}
	setter := member{"user", by}
	if byAgent != "" {
		setter = member{"agent", byAgent}
	}
	if !h.isMember(c.ID, setter.Kind, setter.ID) {
		return reminderView{}, 403, "先加入这个频道"
	}
	if thread != "" {
		if r, ok := h.message(thread); !ok || r.ChannelID != c.ID {
			return reminderView{}, 400, "没有这个线程"
		} else if r.ThreadID != nil {
			thread = *r.ThreadID
		}
	}
	if text == "" {
		return reminderView{}, 400, "提醒什么？"
	}

	target := self
	if who != "" && who != "me" && who != "我" {
		ms := h.mentions("@" + who)
		if len(ms) == 0 {
			return reminderView{}, 404, "没有 @" + who
		}
		target = member{ms[0].Kind, ms[0].ID}
	}
	if target.Kind == "user" && target.ID != by && !h.isMember(c.ID, "user", target.ID) {
		return reminderView{}, 403, "@" + who + " 不在这个频道"
	}
	if byAgent != "" && target.Kind == "agent" && target.ID != byAgent {
		return reminderView{}, 400, "Agent 不能用提醒把事交给另一个 Agent：用 remi handoff @" + who + " 交给它的事（由人点一下确认）"
	}
	if byAgent != "" {
		if other := h.otherAgent(text, byAgent); other != "" { // the reminder's message would @ it, in the person's name
			return reminderView{}, 400, "Agent 的提醒里不能 @ 另一个 Agent：用 remi handoff @" + other + " 交给它的事（由人点一下确认）"
		}
	}
	if target.Kind == "agent" && thread == "" && repeat == "" && target == setter {
		return reminderView{}, 400, "要在线程里提醒自己"
	}
	if byAgent != "" && h.count("SELECT COUNT(*) FROM reminders WHERE by_agent = ? AND done = 0", byAgent) >= maxAgentReminders {
		return reminderView{}, 429, "这个 Agent 设的提醒太多了，先让人取消一些"
	}

	id := newID("rem_")
	var th, ag any
	if thread != "" {
		th = thread
	}
	if byAgent != "" {
		ag = byAgent
	}
	h.must(h.db.Exec(`INSERT INTO reminders (id, by_user, by_agent, target_kind, target_id, channel_id, thread_id, message_id, text, due, repeat, created)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, by, ag, target.Kind, target.ID, c.ID, th, messageID, trimmed(text, maxReminderText),
		due.UnixMilli(), repeat, now.UnixMilli()))
	r, _ := h.reminder(id)
	h.remindersChanged(r)
	return r, 200, ""
}

// oneLine: the first line of a message, short, for a reminder of it.
func oneLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return truncRunes(s, 80)
}

// remindersChanged tells the people concerned (who set it, who gets it) to look again.
func (h *Hub) remindersChanged(r reminderView) {
	b, _ := json.Marshal(obj{"type": "reminder", "reminder": r})
	h.socks.send("u:"+r.By, b)
	if r.Target.Kind == "user" && r.Target.ID != r.By {
		h.socks.send("u:"+r.Target.ID, b)
	}
}

// ---------------------------------------------------------------- firing

// fireReminders: the ones that are due go off. Tick calls it (with h.mu held).
func (h *Hub) fireReminders() {
	now := h.now()
	for _, r := range scanReminders(h.db.Query("SELECT "+reminderCols+" FROM reminders WHERE done = 0 AND due <= ? ORDER BY due", now.UnixMilli())) {
		next, done := nextDue(time.UnixMilli(r.Due).In(now.Location()), r.Repeat, now), r.Repeat == ""
		if r.Target.Kind == "agent" && !h.remindAgent(r) {
			done = true // its person left the channel, or the agent is gone: it stops
		}
		h.must(h.db.Exec("UPDATE reminders SET fired = ?, due = ?, done = ? WHERE id = ?", now.UnixMilli(), next.UnixMilli(), done, r.ID))
		r, _ = h.reminder(r.ID)
		h.remindersChanged(r)
	}
}

// otherAgent: the handle of an agent other than self that text @s, or "".
func (h *Hub) otherAgent(text, self string) string {
	for _, m := range h.mentions(text) {
		if m.Kind == "agent" && m.ID != self {
			return m.Handle
		}
	}
	return ""
}

// remindAgent @s the agent where the reminder was set, in its person's name; dispatch takes it from there.
func (h *Hub) remindAgent(r reminderView) bool {
	a, ok := h.agent(r.Target.ID)
	if !ok || !h.isMember(r.ChannelID, "user", r.By) {
		return false
	}
	if c, ok := h.channel(r.ChannelID); !ok || c.Archived {
		return false
	}
	if r.ByAgent != nil && h.otherAgent(r.Text, *r.ByAgent) != "" { // set before agents' reminders were checked for this
		return false
	}
	m := h.insertMessage(r.ChannelID, r.ThreadID, member{"user", r.By}, "⏰ @"+a.Handle+" "+r.Text)
	h.onPosted(m, false)
	return true
}

// ---------------------------------------------------------------- API

// v1Reminders: the reminders that concern me: scheduled ones I set or get, and the ones that went off and wait for me.
func (h *Hub) v1Reminders(w http.ResponseWriter, q *request) {
	me := q.who.userID
	rs := scanReminders(h.db.Query("SELECT "+reminderCols+` FROM reminders WHERE
		(done = 0 AND (by_user = ? OR (target_kind = 'user' AND target_id = ?)))
		OR (target_kind = 'user' AND target_id = ? AND fired IS NOT NULL AND (seen IS NULL OR seen < fired))
		ORDER BY due LIMIT 500`, me, me, me))
	writeJSON(w, 200, obj{"reminders": rs})
}

func (h *Hub) v1ReminderCreate(w http.ResponseWriter, q *request) {
	var b remindRequest
	if q.json(&b) != nil {
		errJSON(w, 400, "bad json")
		return
	}
	r, status, problem := h.newReminder(b, q.who.userID, "", member{"user", q.who.userID})
	if problem != "" {
		errJSON(w, status, problem)
		return
	}
	writeJSON(w, 200, r)
}

// mine: the reminder in the path, if this person set it or gets it.
func (h *Hub) myReminder(w http.ResponseWriter, q *request) (reminderView, bool) {
	r, ok := h.reminder(q.r.PathValue("id"))
	me := q.who.userID
	if !ok || (r.By != me && !(r.Target.Kind == "user" && r.Target.ID == me)) {
		errJSON(w, 404, "not found")
		return r, false
	}
	return r, true
}

// v1ReminderDelete: cancel it (whoever set it or gets it).
func (h *Hub) v1ReminderDelete(w http.ResponseWriter, q *request) {
	r, ok := h.myReminder(w, q)
	if !ok {
		return
	}
	h.must(h.db.Exec("DELETE FROM reminders WHERE id = ?", r.ID))
	r.Done = true
	h.remindersChanged(r)
	writeJSON(w, 200, obj{"ok": true})
}

// v1ReminderSeen: its person dealt with it; with {when}, remind again then (once).
func (h *Hub) v1ReminderSeen(w http.ResponseWriter, q *request) {
	r, ok := h.myReminder(w, q)
	if !ok {
		return
	}
	var b struct {
		When string `json:"when"`
		At   int64  `json:"at"`
	}
	_ = q.json(&b)
	now := h.nowMs()
	h.must(h.db.Exec("UPDATE reminders SET seen = ? WHERE id = ?", now, r.ID))
	if b.When != "" || b.At > 0 {
		var thread string
		if r.ThreadID != nil {
			thread = *r.ThreadID
		}
		again, status, problem := h.newReminder(remindRequest{When: b.When, At: b.At, Text: r.Text, ChannelID: r.ChannelID, ThreadID: thread},
			r.By, "", member{"user", q.who.userID})
		if problem != "" {
			errJSON(w, status, problem)
			return
		}
		if r.MessageID != nil {
			h.must(h.db.Exec("UPDATE reminders SET message_id = ? WHERE id = ?", *r.MessageID, again.ID))
			again, _ = h.reminder(again.ID)
		}
		r, _ = h.reminder(r.ID)
		h.remindersChanged(r)
		writeJSON(w, 200, again)
		return
	}
	r, _ = h.reminder(r.ID)
	h.remindersChanged(r)
	writeJSON(w, 200, r)
}

// v1AgentRemind: `remi remind WHEN [@who] WHAT` while a task runs. In the name of the task's requester; without
// @who it reminds the agent itself, in the task's thread.
func (h *Hub) v1AgentRemind(w http.ResponseWriter, q *request) {
	t, a, ok := h.reader(w, q)
	if !ok {
		return
	}
	cmd := string(q.body)
	if !strings.HasPrefix(q.r.Header.Get("content-type"), "text/plain") {
		var b struct {
			Command string `json:"command"`
		}
		_ = q.json(&b)
		cmd = b.Command
	}
	r, status, problem := h.newReminder(remindRequest{Command: cmd, ChannelID: t.ChannelID, ThreadID: t.ThreadID}, t.CreatedBy, a.ID, member{"agent", a.ID})
	if problem != "" {
		errJSON(w, status, problem)
		return
	}
	who := "you"
	if r.Target.Kind == "user" {
		if u, ok := h.user(r.Target.ID); ok {
			who = "@" + u.Handle
		}
	} else if r.Target.ID != a.ID {
		if b, ok := h.agent(r.Target.ID); ok {
			who = "@" + b.Handle
		}
	}
	line := "reminder " + r.ID + ": " + who + " at " + time.UnixMilli(r.Due).In(h.now().Location()).Format("2006-01-02 15:04 Mon")
	if r.Repeat != "" {
		line += ", then " + r.Repeat
	}
	writeText(w, line+"\n")
}
