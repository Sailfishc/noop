package hub

import (
	"database/sql"
	"encoding/json"
	"fmt"
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
  fired INTEGER, seen INTEGER, done INTEGER NOT NULL DEFAULT 0, until INTEGER);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders (done, due);
`

const (
	maxReminderText     = 500
	maxAgentReminders   = 20 // scheduled ones an agent may have set at a time
	reminderDefaultHour = 9
	minInterval         = 10 * time.Minute // "every 10m" is as often as anything repeats
	maxInterval         = 24 * time.Hour
	maxAgentIntervals   = 3              // interval reminders an agent may have running at a time
	agentIntervalFor    = 24 * time.Hour // an agent's interval reminder stops by itself after this
)

// repeats: what a reminder does after it fires. "" = once. An interval ("every 10m", "每 10 分钟") is kept as
// "10m" or "2h" (see normRepeat).
var repeats = map[string]string{"": "", "daily": "daily", "每天": "daily", "weekdays": "weekdays", "工作日": "weekdays", "每个工作日": "weekdays",
	"weekly": "weekly", "每周": "weekly"}

var (
	everyRE        = regexp.MustCompile(`^(?:every|每隔|每)\s*(\d+)\s*(m|min|mins|minutes?|分钟|h|hr|hrs|hours?|小时|个小时)$`)
	intervalRE     = regexp.MustCompile(`^(\d+)\s*(m|min|mins|minutes?|分钟|h|hr|hrs|hours?|小时|个小时)$`)
	keptIntervalRE = regexp.MustCompile(`^(\d+)(m|h)$`)
)

// normRepeat: a repeat as people and agents write it, as it is kept: "", daily, weekdays, weekly, or an interval
// ("10m", "2h"). An interval is also read without "every" ("10m"), since the API's repeat field names one anyway.
// ok false: not a repeat; problem: an interval out of range.
func normRepeat(s string) (repeat string, ok bool, problem string) {
	s = strings.ToLower(strings.TrimSpace(s))
	if r, ok := repeats[s]; ok {
		return r, true, ""
	}
	m := everyRE.FindStringSubmatch(s)
	if m == nil {
		m = intervalRE.FindStringSubmatch(s)
	}
	if m == nil {
		return "", false, ""
	}
	n, _ := strconv.Atoi(m[1])
	d := time.Duration(n) * time.Minute
	if strings.HasPrefix(m[2], "h") || strings.Contains(m[2], "时") {
		d = time.Duration(n) * time.Hour
	}
	if d < minInterval || d > maxInterval {
		return "", true, "按间隔重复最短每 10 分钟、最长每 24 小时"
	}
	if d%time.Hour == 0 {
		return strconv.Itoa(int(d/time.Hour)) + "h", true, ""
	}
	return strconv.Itoa(int(d/time.Minute)) + "m", true, ""
}

// interval: how often an interval repeat fires; 0 for once, daily, weekdays, weekly.
func interval(repeat string) time.Duration {
	m := keptIntervalRE.FindStringSubmatch(repeat)
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	if m[2] == "h" {
		return time.Duration(n) * time.Hour
	}
	return time.Duration(n) * time.Minute
}

// repeatText: "每天 " / "每 10 分钟" for messages people read.
func repeatText(repeat string) string {
	if d := interval(repeat); d > 0 {
		if d%time.Hour == 0 {
			return fmt.Sprintf("每 %d 小时", d/time.Hour)
		}
		return fmt.Sprintf("每 %d 分钟", d/time.Minute)
	}
	return map[string]string{"daily": "每天", "weekdays": "每个工作日", "weekly": "每周"}[repeat]
}

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
	Repeat    string  `json:"repeat"` // "" | daily | weekdays | weekly | an interval: 10m, 2h
	Created   int64   `json:"created"`
	Fired     *int64  `json:"fired"`           // the last time it fired
	Seen      *int64  `json:"seen"`            // the last time its person dismissed it
	Done      bool    `json:"done"`            // nothing more scheduled
	Until     *int64  `json:"until,omitempty"` // it stops by itself after this (an agent's interval reminder)
}

const reminderCols = `id, by_user, by_agent, target_kind, target_id, channel_id, thread_id, message_id, text, due, repeat, created,
	fired, seen, done, until`

func scanReminders(rows *sql.Rows, err error) []reminderView {
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []reminderView{}
	for rows.Next() {
		var r reminderView
		if err := rows.Scan(&r.ID, &r.By, &r.ByAgent, &r.Target.Kind, &r.Target.ID, &r.ChannelID, &r.ThreadID, &r.MessageID, &r.Text,
			&r.Due, &r.Repeat, &r.Created, &r.Fired, &r.Seen, &r.Done, &r.Until); err != nil {
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

// nextDue: when a repeating reminder fires next after `due`, past `now`. Missed firings are not made up.
func nextDue(due time.Time, repeat string, now time.Time) time.Time {
	if d := interval(repeat); d > 0 {
		if due.After(now) {
			return due.Add(d)
		}
		return due.Add((now.Sub(due)/d + 1) * d)
	}
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

// parseRemind reads "/remind" words: [repeat] when [repeat] [@who] what. A daily, weekday or weekly repeat without
// a time starts at 9:00; an interval ("every 10m", "每 10 分钟", "每2小时") without one, an interval from now.
func parseRemind(s string, now time.Time) (due time.Time, repeat, who, what, problem string) {
	words := strings.Fields(s)
	takeRepeat := func() {
		if repeat != "" || problem != "" {
			return
		}
		for k := min(3, len(words)); k >= 1; k-- { // "每 10 分钟" is three words, "every 10m" two
			first := strings.ToLower(words[0])
			if k == 1 && intervalRE.MatchString(first) {
				return // "10m" alone is a time, not a repeat
			}
			if k > 1 && first != "every" && first != "每" && first != "每隔" {
				continue
			}
			if r, ok, bad := normRepeat(strings.Join(words[:k], " ")); ok && (r != "" || bad != "") {
				repeat, problem, words = r, bad, words[k:]
				return
			}
		}
	}
	takeRepeat()
	t, n := parseWhen(words, now)
	words = words[n:]
	takeRepeat()
	if problem != "" {
		return due, "", "", "", problem
	}
	if n == 0 {
		switch {
		case repeat == "":
			return due, "", "", "", "说一下什么时候：如 20m、2h、明天 9:00、周五 15:00、2026-12-01 10:00，或者 every 10m"
		case interval(repeat) > 0:
			t = now.Add(interval(repeat))
		default:
			t = at(now, reminderDefaultHour, 0)
			if !t.After(now) {
				t = t.AddDate(0, 0, 1)
			}
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
	Repeat    string `json:"repeat"`     // "" | daily | weekdays | weekly | an interval (10m, 2h)
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
	repeat, ok, bad := normRepeat(b.Repeat)
	if !ok {
		return reminderView{}, 400, "repeat 只能是 daily、weekdays、weekly 或间隔（如 10m、2h）"
	}
	if bad != "" {
		return reminderView{}, 400, bad
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
	case interval(repeat) > 0:
		due = now.Add(interval(repeat))
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
	// an agent's interval reminder: only for itself (people would get one every few minutes), a few at a time, and it
	// stops by itself after a day; a person who wants it longer sets it (or a trigger) themselves
	var until any
	if byAgent != "" && interval(repeat) > 0 {
		if target != setter {
			return reminderView{}, 400, "Agent 设的按间隔提醒只能提醒它自己（在这个线程里汇报）；要定时提醒人，用 daily、weekdays 或 weekly"
		}
		if h.count("SELECT COUNT(*) FROM reminders WHERE by_agent = ? AND done = 0 AND repeat GLOB '[0-9]*'", byAgent) >= maxAgentIntervals {
			return reminderView{}, 429, "这个 Agent 已经有 3 个按间隔的提醒了，先取消一个：remi reminders 看有哪些，remi remind cancel ID 取消"
		}
		until = now.Add(agentIntervalFor).UnixMilli()
	}

	id := newID("rem_")
	var th, ag any
	if thread != "" {
		th = thread
	}
	if byAgent != "" {
		ag = byAgent
	}
	h.must(h.db.Exec(`INSERT INTO reminders (id, by_user, by_agent, target_kind, target_id, channel_id, thread_id, message_id, text, due, repeat, created, until)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, by, ag, target.Kind, target.ID, c.ID, th, messageID, trimmed(text, maxReminderText),
		due.UnixMilli(), repeat, now.UnixMilli(), until))
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
//
// An interval reminder for an agent does not pile up: while the agent's task in its thread is still queued or
// running, that firing is skipped (the next one comes on time). Its first firing in a channel opens a thread, and the
// later ones go into that thread, so "every 10m" is one thread of reports, not a new thread every ten minutes.
func (h *Hub) fireReminders() {
	now := h.now()
	for _, r := range scanReminders(h.db.Query("SELECT "+reminderCols+" FROM reminders WHERE done = 0 AND due <= ? ORDER BY due", now.UnixMilli())) {
		next, done := nextDue(time.UnixMilli(r.Due).In(now.Location()), r.Repeat, now), r.Repeat == ""
		if r.Until != nil && next.UnixMilli() > *r.Until {
			done = true
		}
		every := interval(r.Repeat) > 0
		if every && r.Target.Kind == "agent" && r.ThreadID != nil && h.count(`SELECT COUNT(*) FROM tasks_v1 WHERE thread_id = ? AND agent_id = ?
			AND state IN (?, ?, ?)`, *r.ThreadID, r.Target.ID, taskPending, taskQueued, taskRunning) > 0 {
			h.must(h.db.Exec("UPDATE reminders SET due = ?, done = ? WHERE id = ?", next.UnixMilli(), done, r.ID))
			continue
		}
		fired := now.UnixMilli()
		if r.Target.Kind == "agent" {
			m, ok := h.remindAgent(r)
			if !ok {
				done = true // its person left the channel, or the agent is gone: it stops
			} else if every && r.ThreadID == nil {
				h.must(h.db.Exec("UPDATE reminders SET thread_id = ? WHERE id = ?", m, r.ID))
			}
		}
		h.must(h.db.Exec("UPDATE reminders SET fired = ?, due = ?, done = ? WHERE id = ?", fired, next.UnixMilli(), done, r.ID))
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

// remindAgent @s the agent where the reminder was set, in its person's name; dispatch takes it from there. It
// returns the message's id.
func (h *Hub) remindAgent(r reminderView) (string, bool) {
	a, ok := h.agent(r.Target.ID)
	if !ok || !h.isMember(r.ChannelID, "user", r.By) {
		return "", false
	}
	if c, ok := h.channel(r.ChannelID); !ok || c.Archived {
		return "", false
	}
	if r.ByAgent != nil && h.otherAgent(r.Text, *r.ByAgent) != "" { // set before agents' reminders were checked for this
		return "", false
	}
	m := h.insertMessage(r.ChannelID, r.ThreadID, member{"user", r.By}, "⏰ @"+a.Handle+" "+r.Text)
	h.onPosted(m, false)
	return m.ID, true
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
	if d := interval(r.Repeat); d > 0 {
		line += ", then every " + r.Repeat
		if r.Until != nil {
			line += " until " + time.UnixMilli(*r.Until).In(h.now().Location()).Format("2006-01-02 15:04") + " (skipped while you are still on it)"
		}
	} else if r.Repeat != "" {
		line += ", then " + r.Repeat
	}
	writeText(w, line+"\n")
}

// ---------------------------------------------------------------- an agent looking at and stopping its reminders

// agentReminders: the scheduled reminders an agent may see and cancel while it runs t: the ones it set, and the ones
// for it that are in t's thread or that t's person set (a person's "every morning @agent …" opens a new thread each
// time, so "this thread" alone would miss it).
func (h *Hub) agentReminders(t taskView, a agentView) []reminderView {
	return scanReminders(h.db.Query("SELECT "+reminderCols+` FROM reminders WHERE done = 0 AND (by_agent = ?
		OR (target_kind = 'agent' AND target_id = ? AND (thread_id = ? OR by_user = ?))) ORDER BY due LIMIT 100`,
		a.ID, a.ID, t.ThreadID, t.CreatedBy))
}

// endReminder: nothing more is scheduled for it (kept, done, so people can still see what it was).
func (h *Hub) endReminder(r reminderView) {
	h.must(h.db.Exec("UPDATE reminders SET done = 1 WHERE id = ?", r.ID))
	r, _ = h.reminder(r.ID)
	h.remindersChanged(r)
}

// endThreadReminders: a person closed or cancelled t, so the repeating reminders that would bring its agent back to
// its thread stop too. Done does not stop them: each report is done, and the next one reopens it.
func (h *Hub) endThreadReminders(t taskView) {
	for _, r := range scanReminders(h.db.Query("SELECT "+reminderCols+` FROM reminders WHERE done = 0 AND repeat != ''
		AND target_kind = 'agent' AND target_id = ? AND thread_id = ?`, t.AgentID, t.ThreadID)) {
		h.endReminder(r)
	}
}

// reminderLine: one reminder as remi shows it.
func (h *Hub) reminderLine(r reminderView, a agentView) string {
	loc := h.now().Location()
	who := "you"
	if r.Target.Kind == "user" {
		if u, ok := h.user(r.Target.ID); ok {
			who = "@" + u.Handle
		}
	} else if r.Target.ID != a.ID {
		who = "@" + h.agentHandle(r.Target.ID)
	}
	line := r.ID + "  for " + who + "  next " + time.UnixMilli(r.Due).In(loc).Format("2006-01-02 15:04 Mon")
	switch {
	case interval(r.Repeat) > 0:
		line += "  every " + r.Repeat
	case r.Repeat != "":
		line += "  " + r.Repeat
	default:
		line += "  once"
	}
	if r.Until != nil {
		line += "  until " + time.UnixMilli(*r.Until).In(loc).Format("2006-01-02 15:04")
	}
	set := "you"
	if r.ByAgent == nil || *r.ByAgent != a.ID {
		set = "@" + r.By
		if u, ok := h.user(r.By); ok {
			set = "@" + u.Handle
		}
	}
	return line + "  set by " + set + "  " + r.Text
}

// v1AgentReminders: `remi reminders`, what remi remind cancel can stop.
func (h *Hub) v1AgentReminders(w http.ResponseWriter, q *request) {
	t, a, ok := h.reader(w, q)
	if !ok {
		return
	}
	rs := h.agentReminders(t, a)
	if len(rs) == 0 {
		writeText(w, "no reminders\n")
		return
	}
	var b strings.Builder
	for _, r := range rs {
		b.WriteString(h.reminderLine(r, a) + "\n")
	}
	writeText(w, b.String())
}

// v1AgentRemindCancel: `remi remind cancel ID…` or `remi remind cancel --here` (the repeating and scheduled ones for
// the agent itself in this task's thread). Only ones remi reminders lists.
func (h *Hub) v1AgentRemindCancel(w http.ResponseWriter, q *request) {
	t, a, ok := h.reader(w, q)
	if !ok {
		return
	}
	words := strings.Fields(string(q.body))
	if len(words) == 0 {
		errJSON(w, 400, "说一下取消哪个：remi remind cancel ID（remi reminders 里看），或 remi remind cancel --here")
		return
	}
	mine := map[string]reminderView{}
	for _, r := range h.agentReminders(t, a) {
		mine[r.ID] = r
	}
	var stop []reminderView
	for _, wd := range words {
		if wd == "--here" {
			for _, r := range mine {
				if r.Target == (member{"agent", a.ID}) && r.ThreadID != nil && *r.ThreadID == t.ThreadID {
					stop = append(stop, r)
				}
			}
			continue
		}
		r, ok := mine[wd]
		if !ok {
			errJSON(w, 404, "没有你能取消的提醒 "+wd+"：remi reminders 看有哪些")
			return
		}
		stop = append(stop, r)
	}
	if len(stop) == 0 {
		writeText(w, "no reminders for you in this thread\n")
		return
	}
	var b strings.Builder
	done := map[string]bool{}
	for _, r := range stop {
		if done[r.ID] {
			continue
		}
		done[r.ID] = true
		h.endReminder(r)
		b.WriteString("cancelled " + h.reminderLine(r, a) + "\n")
	}
	writeText(w, b.String())
}
