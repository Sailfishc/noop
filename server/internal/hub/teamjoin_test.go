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

func TestMachineEnroll(t *testing.T) {
	e := newEnv(t)
	zw := e.join("zhang@corp.com", "zhangwei", "admin", "")
	wl := e.join("wang@corp.com", "wanglei", "member", zw.session)

	r := e.do("POST", "/api/v1/machines/enroll", wl.session, nil)
	code, _ := r.body["join"].(string)
	check(t, "a command for my computers, nothing named yet", r.status == 200 && strings.HasPrefix(code, "te_"), r)
	check(t, "machines can't ask for one", e.do("POST", "/api/v1/machines/enroll", "", nil).status == 401)

	join := func(key, host string) resp {
		return e.do("POST", "/api/v1/machines/join", "", map[string]any{"code": code, "host": host, "os": "macOS", "arch": "arm64", "key": key})
	}
	r = join("k-macbook-0123456789", "wanglei-mbp")
	tok1, _ := r.body["token"].(string)
	mid := r.body["machine"].(map[string]any)["id"].(string)
	check(t, "the computer reports in under its own name", r.status == 200 && strings.HasPrefix(tok1, "tam_") && r.body["machine"].(map[string]any)["name"] == "wanglei-mbp", r)
	ms := e.do("GET", "/api/v1/machines", wl.session, nil).body["machines"].([]any)
	m := ms[0].(map[string]any)
	check(t, "it's mine, with its OS", len(ms) == 1 && m["owner_id"] == wl.id && m["os"] == "macOS" && m["arch"] == "arm64")

	check(t, "the same code adds a second computer", join("k-studio-0123456789", "mac-studio").status == 200)
	r = join("k-macbook-0123456789", "wanglei-mbp")
	check(t, "the first one again: same machine, new token", r.status == 200 && r.body["machine"].(map[string]any)["id"] == mid && r.body["token"] != tok1, r)
	check(t, "two machines, not three", len(e.do("GET", "/api/v1/machines", wl.session, nil).body["machines"].([]any)) == 2)
	check(t, "the old token is gone", e.do("PUT", "/api/v1/machine", tok1, map[string]any{"os": "macOS"}).status == 401)

	r = e.do("PATCH", "/api/v1/machines/"+mid, wl.session, map[string]any{"name": "王磊的 MacBook"})
	check(t, "its owner renames it", r.status == 200 && r.body["machine"].(map[string]any)["name"] == "王磊的 MacBook", r)
	zw2 := e.join("li@corp.com", "lina", "member", zw.session)
	check(t, "others can't", e.do("PATCH", "/api/v1/machines/"+mid, zw2.session, map[string]any{"name": "x"}).status == 403)

	e.advance(61 * time.Minute)
	check(t, "an hour later the code has expired", join("k-other-0123456789", "other").status == 410)
}
