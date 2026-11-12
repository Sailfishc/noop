package hub

import (
	"strings"
	"testing"
	"time"
)

func TestTriggerEdit(t *testing.T) {
	e := newTaskEnv(t, "channel", true) // @acha asks its owner (王磊) first
	r := e.do("POST", "/api/v1/triggers", e.wl.session, map[string]any{"channel_id": e.cid, "agent": "acha", "kind": "schedule", "when": "9:00", "repeat": "weekdays", "text": "看一下昨晚的告警"})
	check(t, "the owner sets one: confirmed", r.status == 200 && r.body["confirmed_by"] == e.wl.id, r)
	trg := r.body["id"].(string)
	patch := func(s string, b map[string]any) resp { return e.do("PATCH", "/api/v1/triggers/"+trg, s, b) }

	r = patch(e.wl.session, map[string]any{"when": "17:30"})
	due := time.UnixMilli(int64(r.body["due"].(float64))).In(e.now().Location())
	check(t, "a new time", r.status == 200 && due.Format("15:04") == "17:30" && r.body["repeat"] == "weekdays", r)
	r = patch(e.wl.session, map[string]any{"repeat": "daily"})
	due = time.UnixMilli(int64(r.body["due"].(float64))).In(e.now().Location())
	check(t, "a new repeat keeps the time of day", r.status == 200 && r.body["repeat"] == "daily" && due.Format("15:04") == "17:30", r)
	r = patch(e.wl.session, map[string]any{"repeat": "every 30m"})
	check(t, "an interval: from now, as often as it allows", r.status == 200 && r.body["repeat"] == "30m" && r.body["max_per_day"] == float64(48) &&
		int64(r.body["due"].(float64)) == e.now().Add(30*time.Minute).UnixMilli(), r)
	check(t, "a time that can't be read", patch(e.wl.session, map[string]any{"when": "等会儿"}).status == 400)
	check(t, "every 5m is still refused", patch(e.wl.session, map[string]any{"repeat": "5m"}).status == 400)

	r = patch(e.wl.session, map[string]any{"text": "看一下告警和慢查询"})
	check(t, "the owner changes its words: still confirmed", r.status == 200 && r.body["text"] == "看一下告警和慢查询" && r.body["confirmed_by"] == e.wl.id, r)
	check(t, "a bystander can't", patch(e.ll.session, map[string]any{"text": "删库"}).status == 403)
	r = patch(e.zw.session, map[string]any{"text": "顺便看一下账单"})
	check(t, "someone else changes them: it waits for the owner again", r.status == 200 && r.body["confirmed_by"] == nil, r)
	msgs := e.do("GET", "/api/v1/channels/"+e.cid+"/messages", e.zw.session, nil).body["messages"].([]any)
	check(t, "who is asked in the channel", strings.Contains(msgs[len(msgs)-1].(map[string]any)["text"].(string), "@wanglei"))
	e.advance(31 * time.Minute)
	e.h.Tick()
	check(t, "unconfirmed: nothing runs", len(e.do("GET", "/api/v1/tasks", e.zw.session, nil).body["tasks"].([]any)) == 0)

	pr := e.do("POST", "/api/v1/triggers", e.wl.session, map[string]any{"channel_id": e.cid, "agent": "acha", "kind": "pr", "repo": "https://github.com/acme/pay", "text": "review"})
	check(t, "a PR trigger has no time", e.do("PATCH", "/api/v1/triggers/"+pr.body["id"].(string), e.wl.session, map[string]any{"when": "9:00"}).status == 400)
}
