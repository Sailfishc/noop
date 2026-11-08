package hub

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type joined struct {
	id, session, secret string
}

// join: invite → bind the authenticator → signed in.
func (e *env) join(email, handle, role, inviter string) joined {
	e.t.Helper()
	var code string
	if inviter == "" {
		var err error
		if code, err = e.h.CreateInvite(email, role, ""); err != nil {
			e.t.Fatal(err)
		}
	} else {
		r := e.do("POST", "/api/v1/invites", inviter, map[string]any{"email": email, "role": role})
		if r.status != 200 {
			e.t.Fatalf("invite: %d %s", r.status, r.raw)
		}
		code = r.body["code"].(string)
	}
	r := e.do("POST", "/api/v1/invites/"+code+"/accept", "", map[string]any{"name": handle, "handle": handle})
	secret, _ := r.body["secret"].(string)
	if r.status != 200 || secret == "" {
		e.t.Fatalf("accept: %d %s", r.status, r.raw)
	}
	r = e.do("POST", "/api/v1/invites/"+code+"/accept", "", map[string]any{"name": handle, "handle": handle, "totp": totpNow(secret, e.now())})
	if r.status != 200 {
		e.t.Fatalf("confirm: %d %s", r.status, r.raw)
	}
	return joined{id: r.body["user"].(map[string]any)["id"].(string), session: r.body["session"].(string), secret: secret}
}

func TestV1PeopleAndSignIn(t *testing.T) {
	e := newEnv(t)
	check(t, "v1 needs a person", e.do("GET", "/api/v1/me", "", nil).status == 401)
	check(t, "the legacy shared token is not a person", e.do("GET", "/api/v1/me", machineToken, nil).status == 401)

	admin := e.join("zhang@corp.com", "zhangwei", "admin", "")
	r := e.do("GET", "/api/v1/me", admin.session, nil)
	check(t, "me", r.status == 200 && r.body["user"].(map[string]any)["role"] == "admin", r)

	lei := e.join("wang@corp.com", "wanglei", "member", admin.session)
	check(t, "a member cannot invite", e.do("POST", "/api/v1/invites", lei.session, map[string]any{"email": "x@corp.com"}).status == 403)
	r = e.do("POST", "/api/v1/invites", admin.session, map[string]any{"email": "wang@corp.com"})
	check(t, "no second invite for a member", r.status == 409, r)

	// a used invite is gone; a handle is taken once
	code, _ := e.h.CreateInvite("li@corp.com", "member", "")
	r = e.do("POST", "/api/v1/invites/"+code+"/accept", "", map[string]any{"name": "李", "handle": "wanglei"})
	check(t, "handle taken", r.status == 409, r)
	r = e.do("GET", "/api/v1/invites/nope", "", nil)
	check(t, "bad invite", r.status == 404, r)

	// sign in again: email + authenticator code, each code once
	e.advance(30 * time.Second)
	r = e.do("POST", "/api/v1/login", "", map[string]any{"email": "WANG@corp.com", "totp": totpNow(lei.secret, e.now())})
	check(t, "login", r.status == 200 && len(r.body["session"].(string)) == 64, r)
	r = e.do("POST", "/api/v1/login", "", map[string]any{"email": "wang@corp.com", "totp": totpNow(lei.secret, e.now())})
	check(t, "a code works once", r.status == 401, r)
	for i := 0; i < 10; i++ {
		e.do("POST", "/api/v1/login", "", map[string]any{"email": "wang@corp.com", "totp": "000000"})
	}
	e.advance(30 * time.Second)
	r = e.do("POST", "/api/v1/login", "", map[string]any{"email": "wang@corp.com", "totp": totpNow(lei.secret, e.now())})
	check(t, "locked after 10 failures", r.status == 429, r)

	// admin disables a member: their sessions stop at once
	check(t, "a member cannot disable", e.do("PATCH", "/api/v1/users/"+admin.id, lei.session, map[string]any{"disabled": true}).status == 403)
	check(t, "an admin cannot disable themselves", e.do("PATCH", "/api/v1/users/"+admin.id, admin.session, map[string]any{"disabled": true}).status == 403)
	r = e.do("PATCH", "/api/v1/users/"+lei.id, admin.session, map[string]any{"disabled": true})
	check(t, "disable", r.status == 200 && r.body["disabled"] == true, r)
	check(t, "disabled person is out", e.do("GET", "/api/v1/me", lei.session, nil).status == 401)

	r = e.do("GET", "/api/v1/users", admin.session, nil)
	check(t, "people", len(r.body["users"].([]any)) == 2, r)
	e.do("POST", "/api/v1/logout", admin.session, nil)
	check(t, "logout", e.do("GET", "/api/v1/me", admin.session, nil).status == 401)
}

func TestV1MachinesAndAgents(t *testing.T) {
	e := newEnv(t)
	zw := e.join("zhang@corp.com", "zhangwei", "admin", "")
	wl := e.join("wang@corp.com", "wanglei", "member", zw.session)

	r := e.do("POST", "/api/v1/machines", zw.session, map[string]any{"name": "张伟的 MacBook Pro"})
	token, _ := r.body["token"].(string)
	mid := r.body["machine"].(map[string]any)["id"].(string)
	check(t, "add a machine, token shown once", r.status == 200 && strings.HasPrefix(token, "tam_"), r)
	r = e.do("PUT", "/api/v1/machine", token, map[string]any{"os": "macOS", "arch": "arm64", "runtimes": []any{"codex", "vim"}, "max_sessions": 3})
	m := r.body["machine"].(map[string]any)
	check(t, "machine reports in", r.status == 200 && m["online"] == true && len(m["runtimes"].([]any)) == 1, r)
	check(t, "a person cannot report as a machine", e.do("PUT", "/api/v1/machine", zw.session, map[string]any{}).status == 403)
	check(t, "the machine token also syncs files", e.do("GET", "/api/files/changes?since=0", token, nil).status == 200)

	r = e.do("POST", "/api/v1/agents", zw.session, map[string]any{"handle": "ama", "name": "阿码", "description": "结算页前端", "machine_id": mid, "dispatch": "confirm"})
	aid, _ := r.body["id"].(string)
	check(t, "create an agent on my machine", r.status == 200 && r.body["runtime"] == "codex" && r.body["autonomy"] == "assist", r)
	r = e.do("POST", "/api/v1/agents", wl.session, map[string]any{"handle": "acha", "machine_id": mid})
	check(t, "not on someone else's machine", r.status == 400, r)
	check(t, "agents and people share handles", e.do("POST", "/api/v1/agents", wl.session, map[string]any{"handle": "zhangwei"}).status == 409)
	check(t, "bad dispatch", e.do("PATCH", "/api/v1/agents/"+aid, zw.session, map[string]any{"dispatch": "anyone"}).status == 400)
	check(t, "only the owner changes it", e.do("PATCH", "/api/v1/agents/"+aid, wl.session, map[string]any{"autonomy": "auto"}).status == 403)
	r = e.do("PATCH", "/api/v1/agents/"+aid, zw.session, map[string]any{"dispatch": "owner", "autonomy": "cautious"})
	check(t, "owner sets who may dispatch", r.body["dispatch"] == "owner" && r.body["autonomy"] == "cautious", r)

	r = e.do("GET", "/api/v1/me", token, nil)
	check(t, "a machine sees its agents", r.body["machine"].(map[string]any)["id"] == mid && len(r.body["agents"].([]any)) == 1, r)

	e.advance(4 * time.Minute)
	r = e.do("GET", "/api/v1/machines", wl.session, nil)
	check(t, "machine goes offline", r.body["machines"].([]any)[0].(map[string]any)["online"] == false, r)

	check(t, "someone else cannot remove my machine", e.do("DELETE", "/api/v1/machines/"+mid, wl.session, nil).status == 403)
	e.do("DELETE", "/api/v1/machines/"+mid, zw.session, nil)
	check(t, "a removed machine's token stops", e.do("GET", "/api/v1/me", token, nil).status == 401)
	r = e.do("GET", "/api/v1/agents", zw.session, nil)
	check(t, "its agents lose the machine", r.body["agents"].([]any)[0].(map[string]any)["machine_id"] == nil, r)
}

func TestV1ChannelsAndMessages(t *testing.T) {
	e := newEnv(t)
	zw := e.join("zhang@corp.com", "zhangwei", "admin", "")
	wl := e.join("wang@corp.com", "wanglei", "member", zw.session)
	ll := e.join("liu@corp.com", "liuli", "member", zw.session)
	r := e.do("POST", "/api/v1/machines", wl.session, map[string]any{"name": "王磊的 Mac"})
	token, mid := r.body["token"].(string), r.body["machine"].(map[string]any)["id"].(string)
	r = e.do("POST", "/api/v1/agents", wl.session, map[string]any{"handle": "acha", "name": "阿查", "machine_id": mid})
	aid := r.body["id"].(string)

	r = e.do("POST", "/api/v1/channels", zw.session, map[string]any{"name": "支付前端", "topic": "结算页", "members": []any{
		map[string]any{"kind": "user", "id": wl.id}, map[string]any{"kind": "agent", "id": aid}}})
	cid := r.body["id"].(string)
	check(t, "create a channel with people and an agent", r.status == 200 && strings.HasPrefix(r.body["slug"].(string), "ch-") && len(r.body["members"].([]any)) == 3, r)
	check(t, "duplicate slug", e.do("POST", "/api/v1/channels", zw.session, map[string]any{"name": "x", "slug": r.body["slug"]}).status == 409)

	// a person who is not in the channel reads it but cannot post until they join
	check(t, "outsider reads", e.do("GET", "/api/v1/channels/"+cid+"/messages", ll.session, nil).status == 200)
	check(t, "outsider cannot post", e.do("POST", "/api/v1/channels/"+cid+"/messages", ll.session, map[string]any{"text": "hi"}).status == 403)
	check(t, "join", e.do("POST", "/api/v1/channels/"+cid+"/members", ll.session, nil).status == 200)

	r = e.do("POST", "/api/v1/channels/"+cid+"/messages", zw.session, map[string]any{"text": "@acha 看下慢查询，@wanglei 你确认一下 @nobody", "client_id": "c1"})
	root := r.body["id"].(string)
	ms := r.body["mentions"].([]any)
	check(t, "post with mentions", r.status == 200 && len(ms) == 2 && ms[0].(map[string]any)["kind"] == "agent" && ms[1].(map[string]any)["id"] == wl.id, r)
	r = e.do("POST", "/api/v1/channels/"+cid+"/messages", zw.session, map[string]any{"text": "@acha 看下慢查询", "client_id": "c1"})
	check(t, "client_id retry returns the first", r.body["id"] == root, r)

	// the agent answers in the thread through its machine
	r = e.do("POST", "/api/v1/channels/"+cid+"/messages", token, map[string]any{"text": "orders 表缺索引", "thread_id": root, "as_agent": aid})
	reply := r.body["id"].(string)
	check(t, "agent replies in the thread", r.status == 200 && r.body["author"].(map[string]any)["kind"] == "agent" && r.body["thread_id"] == root, r)
	check(t, "a machine posts only as its own agents", e.do("POST", "/api/v1/channels/"+cid+"/messages", token, map[string]any{"text": "x"}).status == 403)
	r = e.do("POST", "/api/v1/channels/"+cid+"/messages", wl.session, map[string]any{"text": "好", "thread_id": reply})
	check(t, "a reply to a reply joins the thread", r.body["thread_id"] == root, r)

	r = e.do("GET", "/api/v1/channels/"+cid+"/messages", ll.session, nil)
	top := r.body["messages"].([]any)
	check(t, "channel shows top-level messages with reply counts", len(top) == 1 && num(top[0].(map[string]any)["reply_count"]) == 2, r)
	r = e.do("GET", "/api/v1/messages/"+reply+"/thread", ll.session, nil)
	check(t, "thread", r.body["root"].(map[string]any)["id"] == root && len(r.body["replies"].([]any)) == 2, r)

	check(t, "cannot edit someone else's message", e.do("PATCH", "/api/v1/messages/"+root, wl.session, map[string]any{"text": "x"}).status == 403)
	r = e.do("PATCH", "/api/v1/messages/"+root, zw.session, map[string]any{"text": "@acha 看下慢查询（改）"})
	check(t, "edit", r.status == 200 && r.body["edited"] != nil, r)

	r = e.do("GET", "/api/v1/updates?after=0", token, nil)
	check(t, "the machine catches up on its agents' channels", len(r.body["messages"].([]any)) == 3, r)
	r = e.do("GET", "/api/v1/channels", token, nil)
	check(t, "a machine lists only its agents' channels", len(r.body["channels"].([]any)) == 1, r)
	e.do("POST", "/api/v1/channels", zw.session, map[string]any{"name": "发版"})
	r = e.do("GET", "/api/v1/channels", token, nil)
	check(t, "…not others", len(r.body["channels"].([]any)) == 1, r)

	// paging: newest first page, then before=
	for i := 0; i < 5; i++ {
		e.do("POST", "/api/v1/channels/"+cid+"/messages", ll.session, map[string]any{"text": fmt.Sprint("n", i)})
	}
	r = e.do("GET", "/api/v1/channels/"+cid+"/messages?limit=3", zw.session, nil)
	page := r.body["messages"].([]any)
	check(t, "page of the newest, oldest first", len(page) == 3 && r.body["more"] == true && page[2].(map[string]any)["text"] == "n4", r)
	r = e.do("GET", fmt.Sprintf("/api/v1/channels/%s/messages?limit=3&before=%d", cid, num(page[0].(map[string]any)["seq"])), zw.session, nil)
	check(t, "older page", len(r.body["messages"].([]any)) == 3, r)

	// leave, remove the agent, archive
	check(t, "a member removes an agent", e.do("DELETE", "/api/v1/channels/"+cid+"/members/agent/"+aid, ll.session, nil).status == 200)
	check(t, "but not another person", e.do("DELETE", "/api/v1/channels/"+cid+"/members/user/"+wl.id, ll.session, nil).status == 403)
	check(t, "the machine loses the channel", e.do("GET", "/api/v1/channels/"+cid+"/messages", token, nil).status == 404)
	e.do("PATCH", "/api/v1/channels/"+cid, zw.session, map[string]any{"archived": true})
	check(t, "archived channels take no posts", e.do("POST", "/api/v1/channels/"+cid+"/messages", zw.session, map[string]any{"text": "x"}).status == 409)
}

func TestV1Stream(t *testing.T) {
	e := newEnv(t)
	zw := e.join("zhang@corp.com", "zhangwei", "admin", "")
	wl := e.join("wang@corp.com", "wanglei", "member", zw.session)
	ll := e.join("liu@corp.com", "liuli", "member", zw.session)
	r := e.do("POST", "/api/v1/machines", wl.session, map[string]any{"name": "王磊的 Mac"})
	token, mid := r.body["token"].(string), r.body["machine"].(map[string]any)["id"].(string)
	aid := e.do("POST", "/api/v1/agents", wl.session, map[string]any{"handle": "acha", "machine_id": mid}).body["id"].(string)
	cid := e.do("POST", "/api/v1/channels", zw.session, map[string]any{"name": "pay", "members": []any{map[string]any{"kind": "agent", "id": aid}}}).body["id"].(string)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws := strings.Replace(e.srv.URL, "http", "ws", 1) + "/api/v1/stream?token="
	dial := func(tok string) *websocket.Conn {
		c, _, err := websocket.Dial(ctx, ws+tok, nil)
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	zc, lc := dial(zw.session), dial(ll.session)
	defer zc.CloseNow()
	defer lc.CloseNow()
	read := func(c *websocket.Conn, want string) {
		t.Helper()
		for {
			_, b, err := c.Read(ctx)
			if err != nil {
				t.Fatalf("waiting for %q: %v", want, err)
			}
			if strings.Contains(string(b), want) {
				return
			}
		}
	}
	mc := dial(token)
	defer mc.CloseNow()
	read(zc, `"online":true`) // people see the machine come online

	e.do("POST", "/api/v1/channels/"+cid+"/messages", zw.session, map[string]any{"text": "@acha 开工"})
	read(mc, `"text":"@acha 开工"`) // the agent's machine hears it
	read(zc, `"text":"@acha 开工"`)
	e.do("POST", "/api/v1/channels/"+cid+"/members", ll.session, nil)
	read(lc, `"type":"channel"`) // everyone hears the membership change
	e.do("POST", "/api/v1/channels/"+cid+"/messages", token, map[string]any{"text": "收到", "as_agent": aid})
	read(lc, `"text":"收到"`) // …and, once in, the messages

	_, _, err := websocket.Dial(ctx, ws+"bad", nil)
	check(t, "stream needs a credential", err != nil)
	_, resp, _ := websocket.Dial(ctx, ws+machineToken, nil)
	check(t, "legacy token has no v1 stream", resp != nil && resp.StatusCode == http.StatusUnauthorized)
}
