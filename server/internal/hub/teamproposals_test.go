package hub

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// propose: the running task (its read token) proposes.
func (e *taskEnv) propose(tok, title, key string, urgent bool) resp {
	return e.do("POST", "/api/v1/agent/propose", tok, map[string]any{"title": title, "why": "看到 " + title, "plan": "做到：" + title, "key": key, "urgent": urgent})
}

// cards: the proposal cards in this person's inbox.
func (e *taskEnv) cards(session string) []map[string]any {
	out := []map[string]any{}
	for _, b := range e.do("GET", "/api/v1/inbox", session, nil).body["proposals"].([]any) {
		out = append(out, b.(map[string]any))
	}
	return out
}

func cardTitles(b map[string]any) []string {
	out := []string{}
	for _, p := range b["proposals"].([]any) {
		x := p.(map[string]any)
		out = append(out, fmt.Sprintf("%v %v", x["num"], x["title"]))
	}
	return out
}

func TestProposalsBatchAndAnswer(t *testing.T) {
	e := newTaskEnv(t, "channel", false) // Sunday 2026-11-08 04:00 UTC; @acha needs no yes
	id, tok, _ := e.claimed("@acha 看看依赖")
	check(t, "a proposal needs a plan", e.do("POST", "/api/v1/agent/propose", tok, map[string]any{"title": "升级"}).status == 400)
	check(t, "a key is one short word", e.propose(tok, "升级", "Bad Key!", false).status == 400)
	r := e.propose(tok, "升级 lodash", "dep-lodash", false)
	check(t, "proposed: it says when it reaches whom", r.status == 200 && strings.Contains(string(r.raw), "@zhangwei with their next batch, Mon 09:30"), r)
	e.propose(tok, "删掉没人管的分支", "stale-branches", false)
	e.propose(tok, "补上 /orders 的测试", "orders-tests", false)
	th := e.do("GET", "/api/v1/messages/"+e.task(id)["thread_id"].(string)+"/thread", e.zw.session, nil)
	check(t, "the thread says it proposed, for whom", strings.Contains(string(th.raw), "提了一个案：升级 lodash（等 @zhangwei"), th)
	check(t, "before 张伟's time: no card", len(e.cards(e.zw.session)) == 0)
	e.h.Tick()
	check(t, "Sunday: still none", len(e.cards(e.zw.session)) == 0)

	e.advance(29*time.Hour + 31*time.Minute) // Monday 09:31
	e.h.Tick()
	cs := e.cards(e.zw.session)
	check(t, "Monday 09:30: one card, three numbered proposals", len(cs) == 1 && fmt.Sprint(cardTitles(cs[0])) == "[1 升级 lodash 2 删掉没人管的分支 3 补上 /orders 的测试]", resp{raw: []byte(fmt.Sprint(cs))})
	check(t, "only his", len(e.cards(e.wl.session)) == 0)
	e.h.Tick()
	check(t, "delivered once", len(e.cards(e.zw.session)) == 1)
	batch := cs[0]["id"].(string)
	check(t, "someone else's card is not there for them", e.do("POST", "/api/v1/proposal-batches/"+batch+"/answer", e.wl.session, map[string]any{"text": "1"}).status == 404)
	check(t, "a number not on the card", e.do("POST", "/api/v1/proposal-batches/"+batch+"/answer", e.zw.session, map[string]any{"text": "4"}).status == 400)

	r = e.do("POST", "/api/v1/proposal-batches/"+batch+"/answer", e.zw.session, map[string]any{"text": "1 3"})
	done := r.body["done"].([]any)
	check(t, "1 3: two tasks", r.status == 200 && len(done) == 2, r)
	t1 := done[0].(map[string]any)["task"].(string)
	tk := e.task(t1)
	check(t, "in 张伟's name, queued (he may ask @acha), the plan its acceptance, aligned already", tk["created_by"] == e.zw.id && tk["state"] == "queued" &&
		tk["acceptance"] == "做到：升级 lodash" && tk["aligned"] == true && tk["readonly"] != true && tk["tracked"] == true, resp{raw: []byte(fmt.Sprint(tk))})
	cs = e.cards(e.zw.session)
	check(t, "2 stays on the card", len(cs) == 1 && fmt.Sprint(cardTitles(cs[0])) == "[2 删掉没人管的分支]", resp{raw: []byte(fmt.Sprint(cs))})

	// the same thing again: a key whose task is open is refused; a newer one with a waiting key replaces it
	_, tok2, _ := e.claimed("@acha 再看看依赖")
	r = e.propose(tok2, "升级 lodash 到 5", "dep-lodash", false)
	check(t, "its task is still open: refused", r.status == 409 && strings.Contains(string(r.raw), "已经在做："+t1), r)
	r = e.propose(tok2, "删掉 3 个没人管的分支", "stale-branches", false)
	check(t, "a newer one replaces the unanswered one", r.status == 200 && strings.Contains(string(r.raw), "replaces"), r)
	check(t, "the old one left the card", len(e.cards(e.zw.session)) == 0)

	// 不做: the key is refused for 30 days
	e.advance(24 * time.Hour) // Tuesday 09:31: the replacement comes
	e.h.Tick()
	cs = e.cards(e.zw.session)
	check(t, "the replacement on Tuesday's card", len(cs) == 1 && fmt.Sprint(cardTitles(cs[0])) == "[1 删掉 3 个没人管的分支]", resp{raw: []byte(fmt.Sprint(cs))})
	pid := cs[0]["proposals"].([]any)[0].(map[string]any)["id"].(string)
	check(t, "不做", e.do("POST", "/api/v1/proposals/"+pid+"/answer", e.zw.session, map[string]any{"do": false}).status == 200 && len(e.cards(e.zw.session)) == 0)
	check(t, "answered once", e.do("POST", "/api/v1/proposals/"+pid+"/answer", e.zw.session, map[string]any{"do": true}).status == 409)
	_, tok3, _ := e.claimed("@acha 第三次看依赖")
	r = e.propose(tok3, "删分支", "stale-branches", false)
	check(t, "declined: refused, and the agent is told why", r.status == 409 && strings.Contains(string(r.raw), "已经被拒绝过"), r)
	e.h.db.Exec("UPDATE proposals SET answered = answered - ? WHERE state = 'declined'", (31 * 24 * time.Hour).Milliseconds()) // a month ago
	_, tok4, _ := e.claimed("@acha 一个月后看依赖")
	check(t, "30 days later it may come back", e.propose(tok4, "删分支", "stale-branches", false).status == 200)

	// limits: 5 a run
	for i := 0; i < 4; i++ {
		e.propose(tok4, fmt.Sprintf("小事 %d", i), "", false)
	}
	check(t, "the sixth of one run: refused", e.propose(tok4, "第六件", "", false).status == 429)
	// 20 unanswered for one person: no more
	var last resp
	for i := 0; i < 4 && last.status != 429; i++ {
		_, tk, _ := e.claimed(fmt.Sprintf("@acha 第 %d 轮", i))
		for j := 0; j < 5 && last.status != 429; j++ {
			last = e.propose(tk, fmt.Sprintf("又一件 %d-%d", i, j), "", false)
		}
	}
	check(t, "the 21st unanswered: refused", last.status == 429 && strings.Contains(string(last.raw), "20 个没回答") &&
		e.h.count("SELECT COUNT(*) FROM proposals WHERE state IN ('waiting', 'open')") == 20, last)

	// metrics: each card one decision
	m := e.do("GET", "/api/v1/metrics?days=90", e.zw.session, nil).body["mine"].(map[string]any)
	check(t, "two cards reached him: two decisions", fmt.Sprint(m["by_kind"].(map[string]any)["proposals"]) == "2", resp{raw: []byte(fmt.Sprint(m))})
}

func TestProposalsUrgentQuietAndExpiry(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	e.advance(29*time.Hour + 31*time.Minute) // Monday 09:31
	_, tok, _ := e.claimed("@acha 盯一下")
	r := e.propose(tok, "主干红了，今天发不了版", "ci-main-red", true)
	cs := e.cards(e.zw.session)
	check(t, "urgent: at once, a card of its own", r.status == 200 && strings.Contains(string(r.raw), "has it now") && len(cs) == 1 && cs[0]["urgent"] == true, r)
	e.propose(tok, "证书今天过期", "cert", true)
	r = e.propose(tok, "磁盘快满了", "disk", true)
	check(t, "the third urgent of the day goes into the next batch, and the agent is told", r.status == 200 && strings.Contains(string(r.raw), "每天 2 条") &&
		len(e.cards(e.zw.session)) == 2, r)

	// quiet hours (22:00-08:00 by default): held until they end
	e.advance(13*time.Hour + 30*time.Minute) // Monday 23:01; a new day's urgents only Tuesday
	e.advance(24 * time.Hour)                // Tuesday 23:01
	e.h.Tick()                               // Tuesday's batch (the third one) came at 09:30
	_, tok2, _ := e.claimed("@acha 夜里盯一下")
	r = e.propose(tok2, "夜里出事了", "night", true)
	check(t, "in his quiet hours: held", r.status == 200 && strings.Contains(string(r.raw), "quiet hours end"), r)
	before := len(e.cards(e.zw.session))
	e.h.Tick()
	check(t, "still held at night", len(e.cards(e.zw.session)) == before)
	e.advance(9 * time.Hour) // Wednesday 08:01
	e.h.Tick()
	check(t, "delivered when they end", len(e.cards(e.zw.session)) == before+1)

	// a week untouched: gone
	e.advance(8 * 24 * time.Hour)
	e.h.Tick()
	check(t, "a week later the untouched ones are gone", len(e.cards(e.zw.session)) == 0)
}

func TestProposalDigestSettingAndPatrol(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	me := e.do("GET", "/api/v1/me", e.wl.session, nil).body
	check(t, "the default: each workday 09:30, quiet 22:00-08:00", fmt.Sprint(me["digest"]) == "map[at:09:30 at2:14:00 every:daily quiet:22:00-08:00]", resp{raw: []byte(fmt.Sprint(me["digest"]))})
	check(t, "nobody else sets it, admin or not", e.do("PATCH", "/api/v1/users/"+e.wl.id, e.zw.session, map[string]any{"digest": map[string]any{"every": "weekly"}}).status == 403)
	check(t, "a bad time", e.do("PATCH", "/api/v1/users/"+e.wl.id, e.wl.session, map[string]any{"digest": map[string]any{"every": "twice", "at2": "25:00"}}).status == 400)
	check(t, "his own: twice a day, 8:00 and 16:00", e.do("PATCH", "/api/v1/users/"+e.wl.id, e.wl.session, map[string]any{"digest": map[string]any{"every": "twice", "at": "8:00", "at2": "16:00", "quiet": ""}}).status == 200)

	// a patrol proposes: it goes to who set the trigger up; its ⚡ message goes up first; its history says so
	r := e.do("POST", "/api/v1/triggers", e.wl.session, map[string]any{"channel_id": e.cid, "agent": "acha", "kind": "schedule", "when": "9:00", "repeat": "daily",
		"text": "看过期的依赖", "duty": "每周整理"})
	trg := r.body["id"].(string)
	e.advance(29*time.Hour + 1*time.Minute) // Monday 09:01
	e.h.Tick()
	ts := e.do("GET", "/api/v1/tasks", e.wl.session, nil).body["tasks"].([]any)
	id := ts[0].(map[string]any)["id"].(string)
	tok := e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil).body["read_token"].(string)
	before := len(e.channelTexts())
	r = e.propose(tok, "升级 3 个过期依赖", "deps-weekly", false)
	check(t, "to 王磊, at his own next time", r.status == 200 && strings.Contains(string(r.raw), "@wanglei with their next batch, Mon 16:00"), r)
	check(t, "the ⚡ message went up", len(e.channelTexts()) == before+1)
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "nothing", "summary": "提了一个案"})
	runs := e.dutyRuns(e.wl.session, "trigger="+trg)
	check(t, "its history: proposed", len(runs) == 1 && runs[0]["outcome"] == "proposed" && runs[0]["note"] == "升级 3 个过期依赖", resp{raw: []byte(fmt.Sprint(runs))})
	e.advance(7 * time.Hour) // 16:01
	e.h.Tick()
	check(t, "his card at 16:00", len(e.cards(e.wl.session)) == 1 && len(e.cards(e.zw.session)) == 0)

	// nobody else answers his; in a private channel he leaves, its proposals leave his card
	pid := e.cards(e.wl.session)[0]["proposals"].([]any)[0].(map[string]any)["id"].(string)
	check(t, "not even an admin answers someone else's", e.do("POST", "/api/v1/proposals/"+pid+"/answer", e.zw.session, map[string]any{"do": true}).status == 404)
	r = e.do("POST", "/api/v1/channels", e.wl.session, map[string]any{"name": "机密", "private": true, "members": []any{
		map[string]any{"kind": "user", "id": e.zw.id}, map[string]any{"kind": "agent", "id": e.aid}}})
	if r.status != 200 {
		t.Fatalf("private channel: %d %s", r.status, r.raw)
	}
	pc := r.body["id"].(string)
	m := e.do("POST", "/api/v1/channels/"+pc+"/messages", e.wl.session, map[string]any{"text": "@acha 看看机密的依赖"}).body
	pid2 := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.wl.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	tok2 := e.do("POST", "/api/v1/tasks/"+pid2+"/claim", e.token, nil).body["read_token"].(string)
	check(t, "a proposal in the private channel", e.propose(tok2, "机密的事", "secret", false).status == 200)
	e.advance(16 * time.Hour) // Tuesday 08:01
	e.h.Tick()
	check(t, "his cards: Monday's and Tuesday's", len(e.cards(e.wl.session)) == 2)
	check(t, "he leaves it", e.do("DELETE", "/api/v1/channels/"+pc+"/members/user/"+e.wl.id, e.wl.session, nil).status == 200)
	cs := e.cards(e.wl.session)
	check(t, "its proposal left his card", len(cs) == 1 && cs[0]["proposals"].([]any)[0].(map[string]any)["id"] == pid, resp{raw: []byte(fmt.Sprint(cs))})
}
