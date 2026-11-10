package hub

import (
	"strings"
	"testing"
	"time"
)

func TestSignupApproval(t *testing.T) {
	e := newEnv(t)
	zw := e.join("zhang@corp.com", "zhangwei", "admin", "")
	wl := e.join("wang@corp.com", "wanglei", "member", zw.session)

	// the workspace: one per server, a stable id, asking to join on
	r := e.do("GET", "/api/v1/workspace", "", nil)
	wsID, _ := r.body["id"].(string)
	check(t, "a workspace id", r.status == 200 && strings.HasPrefix(wsID, "w_") && r.body["signup"] == true, r)
	r = e.do("GET", "/api/v1/me", wl.session, nil)
	check(t, "me names the workspace", r.body["workspace"].(map[string]any)["id"] == wsID, r)
	check(t, "a member can't change it", e.do("PATCH", "/api/v1/workspace", wl.session, map[string]any{"name": "x"}).status == 403)
	r = e.do("PATCH", "/api/v1/workspace", zw.session, map[string]any{"name": " 支付团队 "})
	check(t, "an admin names it; the id stays", r.status == 200 && r.body["name"] == "支付团队" && r.body["id"] == wsID, r)

	// asking
	ask := func(email, handle string) resp {
		return e.do("POST", "/api/v1/signup", "", map[string]any{"email": email, "name": handle, "handle": handle, "note": "支付组新人"})
	}
	check(t, "a member's email can't ask", ask("WANG@corp.com", "wang2").status == 409)
	check(t, "a taken handle", ask("li@corp.com", "wanglei").status == 409)
	check(t, "bad handle", ask("li@corp.com", "L").status == 400)
	first := ask("li@corp.com", "lina")
	check(t, "asked", first.status == 201 && strings.HasPrefix(first.body["token"].(string), "tsu_"), first)
	r = ask("li@corp.com", "lina")
	token := r.body["token"].(string)
	check(t, "asking again replaces the old application", r.status == 201 && e.do("GET", "/api/v1/signup/"+first.body["token"].(string), "", nil).status == 404, r)
	check(t, "someone else can't ask for a pending handle", ask("x@corp.com", "lina").status == 409)
	r = e.do("GET", "/api/v1/signup/"+token, "", nil)
	check(t, "pending", r.status == 200 && r.body["state"] == "pending", r)
	check(t, "no session before approval", e.do("POST", "/api/v1/signup/"+token+"/session", "", nil).status == 409)

	// admins see it, members don't
	check(t, "members can't list", e.do("GET", "/api/v1/signups", wl.session, nil).status == 403)
	r = e.do("GET", "/api/v1/signups", zw.session, nil)
	list := r.body["signups"].([]any)
	check(t, "one application", r.status == 200 && len(list) == 1 && list[0].(map[string]any)["note"] == "支付组新人", r)
	id := list[0].(map[string]any)["id"].(string)
	r = e.do("GET", "/api/v1/inbox", zw.session, nil)
	check(t, "in the admin's inbox", len(r.body["signups"].([]any)) == 1, r)
	_, inMember := e.do("GET", "/api/v1/inbox", wl.session, nil).body["signups"]
	check(t, "not in a member's inbox", !inMember)
	check(t, "a member can't approve", e.do("POST", "/api/v1/signups/"+id+"/approve", wl.session, nil).status == 403)

	r = e.do("POST", "/api/v1/signups/"+id+"/approve", zw.session, nil)
	check(t, "approved: the account exists", r.status == 200 && r.body["user"].(map[string]any)["handle"] == "lina" && r.body["user"].(map[string]any)["role"] == "member", r)
	check(t, "once", e.do("POST", "/api/v1/signups/"+id+"/approve", zw.session, nil).status == 409)
	check(t, "status approved", e.do("GET", "/api/v1/signup/"+token, "", nil).body["state"] == "approved")
	r = e.do("POST", "/api/v1/signup/"+token+"/session", "", nil)
	session, _ := r.body["session"].(string)
	check(t, "the asking device signs in", r.status == 200 && len(session) == 64, r)
	check(t, "the session works", e.do("GET", "/api/v1/me", session, nil).body["user"].(map[string]any)["email"] == "li@corp.com")
	check(t, "the token works once", e.do("POST", "/api/v1/signup/"+token+"/session", "", nil).status == 404)

	// rejecting
	r = ask("bad@corp.com", "nobody")
	tok2 := r.body["token"].(string)
	id2 := e.do("GET", "/api/v1/signups", zw.session, nil).body["signups"].([]any)[0].(map[string]any)["id"].(string)
	check(t, "rejected", e.do("POST", "/api/v1/signups/"+id2+"/reject", zw.session, nil).status == 200)
	check(t, "status rejected", e.do("GET", "/api/v1/signup/"+tok2, "", nil).body["state"] == "rejected")
	check(t, "no session", e.do("POST", "/api/v1/signup/"+tok2+"/session", "", nil).status == 409)

	// a day's limit per address, and admins can close asking
	// three asked so far from this address
	check(t, "two more today", ask("y1@corp.com", "yy1").status == 201 && ask("y2@corp.com", "yy2").status == 201)
	check(t, "then limited per address", ask("z@corp.com", "zz").status == 429)
	e.do("PATCH", "/api/v1/workspace", zw.session, map[string]any{"signup": false})
	e.advance(25 * time.Hour)
	check(t, "closed", ask("z@corp.com", "zz").status == 403)
}
