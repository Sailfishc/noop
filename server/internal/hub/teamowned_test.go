package hub

import (
	"strings"
	"testing"
)

func TestTeamMachineAndTeamAgent(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	r := e.do("POST", "/api/v1/machines", e.wl.session, map[string]any{"name": "团队机器"})
	box := r.body["machine"].(map[string]any)["id"].(string)
	check(t, "a member cannot make it a team machine", e.do("PATCH", "/api/v1/machines/"+box, e.wl.session, map[string]any{"team": true}).status == 403)
	r = e.do("PATCH", "/api/v1/machines/"+box, e.zw.session, map[string]any{"team": true})
	check(t, "an admin can (the name stays)", r.status == 200 && r.body["machine"].(map[string]any)["team"] == true &&
		r.body["machine"].(map[string]any)["name"] == "团队机器", r)

	r = e.do("POST", "/api/v1/agents", e.zw.session, map[string]any{"handle": "ops", "machine_id": box})
	check(t, "an admin puts an agent on the team machine; anyone may ask it, nobody confirms", r.status == 200 &&
		r.body["dispatch"] == "team" && r.body["confirm"] == false, r)
	ops := r.body["id"].(string)
	check(t, "a member cannot put one there", e.do("POST", "/api/v1/agents", e.ll.session, map[string]any{"handle": "ops2", "machine_id": box}).status == 400)
	check(t, "nor on someone else's own machine", e.do("POST", "/api/v1/agents", e.zw.session, map[string]any{"handle": "ops3", "machine_id": e.mid}).status == 400)

	r = e.do("PATCH", "/api/v1/agents/"+ops, e.zw.session, map[string]any{"owner_id": e.wl.id})
	check(t, "an admin hands the team agent to a responsible person", r.status == 200 && r.body["owner_id"] == e.wl.id, r)
	check(t, "who can then change it", e.do("PATCH", "/api/v1/agents/"+ops, e.wl.session, map[string]any{"description": "值班"}).status == 200)
	check(t, "and any admin still can (a team agent)", e.do("PATCH", "/api/v1/agents/"+ops, e.zw.session, map[string]any{"description": "值班机器人"}).status == 200)
	check(t, "but not a member", e.do("PATCH", "/api/v1/agents/"+ops, e.ll.session, map[string]any{"description": "x"}).status == 403)
	check(t, "a personal agent stays its owner's", e.do("PATCH", "/api/v1/agents/"+e.aid, e.zw.session, map[string]any{"description": "x"}).status == 403)
	check(t, "a member cannot hand agents around", e.do("PATCH", "/api/v1/agents/"+ops, e.wl.session, map[string]any{"owner_id": e.ll.id}).status == 403)
}

func TestTeamConfigAndReport(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	check(t, "a member cannot set it", e.do("PUT", "/api/v1/team/config", e.wl.session, map[string]any{"repo": "https://github.com/acme/remi-config"}).status == 403)
	check(t, "nonsense is refused", e.do("PUT", "/api/v1/team/config", e.zw.session, map[string]any{"repo": "config"}).status == 400)
	r := e.do("PUT", "/api/v1/team/config", e.zw.session, map[string]any{"repo": "https://github.com/acme/remi-config"})
	check(t, "an admin sets the team config repository", r.status == 200 && r.body["repo"] == "https://github.com/acme/remi-config", r)
	report := func() resp {
		return e.do("PUT", "/api/v1/machine", e.token, map[string]any{"os": "darwin", "runtimes": []string{"claude"},
			"skills": []string{"release-notes", "release-notes", "sql-review"}, "mcp": []string{"jira"},
			"team_config": map[string]any{"repo": "https://github.com/acme/remi-config", "commit": "abc123", "synced": 5, "instructions": true}})
	}
	r = report()
	check(t, "王磊's own Mac is not told (it would run the repository's MCP commands there)", r.body["team_config"].(map[string]any)["repo"] == "", r)
	check(t, "an admin can't turn it on for him", e.do("PATCH", "/api/v1/machines/"+e.mid, e.zw.session, map[string]any{"sync_team_config": true}).status == 403)
	check(t, "he can", e.do("PATCH", "/api/v1/machines/"+e.mid, e.wl.session, map[string]any{"sync_team_config": true}).body["machine"].(map[string]any)["sync_team_config"] == true)
	r = report()
	check(t, "then it is told where it is", r.body["team_config"].(map[string]any)["repo"] == "https://github.com/acme/remi-config", r)
	e.do("PATCH", "/api/v1/machines/"+e.mid, e.wl.session, map[string]any{"sync_team_config": false})
	e.do("PATCH", "/api/v1/machines/"+e.mid, e.zw.session, map[string]any{"team": true})
	check(t, "a team machine always is", report().body["team_config"].(map[string]any)["repo"] == "https://github.com/acme/remi-config")
	m := r.body["machine"].(map[string]any)
	check(t, "and report what their agents can use and how the sync went", len(m["skills"].([]any)) == 2 && m["mcp"].([]any)[0] == "jira" &&
		m["team_config"].(map[string]any)["commit"] == "abc123", r)
}

func TestChannelConventions(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	r := e.do("PATCH", "/api/v1/channels/"+e.cid, e.wl.session, map[string]any{"conventions": "PR 标题用中文\n发布前在 #ops 说一声"})
	check(t, "a member writes the channel's conventions", r.status == 200, r)
	id, tok, _ := e.claimed("@acha 发一版")
	r = e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	check(t, "the agent gets them with its task", r.body["channel"].(map[string]any)["conventions"] == "PR 标题用中文\n发布前在 #ops 说一声", r)
	r = e.do("GET", "/api/v1/agent/channel", tok, nil)
	check(t, "and from remi channel", r.status == 200 && strings.Contains(string(r.raw), "PR 标题用中文"), r)
	long := make([]rune, maxConventions+1)
	for i := range long {
		long[i] = '字'
	}
	check(t, "not a novel", e.do("PATCH", "/api/v1/channels/"+e.cid, e.wl.session, map[string]any{"conventions": string(long)}).status == 400)
}

func TestTakeover(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	id, _, m := e.claimed("@acha 查下退款")
	r := e.do("POST", "/api/v1/tasks/"+id+"/takeover", e.ll.session, nil)
	check(t, "someone in the channel takes it over", r.status == 200 && r.body["created_by"] == e.ll.id, r)
	md := r.body["mandate"].(map[string]any)
	check(t, "the mandate says from whom", md["by"] == e.ll.id && md["takeovers"].([]any)[0].(map[string]any)["from"] == e.zw.id, r)
	th := e.do("GET", "/api/v1/messages/"+m["id"].(string)+"/thread", e.zw.session, nil).body["replies"].([]any)
	check(t, "said in the thread", strings.Contains(th[len(th)-1].(map[string]any)["text"].(string), "接手了这个任务"))
	e.post(e.ll.session, "先只看 /refunds", m["id"].(string))
	check(t, "their words now reach the agent", e.task(id)["news"] == true)
	out := e.join("out@corp.com", "outsider", "member", e.zw.session)
	check(t, "not someone outside the channel", e.do("POST", "/api/v1/tasks/"+id+"/takeover", out.session, nil).status == 403)
}

func TestTakeoverFollowsTheAgentsRules(t *testing.T) {
	// an agent that needs its owner (王磊) to confirm: someone else taking a task over asks him first
	e := newTaskEnv(t, "channel", true)
	m := e.post(e.wl.session, "@acha 查下退款", "")
	id := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.wl.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	r := e.do("POST", "/api/v1/tasks/"+id+"/takeover", e.ll.session, nil)
	tk := r.body
	check(t, "asked, not taken yet", r.status == 200 && tk["created_by"] == e.wl.id &&
		tk["mandate"].(map[string]any)["takeovers"].([]any)[0].(map[string]any)["pending"] == true, r)
	e.post(e.ll.session, "先只看 /refunds", m["id"].(string))
	check(t, "her words don't steer it meanwhile", e.task(id)["news"] == false)
	check(t, "only the owner says yes", e.do("POST", "/api/v1/tasks/"+id+"/takeover", e.ll.session, map[string]any{"approve": true}).status == 403)
	r = e.do("POST", "/api/v1/tasks/"+id+"/takeover", e.wl.session, map[string]any{"approve": true})
	check(t, "the owner says yes: hers now", r.status == 200 && r.body["created_by"] == e.ll.id &&
		r.body["mandate"].(map[string]any)["takeovers"].([]any)[0].(map[string]any)["pending"] == nil, r)
	check(t, "nothing left to confirm", e.do("POST", "/api/v1/tasks/"+id+"/takeover", e.wl.session, map[string]any{"approve": true}).status == 409)

	// the owner turns one down
	e.do("POST", "/api/v1/tasks/"+id+"/takeover", e.zw.session, nil)
	r = e.do("POST", "/api/v1/tasks/"+id+"/takeover", e.wl.session, map[string]any{"approve": false})
	check(t, "turned down: it stays hers", r.status == 200 && r.body["created_by"] == e.ll.id && len(r.body["mandate"].(map[string]any)["takeovers"].([]any)) == 1, r)

	// an owner-only agent: nobody else can take its work over
	e.do("PATCH", "/api/v1/agents/"+e.aid, e.wl.session, map[string]any{"dispatch": "owner"})
	check(t, "owner-only: refused", e.do("POST", "/api/v1/tasks/"+id+"/takeover", e.zw.session, nil).status == 403)
}
