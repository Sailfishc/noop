package hub

import (
	"bytes"
	"fmt"
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

	// an agent, every day: woken silently without a ⏰ message in its person's name (ADR 0003)
	beforeMsgs := len(e.do("GET", "/api/v1/channels/"+e.cid+"/messages", e.wl.session, nil).body["messages"].([]any))
	r = e.do("POST", "/api/v1/reminders", e.wl.session, map[string]any{"command": "每天 9:00 @acha 汇总昨天的告警", "channel_id": e.cid})
	check(t, "daily for an agent", r.status == 200 && r.body["repeat"] == "daily" && r.body["target"].(map[string]any)["kind"] == "agent", r)
	rid = r.body["id"].(string)
	first := r.body["due"].(float64)
	e.advance(24 * time.Hour)
	e.h.Tick()
	ms := e.do("GET", "/api/v1/channels/"+e.cid+"/messages", e.wl.session, nil).body["messages"].([]any)
	check(t, "no ⏰ message posted when the reminder fires", len(ms) == beforeMsgs)
	tasks := e.do("GET", "/api/v1/tasks?state=queued", e.wl.session, nil).body["tasks"].([]any)
	check(t, "and a quiet task is queued for it", len(tasks) == 1 && tasks[0].(map[string]any)["quiet"] == true)
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
	ms = e.do("GET", "/api/v1/channels/"+e.cid+"/messages", e.wl.session, nil).body["messages"].([]any)
	check(t, "in review, and the agent's own words opened the thread", e.task(id)["state"] == "review" && len(ms) == beforeMsgs+1 &&
		ms[len(ms)-1].(map[string]any)["text"] == "汇总好了" && ms[len(ms)-1].(map[string]any)["author"].(map[string]any)["kind"] == "agent")
	e.advance(30 * time.Hour)
	e.h.Tick()
	check(t, "its own reminder brings the task back", e.task(id)["state"] == "queued", resp{raw: []byte(e.task(id)["state"].(string))})
}

func TestIntervalRepeats(t *testing.T) {
	now := time.Date(2026, 11, 8, 10, 0, 0, 0, time.UTC)
	for in, want := range map[string]string{"every 10m": "10m", "每 10 分钟": "10m", "每10分钟": "10m", "每隔 30 分钟": "30m", "every 2h": "2h",
		"每 2 小时": "2h", "120m": "2h", "every 90 minutes": "90m"} {
		got, ok, bad := normRepeat(in)
		check(t, "normRepeat "+in, ok && bad == "" && got == want, resp{raw: []byte(got + " " + bad)})
	}
	_, ok, bad := normRepeat("every 5m")
	check(t, "under 10 minutes is refused", ok && bad != "")
	_, ok, _ = normRepeat("看一下")
	check(t, "not a repeat", !ok)

	due, repeat, who, what, problem := parseRemind("every 10m @acha 看一下 MR 的进展", now)
	check(t, "/remind every 10m: first one in 10 minutes", problem == "" && repeat == "10m" && who == "acha" && what == "看一下 MR 的进展" &&
		due.Format("15:04") == "10:10")
	due, repeat, _, what, _ = parseRemind("每 2 小时 汇报", now)
	check(t, "每 2 小时", repeat == "2h" && what == "汇报" && due.Format("15:04") == "12:00")
	due, repeat, _, _, _ = parseRemind("每30分钟 14:00 看", now)
	check(t, "an interval from a time", repeat == "30m" && due.Format("15:04") == "14:00")
	_, repeat, _, what, _ = parseRemind("10m 看一下", now)
	check(t, "10m alone is still a time", repeat == "" && what == "看一下")
	_, _, _, _, problem = parseRemind("every 1m 刷", now)
	check(t, "every minute is refused", problem != "")
	check(t, "next: missed ones are not made up", nextDue(now.Add(-35*time.Minute), "10m", now).Format("15:04") == "10:05")
	check(t, "next: on time", nextDue(now, "10m", now).Format("15:04") == "10:10")
}

func TestIntervalReminders(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	list := func(s string) []any { return e.do("GET", "/api/v1/reminders", s, nil).body["reminders"].([]any) }
	msgs := func() []any {
		return e.do("GET", "/api/v1/channels/"+e.cid+"/messages", e.wl.session, nil).body["messages"].([]any)
	}

	// a person: every 10 minutes, have @acha report. One thread, and no new @ while the agent is still on it.
	r := e.do("POST", "/api/v1/reminders", e.wl.session, map[string]any{"command": "每 10 分钟 @acha 看一下 MR 的进展", "channel_id": e.cid})
	check(t, "set", r.status == 200 && r.body["repeat"] == "10m" && r.body["until"] == nil, r)
	rid := r.body["id"].(string)
	e.advance(10*time.Minute + time.Second)
	e.h.Tick()
	rem, _ := e.h.reminder(rid)
	check(t, "it fired, opened a thread and stays on it", rem.Fired != nil && rem.ThreadID != nil && !rem.Done)
	thread := *rem.ThreadID
	tasks := e.do("GET", "/api/v1/tasks?thread="+thread, e.wl.session, nil).body["tasks"].([]any)
	check(t, "a task for @acha", len(tasks) == 1 && tasks[0].(map[string]any)["state"] == "queued")
	n := len(msgs())
	e.advance(10 * time.Minute)
	e.h.Tick()
	rem, _ = e.h.reminder(rid)
	check(t, "still queued: skipped, no new message", len(msgs()) == n && rem.Due > e.now().UnixMilli())
	id := tasks[0].(map[string]any)["id"].(string)
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "nothing", "summary": "MR !12 还没变"})
	rem, _ = e.h.reminder(rid)
	check(t, "silent check: no message posted, checks=1, no_change=1", len(msgs()) == n && rem.Checks == 1 && rem.NoChange == 1 && rem.LastOutcome == "nothing")
	e.advance(10 * time.Minute)
	e.h.Tick()
	check(t, "done with the last one: the next goes into the same thread", e.task(id)["state"] == "queued")
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "MR !12 还在等 CI"})
	rem, _ = e.h.reminder(rid)
	check(t, "when it speaks: one root message in the agent's own words, never ⏰", len(msgs()) == n+1 &&
		msgs()[len(msgs())-1].(map[string]any)["text"] == "MR !12 还在等 CI" && rem.Checks == 2 && rem.NoChange == 1)
	e.advance(10 * time.Minute)
	e.h.Tick()
	check(t, "next check wakes the same thread", e.task(id)["state"] == "queued")

	// an agent: only for itself, at most 3, and it stops after a day
	tok := e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil).body["read_token"].(string)
	r = e.do("POST", "/api/v1/agent/remind", tok, bytes.NewBufferString("every 10m @wanglei 看 MR"), "content-type", "text/plain")
	check(t, "an agent can't ping a person every 10 minutes", r.status == 400, r)
	r = e.do("POST", "/api/v1/agent/remind", tok, bytes.NewBufferString("every 30m 看一下 MR 和 CI，有变化就汇报"), "content-type", "text/plain")
	check(t, "itself, in this thread", r.status == 200 && strings.Contains(string(r.raw), "then every 30m until"), r)
	for range 2 {
		e.do("POST", "/api/v1/agent/remind", tok, bytes.NewBufferString("every 1h 看"), "content-type", "text/plain")
	}
	check(t, "a fourth is refused", e.do("POST", "/api/v1/agent/remind", tok, bytes.NewBufferString("every 2h 看"), "content-type", "text/plain").status == 429)
	check(t, "the person sees them", len(list(e.wl.session)) == 4)
	e.advance(25 * time.Hour)
	e.h.Tick()
	open := 0
	for _, x := range list(e.wl.session) {
		if x.(map[string]any)["by_agent"] != nil && x.(map[string]any)["done"] == false {
			open++
		}
	}
	check(t, "after a day they stop", open == 0)
	check(t, "every 5 minutes is refused", e.do("POST", "/api/v1/reminders", e.wl.session, map[string]any{"command": "every 5m @acha 看", "channel_id": e.cid}).status == 400)
}

func TestAgentCancelsReminders(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	text := func(r resp) string { return string(r.raw) }
	remind := func(tok, s string) resp {
		return e.do("POST", "/api/v1/agent/remind", tok, bytes.NewBufferString(s), "content-type", "text/plain")
	}
	cancel := func(tok, s string) resp {
		return e.do("POST", "/api/v1/agent/remind/cancel", tok, bytes.NewBufferString(s), "content-type", "text/plain")
	}
	run := func(thread string) string {
		id := e.do("GET", "/api/v1/tasks?thread="+thread, e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
		return e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil).body["read_token"].(string)
	}

	// "@acha report every 10 minutes": it sets its own interval reminder in the thread
	id, tok, _ := e.claimed("@acha 每 10 分钟汇报一下 MR 的进展")
	r := remind(tok, "every 10m 看一下 MR，有变化就汇报")
	check(t, "set", r.status == 200, r)
	rid := strings.Fields(strings.TrimPrefix(text(r), "reminder "))[0]
	rid = strings.TrimSuffix(rid, ":")
	r = remind(tok, "2h @wanglei 看一下 MR 有没有合并")
	check(t, "and one for its person", r.status == 200, r)
	pid := strings.TrimSuffix(strings.Fields(strings.TrimPrefix(text(r), "reminder "))[0], ":")
	other := e.do("POST", "/api/v1/reminders", e.ll.session, map[string]any{"command": "2h 交对账报告", "channel_id": e.cid})
	check(t, "someone else's own reminder", other.status == 200, other)

	r = e.do("GET", "/api/v1/agent/reminders", tok, nil)
	check(t, "remi reminders: the ones it set", r.status == 200 && strings.Contains(text(r), rid) && strings.Contains(text(r), "every 10m") &&
		strings.Contains(text(r), "until") && strings.Contains(text(r), pid) && strings.Contains(text(r), "for @wanglei") &&
		!strings.Contains(text(r), other.body["id"].(string)), r)
	check(t, "not someone else's", cancel(tok, other.body["id"].(string)).status == 404)
	check(t, "nothing to cancel", cancel(tok, "").status == 400)

	// "可以先暂停": it stops what brings it back here
	r = cancel(tok, "--here")
	check(t, "remi remind cancel --here", r.status == 200 && strings.Contains(text(r), "cancelled "+rid) && !strings.Contains(text(r), pid), r)
	rem, _ := e.h.reminder(rid)
	check(t, "it is done", rem.Done)
	r = cancel(tok, pid)
	check(t, "remi remind cancel ID", r.status == 200 && strings.Contains(text(r), "cancelled "+pid), r)
	check(t, "nothing left", text(e.do("GET", "/api/v1/agent/reminders", tok, nil)) == "no reminders\n")
	check(t, "a cancelled one can't be cancelled again", cancel(tok, rid).status == 404)
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "停了"})
	e.advance(11 * time.Minute)
	e.h.Tick()
	check(t, "and it does not come back", e.task(id)["state"] == "review")

	// a person's "every morning @acha …" opens a new thread each time; the agent can still stop it from there
	daily := e.do("POST", "/api/v1/reminders", e.zw.session, map[string]any{"command": "每天 9:00 @acha 汇总告警", "channel_id": e.cid})
	e.advance(24 * time.Hour)
	e.h.Tick()
	qts := e.do("GET", "/api/v1/tasks?state=queued", e.zw.session, nil).body["tasks"].([]any)
	fired := qts[len(qts)-1].(map[string]any)["thread_id"].(string)
	tok2 := run(fired)
	check(t, "its person's daily one is listed", strings.Contains(text(e.do("GET", "/api/v1/agent/reminders", tok2, nil)), daily.body["id"].(string)))
	check(t, "and can be stopped", cancel(tok2, daily.body["id"].(string)).status == 200)

	// closing or cancelling the task stops its thread's repeating reminders; done does not
	id, tok, _ = e.claimed("@acha 每 30 分钟看一下 CI")
	rid = strings.TrimSuffix(strings.Fields(strings.TrimPrefix(text(remind(tok, "every 30m 看 CI")), "reminder "))[0], ":")
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "CI 绿了"})
	check(t, "accepted", e.do("POST", "/api/v1/tasks/"+id+"/accept", e.zw.session, nil).status == 200 && e.task(id)["status"] == "done")
	rem, _ = e.h.reminder(rid)
	check(t, "done: it goes on", !rem.Done)
	e.do("POST", "/api/v1/tasks/"+id+"/reopen", e.zw.session, nil)
	r = e.do("POST", "/api/v1/tasks/"+id+"/cancel", e.zw.session, nil)
	rem, _ = e.h.reminder(rid)
	check(t, "closed: it stops", r.status == 200 && rem.Done, r)
}

func TestPauseAndWhoMayStop(t *testing.T) {
	e := newTaskEnv(t, "channel", false) // @acha is 王磊's; 张伟 is an admin; 刘丽 is neither
	r := e.do("POST", "/api/v1/reminders", e.ll.session, map[string]any{"command": "每 10 分钟 @acha 看一下 MR 的进展", "channel_id": e.cid})
	check(t, "刘丽 has @acha report every 10 minutes", r.status == 200 && r.body["paused"] == false, r)
	rid := r.body["id"].(string)
	e.advance(10*time.Minute + time.Second)
	e.h.Tick()
	rem, _ := e.h.reminder(rid)
	thread := *rem.ThreadID
	task := e.do("GET", "/api/v1/tasks?thread="+thread, e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)
	rs := task["reminders"].([]any)
	check(t, "its task carries it (the ⏰ on the card)", len(rs) == 1 && rs[0].(map[string]any)["id"] == rid, resp{raw: []byte(fmt.Sprint(task["reminders"]))})
	ch := e.do("GET", "/api/v1/reminders/channel?channel="+e.cid, e.wl.session, nil)
	check(t, "and the channel's 临时 duties", ch.status == 200 && len(ch.body["reminders"].([]any)) == 1, ch)
	once := e.do("POST", "/api/v1/reminders", e.ll.session, map[string]any{"command": "2h @acha 看一下", "channel_id": e.cid, "thread_id": thread})
	check(t, "a one-off is not a duty", len(e.do("GET", "/api/v1/reminders/channel?channel="+e.cid, e.wl.session, nil).body["reminders"].([]any)) == 1)

	// who may stop one for an agent: who set it, the agent's owner, an admin
	pause := func(s string, paused bool) resp {
		return e.do("PATCH", "/api/v1/reminders/"+rid, s, map[string]any{"paused": paused})
	}
	check(t, "the agent's owner may pause it", pause(e.wl.session, true).status == 200)
	rem, _ = e.h.reminder(rid)
	check(t, "paused", rem.Paused && !rem.Done)
	id := task["id"].(string)
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "还在等 CI"})
	n := len(e.do("GET", "/api/v1/channels/"+e.cid+"/messages", e.zw.session, nil).body["messages"].([]any))
	e.advance(30 * time.Minute)
	e.h.Tick()
	rem, _ = e.h.reminder(rid)
	check(t, "paused: it does not go off, and its time moves on", e.task(id)["state"] != "queued" && rem.Due > e.now().UnixMilli() &&
		len(e.do("GET", "/api/v1/channels/"+e.cid+"/messages", e.zw.session, nil).body["messages"].([]any)) == n)
	check(t, "an admin may resume it", pause(e.zw.session, false).status == 200)
	e.advance(10 * time.Minute)
	e.h.Tick()
	rem, _ = e.h.reminder(rid)
	check(t, "resumed: it brings the agent back", e.task(id)["state"] == "queued", resp{raw: []byte(fmt.Sprint(e.task(id)["state"], rem.Fired, rem.Due, e.now().UnixMilli(), rem.Paused))})
	check(t, "a one-off can't be paused", e.do("PATCH", "/api/v1/reminders/"+once.body["id"].(string), e.ll.session, map[string]any{"paused": true}).status == 409)

	// someone else's reminder for a person stays theirs
	mine := e.do("POST", "/api/v1/reminders", e.ll.session, map[string]any{"command": "每天 9:00 交日报", "channel_id": e.cid})
	check(t, "not even an admin pauses someone's own reminder", e.do("PATCH", "/api/v1/reminders/"+mine.body["id"].(string), e.zw.session, map[string]any{"paused": true}).status == 404)
	check(t, "or cancels it", e.do("DELETE", "/api/v1/reminders/"+mine.body["id"].(string), e.zw.session, nil).status == 404)
	check(t, "the owner cancels the one for its agent", e.do("DELETE", "/api/v1/reminders/"+rid, e.wl.session, nil).status == 200)
	_, ok := e.h.reminder(rid)
	check(t, "gone", !ok)
}

func TestAgentPausesReminders(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	act := func(tok, verb, s string) resp {
		return e.do("POST", "/api/v1/agent/remind/"+verb, tok, bytes.NewBufferString(s), "content-type", "text/plain")
	}
	id, tok, _ := e.claimed("@acha 每 10 分钟汇报一下 MR 的进展")
	r := e.do("POST", "/api/v1/agent/remind", tok, bytes.NewBufferString("every 10m 看 MR"), "content-type", "text/plain")
	rid := strings.TrimSuffix(strings.Fields(strings.TrimPrefix(string(r.raw), "reminder "))[0], ":")
	e.do("POST", "/api/v1/agent/remind", tok, bytes.NewBufferString("2h 再看一次"), "content-type", "text/plain")

	r = act(tok, "pause", "--here")
	check(t, "remi remind pause --here: the repeating one", r.status == 200 && strings.HasPrefix(string(r.raw), "paused "+rid) &&
		strings.Count(string(r.raw), "\n") == 1, r)
	check(t, "remi reminders says so", strings.Contains(string(e.do("GET", "/api/v1/agent/reminders", tok, nil).raw), "paused"))
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "先停"})
	e.advance(25 * time.Minute)
	e.h.Tick()
	check(t, "it does not come back while paused", e.task(id)["state"] != "queued", resp{raw: []byte(e.task(id)["state"].(string))})
	e.do("POST", "/api/v1/tasks/"+id+"/accept", e.zw.session, nil)
	check(t, "reopened", e.do("POST", "/api/v1/tasks/"+id+"/reopen", e.zw.session, map[string]any{"note": "继续吧"}).status == 200)
	tok = e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil).body["read_token"].(string)
	r = act(tok, "resume", rid)
	check(t, "remi remind resume ID", r.status == 200 && strings.HasPrefix(string(r.raw), "resumed "+rid), r)
	rem, _ := e.h.reminder(rid)
	check(t, "on again", !rem.Paused)
	check(t, "not someone else's", act(tok, "pause", "rem_nope").status == 404)

	// paused, it still ends on time
	act(tok, "pause", rid)
	e.advance(25 * time.Hour)
	e.h.Tick()
	rem, _ = e.h.reminder(rid)
	check(t, "a paused one still stops after a day", rem.Done)
}
