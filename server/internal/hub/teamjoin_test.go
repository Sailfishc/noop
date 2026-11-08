package hub

import (
	"strings"
	"testing"
	"time"
)

func TestMachineJoin(t *testing.T) {
	e := newEnv(t)
	zw := e.join("zhang@corp.com", "zhangwei", "admin", "")
	wl := e.join("wang@corp.com", "wanglei", "member", zw.session)

	r := e.do("POST", "/api/v1/machines", wl.session, map[string]any{"name": "王磊的 Mac"})
	code, _ := r.body["join"].(string)
	mid := r.body["machine"].(map[string]any)["id"].(string)
	check(t, "adding a machine gives a join code", r.status == 200 && strings.HasPrefix(code, "tj_"), r)

	r = e.do("GET", "/api/v1/install.sh", "", nil)
	check(t, "the install script, no session needed", r.status == 200 && strings.Contains(string(r.raw), "bun src/cli.ts join"), r)

	r = e.do("POST", "/api/v1/machines/join", "", map[string]any{"code": code})
	token, _ := r.body["token"].(string)
	check(t, "the code is traded for a token", r.status == 200 && strings.HasPrefix(token, "tam_") && r.body["machine"].(map[string]any)["name"] == "王磊的 Mac", r)
	check(t, "the token works", e.do("PUT", "/api/v1/machine", token, map[string]any{"os": "macOS"}).status == 200)
	check(t, "a code works once", e.do("POST", "/api/v1/machines/join", "", map[string]any{"code": code}).status == 404)

	check(t, "others can't make a new code", e.do("POST", "/api/v1/machines/"+mid+"/join", "", nil).status == 401)
	r = e.do("POST", "/api/v1/machines/"+mid+"/join", wl.session, nil)
	code2, _ := r.body["join"].(string)
	check(t, "its owner makes a new one", r.status == 200 && code2 != code, r)
	e.advance(61 * time.Minute)
	check(t, "an hour later it has expired", e.do("POST", "/api/v1/machines/join", "", map[string]any{"code": code2}).status == 410)
	check(t, "and the old token still works", e.do("PUT", "/api/v1/machine", token, map[string]any{"os": "macOS"}).status == 200)

	code3 := e.do("POST", "/api/v1/machines/"+mid+"/join", zw.session, nil).body["join"].(string)
	check(t, "an admin may too, and joining again replaces the token", e.do("POST", "/api/v1/machines/join", "", map[string]any{"code": code3}).status == 200)
	check(t, "the old token is gone", e.do("PUT", "/api/v1/machine", token, map[string]any{"os": "macOS"}).status == 401)
	check(t, "a bad code", e.do("POST", "/api/v1/machines/join", "", map[string]any{"code": "tam_x"}).status == 404)
}
