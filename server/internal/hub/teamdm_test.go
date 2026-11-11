package hub

import (
	"strings"
	"testing"
)

func TestPrivateChat(t *testing.T) {
	e := newTaskEnv(t, "team", false)
	r := e.do("POST", "/api/v1/channels", e.wl.session, map[string]any{"dm_agent": e.aid})
	check(t, "王磊 opens a private chat with his @acha", r.status == 200 && r.body["private"] == true && r.body["dm_agent"] == e.aid && r.body["name"] == "acha" &&
		len(r.body["members"].([]any)) == 2, r)
	dm := r.body["id"].(string)
	r = e.do("POST", "/api/v1/channels", e.wl.session, map[string]any{"dm_agent": e.aid})
	check(t, "opening it again gives the same one", r.status == 200 && r.body["id"] == dm, r)

	r = e.do("POST", "/api/v1/channels/"+dm+"/messages", e.wl.session, map[string]any{"text": "看下 zebra 慢查询"})
	check(t, "a message without an @ names the agent", r.status == 200 && strings.Contains(string(r.raw), `"handle":"acha"`), r)
	root := r.body["id"].(string)
	ts := e.do("GET", "/api/v1/tasks?thread="+root, e.wl.session, nil).body["tasks"].([]any)
	check(t, "and hands it the work", len(ts) == 1 && ts[0].(map[string]any)["agent_id"] == e.aid)
	r = e.do("POST", "/api/v1/channels/"+dm+"/messages", e.wl.session, map[string]any{"text": "补充一句", "thread_id": root})
	check(t, "a reply in its thread names nobody new (the thread's agent hears it anyway)", r.status == 200 && !strings.Contains(string(r.raw), `"handle":"acha"`), r)
	r = e.do("POST", "/api/v1/channels/"+dm+"/messages", e.wl.session, map[string]any{"text": "当任务做", "as_task": true})
	check(t, "\"as task\" needs no @ here", r.status == 200, r)

	check(t, "nobody can be added", e.do("POST", "/api/v1/channels/"+dm+"/members", e.wl.session, map[string]any{"kind": "user", "id": e.ll.id}).status == 403)
	check(t, "nor removed", e.do("DELETE", "/api/v1/channels/"+dm+"/members/agent/"+e.aid, e.wl.session, nil).status == 403)
	check(t, "it can't be renamed", e.do("PATCH", "/api/v1/channels/"+dm, e.wl.session, map[string]any{"name": "x"}).status == 400)
	check(t, "or made public", e.do("PATCH", "/api/v1/channels/"+dm, e.wl.session, map[string]any{"private": false}).status == 400)
	for _, s := range []string{e.zw.session, e.ll.session} {
		check(t, "others don't see it", !strings.Contains(string(e.do("GET", "/api/v1/channels", s, nil).raw), dm) &&
			e.do("GET", "/api/v1/channels/"+dm+"/messages", s, nil).status == 404)
	}

	// someone else's agent that takes the whole team's work: a chat of one's own with it
	r = e.do("POST", "/api/v1/channels", e.ll.session, map[string]any{"dm_agent": e.aid})
	check(t, "刘丽 opens her own chat with 王磊's team-wide @acha", r.status == 200 && r.body["id"] != dm, r)
	llDM := r.body["id"].(string)
	check(t, "王磊 doesn't see it", !strings.Contains(string(e.do("GET", "/api/v1/channels", e.wl.session, nil).raw), llDM))
	e.do("PATCH", "/api/v1/agents/"+e.aid, e.wl.session, map[string]any{"dispatch": "owner"})
	r = e.do("POST", "/api/v1/channels/"+llDM+"/messages", e.ll.session, map[string]any{"text": "还在吗"})
	check(t, "once it takes only its owner's work, her chat takes no more messages", r.status == 403, r)
	check(t, "but keeps its history", e.do("GET", "/api/v1/channels/"+llDM+"/messages", e.ll.session, nil).status == 200)
	check(t, "and no new chat with it can be made", e.do("POST", "/api/v1/channels", e.zw.session, map[string]any{"dm_agent": e.aid}).status == 403)

	e.do("DELETE", "/api/v1/agents/"+e.aid, e.wl.session, nil)
	check(t, "its agent deleted, his chat takes no more messages", e.do("POST", "/api/v1/channels/"+dm+"/messages", e.wl.session, map[string]any{"text": "hi"}).status == 403)
	r = e.do("GET", "/api/v1/channels/"+dm+"/messages", e.wl.session, nil)
	check(t, "and keeps its history", r.status == 200 && strings.Contains(string(r.raw), "zebra"), r)
}
