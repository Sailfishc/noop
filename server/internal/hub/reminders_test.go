package hub

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestParseWhen(t *testing.T) {
	now := time.Date(2026, 11, 8, 10, 0, 0, 0, time.UTC) // a Sunday, 10:00
	cases := []struct {
		in   string
		want string // "" = not a time
		used int
	}{
		{"20m", "2026-11-08 10:20", 1},
		{"2h 看", "2026-11-08 12:00", 1},
		{"3天后", "2026-11-11 10:00", 1},
		{"9:30", "2026-11-09 09:30", 1}, // past today: tomorrow
		{"14:00", "2026-11-08 14:00", 1},
		{"15点半", "2026-11-08 15:30", 1},
		{"明天", "2026-11-09 09:00", 1},
		{"tomorrow 8:15", "2026-11-09 08:15", 2},
		{"周五 15:00", "2026-11-13 15:00", 2},
		{"周日 9:00", "2026-11-15 09:00", 2}, // today's has passed: next week's
		{"2026-12-01 10:00", "2026-12-01 10:00", 2},
		{"1-5", "2027-01-05 09:00", 1},
		{"今天 8:00", "", 0},
		{"看一下", "", 0},
		{"25:00", "", 0},
	}
	for _, c := range cases {
		got, n := parseWhen(strings.Fields(c.in), now)
		s := ""
		if n > 0 {
			s = got.Format("2006-01-02 15:04")
		}
		if s != c.want || n != c.used {
			t.Errorf("parseWhen(%q) = %q, %d; want %q, %d", c.in, s, n, c.want, c.used)
		}
	}

	due, repeat, who, what, problem := parseRemind("工作日 9:30 @acha 汇总昨天的告警", now)
	check(t, "a repeating one for an agent", problem == "" && repeat == "weekdays" && who == "acha" && what == "汇总昨天的告警" &&
		due.Format("2006-01-02 15:04") == "2026-11-09 09:30")
	due, repeat, _, what, _ = parseRemind("每周 交周报", now)
	check(t, "a repeat without a time: 9:00", repeat == "weekly" && what == "交周报" && due.Format("15:04") == "09:00")
	_, _, _, _, problem = parseRemind("交周报", now)
	check(t, "no time", problem != "")
	check(t, "weekdays skip the weekend", nextDue(time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC), "weekdays", now).Weekday() == time.Monday)
	check(t, "missed days fire once, then the next", nextDue(time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC), "daily", now).Format("01-02 15:04") == "11-09 09:00")
}

func TestReminders(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	m := e.post(e.ll.session, "周五前要把对账脚本改完", "")
	list := func(s string) []any { return e.do("GET", "/api/v1/reminders", s, nil).body["reminders"].([]any) }

	// a message's "remind me later"
	r := e.do("POST", "/api/v1/reminders", e.wl.session, map[string]any{"message_id": m["id"], "when": "20m"})
	check(t, "set", r.status == 200 && r.body["text"] == "周五前要把对账脚本改完" && r.body["target"].(map[string]any)["id"] == e.wl.id &&
		r.body["thread_id"] == m["id"], r)
	rid := r.body["id"].(string)
	check(t, "I see it scheduled; nobody else does", len(list(e.wl.session)) == 1 && len(list(e.ll.session)) == 0 && len(list(e.zw.session)) == 0)
	check(t, "a time that cannot be read", e.do("POST", "/api/v1/reminders", e.wl.session, map[string]any{"message_id": m["id"], "when": "等会儿"}).status == 400)
	check(t, "not in a channel I am not in", e.do("POST", "/api/v1/reminders", e.zw.session, map[string]any{"command": "1h 看", "channel_id": "nope"}).status == 404)

	e.h.Tick()
	check(t, "not yet", list(e.wl.session)[0].(map[string]any)["fired"] == nil)
	e.advance(21 * time.Minute)
	e.h.Tick()
	got := list(e.wl.session)
	check(t, "it went off and waits for me", len(got) == 1 && got[0].(map[string]any)["fired"] != nil && got[0].(map[string]any)["done"] == true)
	r = e.do("POST", "/api/v1/reminders/"+rid+"/seen", e.wl.session, map[string]any{"when": "1h"})
	check(t, "snoozed: a new one, with the message", r.status == 200 && r.body["id"] != rid && r.body["message_id"] == m["id"], r)
	got = list(e.wl.session)
	check(t, "the old one is gone from my list", len(got) == 1 && got[0].(map[string]any)["id"] == r.body["id"])
	check(t, "someone else cannot cancel it", e.do("DELETE", "/api/v1/reminders/"+r.body["id"].(string), e.ll.session, nil).status == 404)
	check(t, "I can", e.do("DELETE", "/api/v1/reminders/"+r.body["id"].(string), e.wl.session, nil).status == 200 && len(list(e.wl.session)) == 0)

	// someone else, by /remind
	r = e.do("POST", "/api/v1/reminders", e.wl.session, map[string]any{"command": "2h @liuli 交对账报告", "channel_id": e.cid})
	check(t, "for someone in the channel", r.status == 200 && r.body["target"].(map[string]any)["id"] == e.ll.id && r.body["text"] == "交对账报告", r)
	check(t, "both see it", len(list(e.wl.session)) == 1 && len(list(e.ll.session)) == 1)
	other := e.do("POST", "/api/v1/channels", e.zw.session, map[string]any{"name": "机密"}).body["id"].(string)
	check(t, "not someone outside the channel", e.do("POST", "/api/v1/reminders", e.zw.session, map[string]any{"command": "2h @liuli 看", "channel_id": other}).status == 403)
	check(t, "not in a channel I am not in", e.do("POST", "/api/v1/reminders", e.wl.session, map[string]any{"command": "2h 看", "channel_id": other}).status == 403)
	e.advance(2*time.Hour + time.Minute)
	e.h.Tick()
	got = list(e.ll.session)
	check(t, "it waits for the one reminded", len(got) == 1 && got[0].(map[string]any)["fired"] != nil)
	check(t, "and is no longer the setter's", len(list(e.wl.session)) == 0)
	e.do("POST", "/api/v1/reminders/"+got[0].(map[string]any)["id"].(string)+"/seen", e.ll.session, nil)
	check(t, "dismissed", len(list(e.ll.session)) == 0)

	// an agent, every day: it is @-ed in its person's name, and the @ dispatches
	r = e.do("POST", "/api/v1/reminders", e.wl.session, map[string]any{"command": "每天 9:00 @acha 汇总昨天的告警", "channel_id": e.cid})
	check(t, "daily for an agent", r.status == 200 && r.body["repeat"] == "daily" && r.body["target"].(map[string]any)["kind"] == "agent", r)
	rid = r.body["id"].(string)
	first := r.body["due"].(float64)
	e.advance(24 * time.Hour)
	e.h.Tick()
	ms := e.do("GET", "/api/v1/channels/"+e.cid+"/messages", e.wl.session, nil).body["messages"].([]any)
	last := ms[len(ms)-1].(map[string]any)
	check(t, "the agent is @-ed by the person", strings.HasPrefix(last["text"].(string), "⏰ @acha 汇总昨天的告警") &&
		last["author"].(map[string]any)["id"] == e.wl.id)
	tasks := e.do("GET", "/api/v1/tasks?thread="+last["id"].(string), e.wl.session, nil).body["tasks"].([]any)
	check(t, "and it is a task for it", len(tasks) == 1)
	rem, _ := e.h.reminder(rid)
	check(t, "and it is due again a day later", float64(rem.Due) == first+float64(24*time.Hour/time.Millisecond) && !rem.Done)

	// an agent while it runs
	id := tasks[0].(map[string]any)["id"].(string)
	tok := e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil).body["read_token"].(string)
	r = e.do("POST", "/api/v1/agent/remind", tok, bytes.NewBufferString("明天 10:00 再看一下有没有新告警"), "content-type", "text/plain")
	check(t, "remi remind: itself, in the task's thread", r.status == 200 && strings.HasPrefix(string(r.raw), "reminder rem_") && strings.Contains(string(r.raw), ": you at "), r)
	r = e.do("POST", "/api/v1/agent/remind", tok, bytes.NewBufferString("2h @wanglei 确认告警阈值"), "content-type", "text/plain")
	check(t, "or a person", r.status == 200 && strings.Contains(string(r.raw), "@wanglei"), r)
	check(t, "the person sees what the agent set in their name", len(list(e.wl.session)) == 3)
	check(t, "a bad time", e.do("POST", "/api/v1/agent/remind", tok, bytes.NewBufferString("回头 看"), "content-type", "text/plain").status == 400)
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "汇总好了"})
	check(t, "in review", e.task(id)["state"] == "review")
	e.advance(30 * time.Hour)
	e.h.Tick()
	check(t, "its own reminder brings the task back", e.task(id)["state"] == "queued", resp{raw: []byte(e.task(id)["state"].(string))})
}
