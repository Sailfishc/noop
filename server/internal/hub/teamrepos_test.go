package hub

import "testing"

func TestNormRemote(t *testing.T) {
	for in, want := range map[string]string{
		"https://github.com/Acme/pay.git":                  "github.com/Acme/pay",
		"git@github.com:Acme/pay.git":                      "github.com/Acme/pay",
		"ssh://git@code.corp.com:2222/fin/core/pay.git":    "code.corp.com/fin/core/pay",
		"https://GitHub.com/acme/pay/pull/12":              "github.com/acme/pay",
		"https://code.corp.com/fin/pay/-/merge_requests/3": "code.corp.com/fin/pay",
		"github.com/acme/pay":                              "github.com/acme/pay",
		"acme/pay":                                         "",
		"~/work/pay":                                       "",
		"https://github.com/acme":                          "",
		"":                                                 "",
		"https://user:secret@github.com/acme/pay.git":      "github.com/acme/pay",
		"https://github.com/acme/pay/tree/main/src/x.go":   "github.com/acme/pay",
		"http://localhost/acme/pay":                        "",
		"https://code.corp.com/fin/pay/tree/x":             "code.corp.com/fin/pay/tree/x",
	} {
		if got := normRemote(in); got != want {
			t.Errorf("normRemote(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestTaskRepoFollowsTheTask(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	// 王磊's Mac has two checkouts; it reports their remotes only
	r := e.do("PUT", "/api/v1/machine", e.token, map[string]any{"os": "darwin", "runtimes": []string{"codex"},
		"repos": []any{map[string]any{"remote": "git@github.com:acme/pay.git"}, map[string]any{"remote": "https://code.corp.com/fin/ledger"},
			map[string]any{"remote": "/Users/wl/secret"}, map[string]any{"remote": "github.com/acme/pay"}}})
	repos := r.body["machine"].(map[string]any)["repos"].([]any)
	check(t, "remotes normalized, paths and repeats dropped", len(repos) == 2 && repos[0].(map[string]any)["remote"] == "github.com/acme/pay" &&
		repos[0].(map[string]any)["name"] == "pay", r)
	r = e.do("GET", "/api/v1/repos", e.zw.session, nil)
	check(t, "the team sees which machines have which repo", len(r.body["repos"].([]any)) == 2 &&
		r.body["repos"].([]any)[0].(map[string]any)["machines"].([]any)[0] == e.mid, r)

	// no repository anywhere: a general task
	m := e.post(e.wl.session, "@acha 整理一下上周的事故复盘", "")
	tk := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)
	check(t, "general task", tk["repo"] == "")

	// the channel's default
	r = e.do("PATCH", "/api/v1/channels/"+e.cid, e.wl.session, map[string]any{"repo": "https://github.com/acme/pay"})
	check(t, "channel default repo", r.status == 200 && r.body["repo"] == "github.com/acme/pay", r)
	check(t, "a bad address is refused", e.do("PATCH", "/api/v1/channels/"+e.cid, e.wl.session, map[string]any{"repo": "pay"}).status == 400)
	m = e.post(e.wl.session, "@acha 修一下退款按钮", "")
	tk = e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)
	check(t, "the channel's default is a hint, not the task's repo: the agent declares one (remi repo)", tk["repo"] == "")
	e.do("POST", "/api/v1/tasks/"+tk["id"].(string)+"/cancel", e.wl.session, nil)

	// named in the message: owner/name of a repo a machine has, or an address
	m = e.post(e.wl.session, "@acha 在 fin/ledger 里加个对账脚本", "")
	tk = e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)
	check(t, "owner/name of a known repo", tk["repo"] == "code.corp.com/fin/ledger")
	m = e.post(e.wl.session, "@acha 看看 https://github.com/acme/web/pull/7 为什么挂了", "")
	tk = e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)
	check(t, "an address", tk["repo"] == "github.com/acme/web")
	id := tk["id"].(string)

	// later in the same thread, the thread's repo
	r = e.do("POST", "/api/v1/agents", e.wl.session, map[string]any{"handle": "bobo", "machine_id": e.mid})
	e.do("POST", "/api/v1/channels/"+e.cid+"/members", e.wl.session, map[string]any{"kind": "agent", "id": r.body["id"]})
	e.post(e.wl.session, "@bobo 你也看一下", m["id"].(string))
	ts := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)
	check(t, "the thread's repo", len(ts) == 2 && ts[0].(map[string]any)["repo"] == "github.com/acme/web")

	// people may change it until it has run
	r = e.do("PATCH", "/api/v1/tasks/"+id, e.wl.session, map[string]any{"repo": "github.com/acme/pay"})
	check(t, "changed before it ran", r.status == 200 && r.body["repo"] == "github.com/acme/pay", r)
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	r = e.do("PATCH", "/api/v1/tasks/"+id, e.wl.session, map[string]any{"repo": "github.com/acme/web"})
	check(t, "not after", r.status == 409, r)
}

func TestAgentMemory(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	r := e.do("PATCH", "/api/v1/agents/"+e.aid, e.wl.session, map[string]any{"memory": "- 支付服务用 Go 1.24\n"})
	check(t, "the owner writes it", r.status == 200 && r.body["memory"] == "- 支付服务用 Go 1.24", r)
	check(t, "others can't", e.do("PATCH", "/api/v1/agents/"+e.aid, e.zw.session, map[string]any{"memory": "x"}).status == 403)
	m := e.post(e.wl.session, "@acha 看下慢查询", "")
	id := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	r = e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	check(t, "the run gets it", r.body["agent"].(map[string]any)["memory"] == "- 支付服务用 Go 1.24", r)
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "ok", "memory": "- 支付服务用 Go 1.24\n- orders 表很大，加索引要在夜里"})
	a := e.do("GET", "/api/v1/agents", e.wl.session, nil).body["agents"].([]any)[0].(map[string]any)
	check(t, "the agent rewrote it", a["memory"] == "- 支付服务用 Go 1.24\n- orders 表很大，加索引要在夜里")
}
