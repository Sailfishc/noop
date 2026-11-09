package hub

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

// What else the agent's remi command does while its task runs: channel, who, file, memory, say, upload.
func TestAgentCLI(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	e.do("PATCH", "/api/v1/agents/"+e.aid, e.wl.session, map[string]any{"description": "查慢查询", "memory": "- orders 表很大"})
	pdf := e.do("POST", "/api/v1/uploads?name=spec.pdf", e.zw.session, bytes.NewBufferString("%PDF-1.4 hi"), "content-type", "application/pdf").body["path"].(string)
	other := e.do("POST", "/api/v1/channels", e.zw.session, map[string]any{"name": "机密"}).body["id"].(string)
	secret := e.do("POST", "/api/v1/uploads?name=pay.pdf", e.zw.session, bytes.NewBufferString("%PDF-1.4 pay"), "content-type", "application/pdf").body["path"].(string)
	e.do("POST", "/api/v1/channels/"+other+"/messages", e.zw.session, map[string]any{"text": "工资", "attachments": []any{secret}})
	m := e.do("POST", "/api/v1/channels/"+e.cid+"/messages", e.zw.session, map[string]any{"text": "@acha 按文档改", "attachments": []any{pdf}}).body
	id := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	tok := e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil).body["read_token"].(string)
	txt := func(r resp) string { return string(r.raw) }

	r := e.do("GET", "/api/v1/agent/channel", tok, nil)
	check(t, "its channel: purpose and who is in it", strings.Contains(txt(r), "purpose: 订单服务") && strings.Contains(txt(r), "wanglei (@wanglei), person") &&
		strings.Contains(txt(r), "阿查 (@acha), agent on codex, responsible: @wanglei: 查慢查询"), r)
	check(t, "not a channel it is not in", e.do("GET", "/api/v1/agent/channel?channel=机密", tok, nil).status == 404)
	r = e.do("GET", "/api/v1/agent/who?handle=@acha", tok, nil)
	check(t, "who an agent is and what it works on", strings.Contains(txt(r), "agent on codex") && strings.Contains(txt(r), id), r)
	check(t, "who a person is", strings.Contains(txt(e.do("GET", "/api/v1/agent/who?handle=liuli", tok, nil)), "@liuli), person"))
	check(t, "nobody", e.do("GET", "/api/v1/agent/who?handle=nobody", tok, nil).status == 404)

	r = e.do("GET", "/api/v1/agent/file?path="+pdf, tok, nil)
	check(t, "a file attached in its channel", r.status == 200 && txt(r) == "%PDF-1.4 hi", r)
	check(t, "not one from elsewhere", e.do("GET", "/api/v1/agent/file?path="+secret, tok, nil).status == 404)
	check(t, "its memory", txt(e.do("GET", "/api/v1/agent/memory", tok, nil)) == "- orders 表很大\n")

	r = e.do("POST", "/api/v1/agent/say", tok, map[string]any{"text": "文档看完了，开始改"})
	th := e.do("GET", "/api/v1/messages/"+m["id"].(string)+"/thread", e.zw.session, nil).body["replies"].([]any)
	check(t, "a word in the thread", r.status == 200 && len(th) == 1 && th[0].(map[string]any)["text"] == "文档看完了，开始改", r)
	check(t, "not again so soon", e.do("POST", "/api/v1/agent/say", tok, map[string]any{"text": "还在改"}).status == 429)
	e.advance(6 * time.Minute)
	check(t, "later, yes; plain text works too", e.do("POST", "/api/v1/agent/say", tok, bytes.NewBufferString("改到一半"), "content-type", "text/plain; charset=utf-8").status == 200)

	r = e.do("POST", "/api/v1/agent/upload?name=draft.md", tok, bytes.NewBufferString("# 草稿"), "content-type", "")
	outs := e.task(id)["outputs"].([]any)
	check(t, "a file handed over now", r.status == 200 && len(outs) == 1 && outs[0].(map[string]any)["name"] == "draft.md", r)

	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "改好了"})
	check(t, "once the run ended, it can do nothing", e.do("POST", "/api/v1/agent/say", tok, map[string]any{"text": "x"}).status == 403 &&
		e.do("GET", "/api/v1/agent/memory", tok, nil).status == 403)
}
