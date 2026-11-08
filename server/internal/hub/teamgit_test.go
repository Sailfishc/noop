package hub

import (
	"strings"
	"testing"
)

func TestMachineInfoGitAndSessions(t *testing.T) {
	e := newTaskEnv(t, "channel", true)
	// the daemon reports its runtimes and Git credentials; tokens never travel, only who they are
	r := e.do("PUT", "/api/v1/machine", e.token, map[string]any{"os": "darwin", "arch": "arm64", "runtimes": []string{"codex", "claude"},
		"runtime_info": []any{
			map[string]any{"name": "codex", "version": "0.46.0", "installed": true, "logged_in": true},
			map[string]any{"name": "claude", "version": "2.1.0", "installed": true, "logged_in": false, "models": []any{"opus", "claude-sonnet-5-5", "bad model;"}},
			map[string]any{"name": "evil", "installed": true},
		},
		"git": []any{map[string]any{"provider": "gitlab", "host": "Code.Corp.com", "configured": true, "user": "wanglei", "via": "token"}, map[string]any{"provider": "svn", "host": "x"}}})
	check(t, "report", r.status == 200, r)
	m := r.body["machine"].(map[string]any)
	ri := m["runtime_info"].([]any)
	check(t, "known runtimes only", len(ri) == 2 && ri[1].(map[string]any)["logged_in"] == false, r)
	check(t, "with their models, odd names dropped", len(ri[1].(map[string]any)["models"].([]any)) == 2, r)
	g := m["git"].([]any)
	check(t, "git credential status", len(g) == 1 && g[0].(map[string]any)["host"] == "code.corp.com" && g[0].(map[string]any)["user"] == "wanglei", r)
	r = e.do("GET", "/api/v1/machines", e.zw.session, nil)
	check(t, "people see it", strings.Contains(string(r.raw), `"logged_in":true`), r)

	// Git platforms: anyone reads, an admin sets
	r = e.do("PUT", "/api/v1/git/platforms", e.wl.session, map[string]any{"platforms": []any{}})
	check(t, "members can't set platforms", r.status == 403, r)
	r = e.do("PUT", "/api/v1/git/platforms", e.zw.session, map[string]any{"platforms": []any{map[string]any{"kind": "gitlab", "name": "Ant Code", "host": "https://code.corp.com/"}, map[string]any{"kind": "github", "host": "github.com"}}})
	ps, _ := r.body["platforms"].([]any)
	check(t, "platforms saved with default APIs", r.status == 200 && len(ps) == 2 && ps[0].(map[string]any)["api"] == "https://code.corp.com/api/v4" && ps[1].(map[string]any)["api"] == "https://api.github.com", r)
	r = e.do("PUT", "/api/v1/git/platforms", e.zw.session, map[string]any{"platforms": []any{map[string]any{"kind": "svn", "host": "x"}}})
	check(t, "bad platform", r.status == 400, r)
	r = e.do("GET", "/api/v1/git", e.wl.session, nil)
	check(t, "git settings", r.status == 200 && len(r.body["platforms"].([]any)) == 2 && r.body["webhook"].(map[string]any)["secret_set"] == false, r)

	// signed-in devices: listed, the current one marked, another removed
	other := e.do("POST", "/api/v1/login", "", map[string]any{"code": e.do("POST", "/api/v1/login-codes", e.wl.session, nil).body["code"]}).body["session"].(string)
	r = e.do("GET", "/api/v1/sessions", e.wl.session, nil)
	ss := r.body["sessions"].([]any)
	check(t, "two devices", len(ss) == 2, r)
	var otherID string
	for _, s := range ss {
		if s.(map[string]any)["current"] == false {
			otherID = s.(map[string]any)["id"].(string)
		}
	}
	check(t, "someone else can't remove it", e.do("DELETE", "/api/v1/sessions/"+otherID, e.zw.session, nil).status == 404)
	check(t, "remove the other device", e.do("DELETE", "/api/v1/sessions/"+otherID, e.wl.session, nil).status == 200)
	check(t, "it is signed out", e.do("GET", "/api/v1/me", other, nil).status == 401)
}
