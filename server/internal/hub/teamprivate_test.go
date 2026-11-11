package hub

import (
	"bytes"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// frames: what a person's live connection received (a socket registered straight with the hub, as v1Stream does).
type frames struct {
	mu  sync.Mutex
	got []string
	k   *sock
}

func (e *env) listen(userID string) *frames {
	f := &frames{k: &sock{out: make(chan []byte, 10000), tags: []string{"people", "u:" + userID}}}
	e.h.socks.add(f.k)
	return f
}

// all: the frames so far.
func (f *frames) all() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	for {
		select {
		case b := <-f.k.out:
			f.got = append(f.got, string(b))
		default:
			return strings.Join(f.got, "\n")
		}
	}
}

type privEnv struct {
	*taskEnv
	pid, slug, mid, tid, fid, trg string
}

// newPrivEnv: on top of newTaskEnv's public channel (张伟 admin, 王磊 who owns @acha, 刘丽), 王磊's private channel
// 「私房菜」 with @acha in it, where a task ran and left an output, a thread reply, an attachment and a trigger.
// The secret word in all of it is "zebra".
func newPrivEnv(t *testing.T, base *taskEnv) *privEnv {
	e := &privEnv{taskEnv: base}
	r := e.do("POST", "/api/v1/channels", e.wl.session, map[string]any{"name": "私房菜 zebra", "topic": "zebra 的项目", "private": true,
		"members": []any{map[string]any{"kind": "agent", "id": e.aid}}})
	check(t, "a private channel", r.status == 200 && r.body["private"] == true && r.body["created_by"] == e.wl.id, r)
	e.pid, e.slug = r.body["id"].(string), r.body["slug"].(string)
	check(t, "its slug says nothing of its name", strings.HasPrefix(e.slug, "p-"), r)
	up := e.do("POST", "/api/v1/uploads?name="+url.QueryEscape("zebra.pdf"), e.wl.session, bytes.NewBufferString("%PDF zebra"), "content-type", "application/pdf")
	r = e.do("POST", "/api/v1/channels/"+e.pid+"/messages", e.wl.session, map[string]any{"text": "@acha 把 zebra 菜谱整理一下", "attachments": []any{up.body["path"]}})
	check(t, "posted", r.status == 200, r)
	e.mid = r.body["id"].(string)
	e.do("POST", "/api/v1/channels/"+e.pid+"/messages", e.wl.session, map[string]any{"text": "zebra 要少放盐", "thread_id": e.mid})
	ts := e.do("GET", "/api/v1/tasks?thread="+e.mid, e.wl.session, nil).body["tasks"].([]any)
	check(t, "a task", len(ts) == 1)
	e.tid = ts[0].(map[string]any)["id"].(string)
	r = e.do("POST", "/api/v1/tasks/"+e.tid+"/claim", e.token, nil)
	check(t, "its own agent runs it at once", r.status == 200, r)
	r = e.do("POST", "/api/v1/tasks/"+e.tid+"/outputs/file?name=zebra.md", e.token, bytes.NewBufferString("# zebra"), "content-type", "")
	e.fid = r.body["id"].(string)
	r = e.do("POST", "/api/v1/tasks/"+e.tid+"/report", e.token, map[string]any{"state": "review", "summary": "zebra 菜谱整理好了", "run": 1})
	check(t, "reported", r.status == 200, r)
	r = e.do("POST", "/api/v1/triggers", e.wl.session, map[string]any{"channel_id": e.pid, "agent": "acha", "kind": "schedule", "when": "9:00", "repeat": "daily", "text": "zebra 日报"})
	check(t, "a trigger", r.status == 200, r)
	e.trg = r.body["id"].(string)
	r = e.do("POST", "/api/v1/reminders", e.wl.session, map[string]any{"message_id": e.mid, "when": "20m"})
	check(t, "a reminder", r.status == 200, r)
	return e
}

// Everything in a private channel, asked for by someone not in it (a member and an admin): nothing comes back, and
// a "not found" looks the same as for a channel that never was.
func TestPrivateChannelOutsiders(t *testing.T) {
	e := newTaskEnv(t, "channel", true)
	llLive, zwLive := e.listen(e.ll.id), e.listen(e.zw.id)
	p := newPrivEnv(t, e)
	for _, o := range []struct {
		name, session string
	}{{"a member", e.ll.session}, {"an admin", e.zw.session}} {
		get := func(path string) resp { return e.do("GET", path, o.session, nil) }
		is404 := func(what string, r resp) { t.Helper(); check(t, o.name+": "+what+" is not found", r.status == 404, r) }
		hasNot := func(what string, r resp) {
			t.Helper()
			check(t, o.name+": "+what+" has no trace of it", r.status == 200 && !strings.Contains(string(r.raw), "zebra") &&
				!strings.Contains(string(r.raw), p.pid) && !strings.Contains(string(r.raw), p.tid), r)
		}
		hasNot("the channel list", get("/api/v1/channels"))
		hasNot("the archived channel list", get("/api/v1/channels?archived=1"))
		is404("the channel", get("/api/v1/channels/"+p.pid))
		is404("the channel by slug", get("/api/v1/channels/"+p.slug))
		is404("its messages", get("/api/v1/channels/"+p.pid+"/messages"))
		is404("a thread", get("/api/v1/messages/"+p.mid+"/thread"))
		is404("an attachment list", get("/api/v1/messages/"+p.mid+"/attachments"))
		is404("editing a message", e.do("PATCH", "/api/v1/messages/"+p.mid, o.session, map[string]any{"text": "x"}))
		is404("posting", e.do("POST", "/api/v1/channels/"+p.pid+"/messages", o.session, map[string]any{"text": "x"}))
		is404("joining", e.do("POST", "/api/v1/channels/"+p.pid+"/members", o.session, map[string]any{}))
		is404("changing it", e.do("PATCH", "/api/v1/channels/"+p.pid, o.session, map[string]any{"name": "x", "archived": true}))
		is404("removing someone", e.do("DELETE", "/api/v1/channels/"+p.pid+"/members/user/"+e.wl.id, o.session, nil))
		hasNot("search", get("/api/v1/search?q=zebra"))
		hasNot("search for a short word", get("/api/v1/search?q="+url.QueryEscape("盐")))
		is404("search in it", get("/api/v1/search?q=zebra&channel="+p.pid))
		hasNot("the task list", get("/api/v1/tasks"))
		hasNot("tracked tasks", get("/api/v1/tasks?tracked=1&status=in_review"))
		is404("the task", get("/api/v1/tasks/"+p.tid))
		is404("the task by thread", resp{status: map[bool]int{true: 404, false: 200}[len(get("/api/v1/tasks?thread=" + p.mid).body["tasks"].([]any)) == 0]})
		hasNot("the inbox", get("/api/v1/inbox"))
		for _, act := range []string{"confirm", "decline", "cancel", "accept", "reopen", "track", "takeover", "decide", "handoff"} {
			is404("the task's "+act, e.do("POST", "/api/v1/tasks/"+p.tid+"/"+act, o.session, map[string]any{"choice": "x", "id": "x"}))
		}
		is404("changing the task", e.do("PATCH", "/api/v1/tasks/"+p.tid, o.session, map[string]any{"title": "x"}))
		is404("its triggers", get("/api/v1/triggers?channel="+p.pid))
		is404("a trigger of it", e.do("PATCH", "/api/v1/triggers/"+p.trg, o.session, map[string]any{"enabled": false}))
		is404("deleting a trigger", e.do("DELETE", "/api/v1/triggers/"+p.trg, o.session, nil))
		is404("setting a trigger in it", e.do("POST", "/api/v1/triggers", o.session, map[string]any{"channel_id": p.pid, "agent": "acha", "kind": "schedule", "when": "9:00", "repeat": "daily", "text": "x"}))
		is404("an output link", get("/api/v1/outputs/"+p.fid+"/link"))
		check(t, o.name+": reminders on it", e.do("POST", "/api/v1/reminders", o.session, map[string]any{"message_id": p.mid, "when": "20m"}).status >= 400)
		hasNot("their reminders", get("/api/v1/reminders"))
		hasNot("catching up", get("/api/v1/updates?after=0"))
		r := get("/api/v1/metrics?days=7")
		for _, a := range r.body["agents"].([]any) {
			check(t, o.name+": the team's numbers leave its task out", a.(map[string]any)["tasks"] == float64(0), r)
		}
	}
	for name, live := range map[string]*frames{"刘丽": llLive, "张伟 (admin)": zwLive} {
		got := live.all()
		check(t, name+"'s live connection got nothing of it", !strings.Contains(got, "zebra") && !strings.Contains(got, p.pid) && !strings.Contains(got, p.tid),
			resp{raw: []byte(got)})
	}
	r := e.do("GET", "/api/v1/channels/"+p.pid+"/messages", e.wl.session, nil)
	check(t, "its member reads it all", r.status == 200 && len(r.body["messages"].([]any)) == 1, r)
}

// Who gets in and out of a private channel, and what they see when they do.
func TestPrivateChannelMembers(t *testing.T) {
	e := newTaskEnv(t, "channel", true)
	p := newPrivEnv(t, e)
	llLive := e.listen(e.ll.id)
	check(t, "no joining by oneself", e.do("POST", "/api/v1/channels/"+p.pid+"/members", e.ll.session, map[string]any{}).status == 404)
	r := e.do("POST", "/api/v1/channels/"+p.pid+"/members", e.wl.session, map[string]any{"kind": "user", "id": e.ll.id})
	check(t, "a member brings someone in", r.status == 200, r)
	check(t, "who hears of it at once", strings.Contains(llLive.all(), p.pid))
	r = e.do("GET", "/api/v1/channels/"+p.pid+"/messages", e.ll.session, nil)
	check(t, "and reads the whole history", r.status == 200 && strings.Contains(string(r.raw), "zebra 菜谱"), r)
	check(t, "the task too", e.do("GET", "/api/v1/tasks/"+p.tid, e.ll.session, nil).status == 200)
	check(t, "and finds it", strings.Contains(string(e.do("GET", "/api/v1/search?q=zebra", e.ll.session, nil).raw), p.mid))
	r = e.do("DELETE", "/api/v1/channels/"+p.pid+"/members/user/"+e.ll.id, e.zw.session, nil)
	check(t, "an admin not in it cannot take people out", r.status == 404, r)
	r = e.do("DELETE", "/api/v1/channels/"+p.pid+"/members/user/"+e.ll.id, e.ll.session, nil)
	check(t, "leaving", r.status == 200, r)
	check(t, "the one who left is told it is gone", strings.Contains(llLive.all(), `{"id":"`+p.pid+`","type":"channel_removed"}`))
	check(t, "and it is gone from their list", !strings.Contains(string(e.do("GET", "/api/v1/channels", e.ll.session, nil).raw), p.pid))

	// agents: one's own, or one that takes work from the whole team
	r = e.do("POST", "/api/v1/machines", e.ll.session, map[string]any{"name": "刘丽的 Mac"})
	llMachine := r.body["machine"].(map[string]any)["id"].(string)
	mine := e.do("POST", "/api/v1/agents", e.ll.session, map[string]any{"handle": "lili", "name": "丽丽", "machine_id": llMachine, "dispatch": "channel"}).body["id"].(string)
	team := e.do("POST", "/api/v1/agents", e.ll.session, map[string]any{"handle": "helper", "name": "帮手", "machine_id": llMachine, "dispatch": "team", "confirm": true}).body["id"].(string)
	r = e.do("POST", "/api/v1/channels/"+p.pid+"/members", e.wl.session, map[string]any{"kind": "agent", "id": mine})
	check(t, "not someone else's agent that only takes its channels' work", r.status == 403, r)
	r = e.do("POST", "/api/v1/channels", e.wl.session, map[string]any{"name": "x", "private": true, "members": []any{map[string]any{"kind": "agent", "id": mine}}})
	check(t, "not when creating it either", r.status == 403, r)
	r = e.do("POST", "/api/v1/channels/"+p.pid+"/members", e.wl.session, map[string]any{"kind": "agent", "id": team})
	check(t, "a team-wide agent comes in", r.status == 200, r)

	// its owner is not in the channel: they confirm its work without seeing what it is
	before := len(llLive.all())
	m := e.do("POST", "/api/v1/channels/"+p.pid+"/messages", e.wl.session, map[string]any{"text": "@helper 帮忙试吃 zebra"}).body
	ts := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.wl.session, nil).body["tasks"].([]any)
	tid := ts[0].(map[string]any)["id"].(string)
	in := e.inbox(e.ll.session)
	check(t, "the owner has one row in their inbox", len(in) == 1)
	row := in[0].(map[string]any)
	check(t, "without what it is about", row["redacted"] == true && row["title"] == "" && row["body"] == "" && row["channel_id"] == "" && row["thread_id"] == "" &&
		row["needs"] == "confirm" && row["created_by"] == e.wl.id && row["agent_id"] == team && !strings.Contains(string(e.do("GET", "/api/v1/inbox", e.ll.session, nil).raw), "zebra"))
	check(t, "they still cannot open it", e.do("GET", "/api/v1/tasks/"+tid, e.ll.session, nil).status == 404)
	live := llLive.all()[before:]
	check(t, "the row reaches them live, as redacted as in the inbox", strings.Contains(live, `"id":"`+tid+`"`) && strings.Contains(live, `"redacted":true`) && !strings.Contains(live, "zebra"))
	r = e.do("POST", "/api/v1/tasks/"+tid+"/confirm", e.ll.session, nil)
	check(t, "but they confirm it, and the answer says no more", r.status == 200 && r.body["state"] == "queued" && r.body["redacted"] == true && !strings.Contains(string(r.raw), "zebra"), r)

	// a trigger whose agent's owner would have to confirm it from outside: refused
	r = e.do("POST", "/api/v1/triggers", e.wl.session, map[string]any{"channel_id": p.pid, "agent": "helper", "kind": "schedule", "when": "9:00", "repeat": "daily", "text": "x"})
	check(t, "no trigger its owner could not confirm", r.status == 403, r)

	// the last person leaving archives it
	e.do("DELETE", "/api/v1/channels/"+p.pid+"/members/user/"+e.wl.id, e.wl.session, nil)
	_ = e.h.db.QueryRow("SELECT archived FROM channels WHERE id = ?", p.pid).Scan(&r.status)
	check(t, "nobody left: archived", r.status == 1)
}

// Making it public: its creator only, once, and everyone sees it and its history at once. Never the other way.
func TestPrivateChannelGoesPublic(t *testing.T) {
	e := newTaskEnv(t, "channel", true)
	p := newPrivEnv(t, e)
	check(t, "a public channel cannot go private", e.do("PATCH", "/api/v1/channels/"+e.cid, e.zw.session, map[string]any{"private": true}).status == 400)
	e.do("POST", "/api/v1/channels/"+p.pid+"/members", e.wl.session, map[string]any{"kind": "user", "id": e.zw.id})
	r := e.do("PATCH", "/api/v1/channels/"+p.pid, e.zw.session, map[string]any{"private": false})
	check(t, "another member (an admin) cannot make it public", r.status == 403, r)
	llLive := e.listen(e.ll.id)
	r = e.do("PATCH", "/api/v1/channels/"+p.pid, e.wl.session, map[string]any{"private": false})
	check(t, "its creator can", r.status == 200 && r.body["private"] == false, r)
	check(t, "everyone hears of it", strings.Contains(llLive.all(), p.pid))
	check(t, "and reads its history", strings.Contains(string(e.do("GET", "/api/v1/channels/"+p.pid+"/messages", e.ll.session, nil).raw), "zebra"))
	check(t, "and may join", e.do("POST", "/api/v1/channels/"+p.pid+"/members", e.ll.session, map[string]any{}).status == 200)
}

// An agent in someone's private channel, asked by someone else elsewhere, sees only what that person may see.
func TestPrivateChannelAgentReads(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	p := newPrivEnv(t, e)
	readOf := func(tid string) string {
		r := e.do("POST", "/api/v1/tasks/"+tid+"/claim", e.token, nil)
		if r.status != 200 {
			t.Fatalf("claim %s: %d %s", tid, r.status, r.raw)
		}
		return r.body["read_token"].(string)
	}
	// 王磊's own task in the private channel: it sees it all
	e.do("POST", "/api/v1/channels/"+p.pid+"/messages", e.wl.session, map[string]any{"text": "再看看", "thread_id": p.mid}) // its next turn
	own := readOf(p.tid)
	check(t, "on its owner's task it finds the private words", strings.Contains(string(e.do("GET", "/api/v1/agent/search?q=zebra", own, nil).raw), "zebra 要少放盐"))
	e.do("POST", "/api/v1/tasks/"+p.tid+"/report", e.token, map[string]any{"state": "review", "summary": "ok", "run": 2})

	// 刘丽 asks it in the public channel
	m := e.post(e.ll.session, "@acha 找一下资料", "")
	tid := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.ll.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	tok := readOf(tid)
	r := e.do("GET", "/api/v1/agent/search?q="+url.QueryEscape("菜谱"), tok, nil)
	check(t, "asked by someone outside, its search finds nothing there", !strings.Contains(string(r.raw), "菜谱"), r)
	check(t, "nor by naming the channel", e.do("GET", "/api/v1/agent/read?channel="+p.pid, tok, nil).status == 404)
	check(t, "nor by its name", e.do("GET", "/api/v1/agent/read?channel="+url.QueryEscape("私房菜 zebra"), tok, nil).status == 404)
	check(t, "nor a thread there", e.do("GET", "/api/v1/agent/read?thread="+p.mid, tok, nil).status == 404)
	check(t, "nor its tasks", !strings.Contains(string(e.do("GET", "/api/v1/agent/tasks", tok, nil).raw), p.tid))
	check(t, "nor that task", e.do("GET", "/api/v1/agent/tasks/"+p.tid, tok, nil).status == 404)
	check(t, "nor the channel", e.do("GET", "/api/v1/agent/channel?channel="+p.pid, tok, nil).status == 404)
	var att string
	_ = e.h.db.QueryRow("SELECT json_extract(attachments, '$[0]') FROM messages WHERE id = ?", p.mid).Scan(&att)
	check(t, "nor a file attached there", e.do("GET", "/api/v1/agent/file?path="+url.QueryEscape(att), tok, nil).status == 404)
	r = e.do("GET", "/api/v1/agent/who?handle=acha", tok, nil)
	check(t, "nor, asking who it is, what it does there", r.status == 200 && !strings.Contains(string(r.raw), p.tid) && !strings.Contains(string(r.raw), "zebra"), r)
}
