package hub

import (
	"bytes"
	"fmt"
	"net/url"
	"testing"
)

func TestSearch(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	other := e.do("POST", "/api/v1/channels", e.zw.session, map[string]any{"name": "运维"}).body["id"].(string)
	e.do("POST", "/api/v1/channels/"+other+"/messages", e.zw.session, map[string]any{"text": "订单服务的慢查询告警又响了"})
	m := e.post(e.wl.session, "orders 表的慢查询要加索引", "")
	e.post(e.ll.session, "退款接口也慢", m["id"].(string))
	pdf := e.do("POST", "/api/v1/uploads?name=索引方案.pdf", e.zw.session, bytes.NewBufferString("%PDF-1.4"), "content-type", "application/pdf").body["path"].(string)
	e.do("POST", "/api/v1/channels/"+e.cid+"/messages", e.zw.session, map[string]any{"text": "方案见附件", "attachments": []any{pdf}})
	tm := e.post(e.zw.session, "@acha 排查支付回调超时", "")
	id := e.do("GET", "/api/v1/tasks?thread="+tm["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "回调重试间隔太短，改成指数退避"})

	find := func(q string, extra ...string) ([]any, []any) {
		u := "/api/v1/search?q=" + url.QueryEscape(q)
		for i := 0; i+1 < len(extra); i += 2 {
			u += "&" + extra[i] + "=" + url.QueryEscape(extra[i+1])
		}
		r := e.do("GET", u, e.ll.session, nil)
		if r.status != 200 {
			t.Fatalf("%s: %d %s", q, r.status, r.raw)
		}
		return r.body["messages"].([]any), r.body["tasks"].([]any)
	}
	text := func(ms []any) []string {
		var out []string
		for _, m := range ms {
			out = append(out, m.(map[string]any)["text"].(string))
		}
		return out
	}
	ms, _ := find("慢查询")
	check(t, "Chinese, any channel, newest first", len(ms) == 2 && ms[0].(map[string]any)["text"] == "orders 表的慢查询要加索引", resp{raw: []byte(fmtAny(text(ms)))})
	ms, _ = find("慢查询", "channel", e.cid)
	check(t, "one channel", len(ms) == 1)
	ms, _ = find("慢查询 orders")
	check(t, "all the words", len(ms) == 1)
	ms, _ = find("慢")
	check(t, "a short word still matches", len(ms) == 3, resp{raw: []byte(fmtAny(text(ms)))})
	ms, _ = find("索引方案")
	check(t, "an attachment's name", len(ms) == 1 && ms[0].(map[string]any)["text"] == "方案见附件")
	ms, _ = find("慢", "from", "liuli")
	check(t, "from someone", len(ms) == 1 && ms[0].(map[string]any)["text"] == "退款接口也慢")
	_, ts := find("指数退避")
	check(t, "a task by its summary", len(ts) == 1 && ts[0].(map[string]any)["id"] == id)
	_, ts = find(id)
	check(t, "a task by its id", len(ts) == 1)
	e.h.setTask(id, map[string]any{"title": "支付回调偶发超时"})
	_, ts = find("偶发超时")
	check(t, "a new title is found", len(ts) == 1)
	check(t, "a machine cannot search", e.do("GET", "/api/v1/search?q=x", e.token, nil).status == 403)
	check(t, "nothing to look for", e.do("GET", "/api/v1/search?q=+", e.ll.session, nil).status == 400)
}

func fmtAny(v any) string { return fmt.Sprint(v) }

// A database from before the index gets everything indexed once when it opens.
func TestSearchBackfill(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	e.post(e.wl.session, "老消息：慢查询", "")
	for _, s := range []string{"DROP TRIGGER search_msg_ai", "DROP TRIGGER search_msg_au", "DROP TRIGGER search_msg_ad", "DROP TRIGGER search_task_ai",
		"DROP TRIGGER search_task_au", "DROP TRIGGER search_task_ad", "DROP TABLE search"} {
		e.h.must(e.h.db.Exec(s))
	}
	if err := initSearch(e.h.db); err != nil {
		t.Fatal(err)
	}
	ms, _ := e.h.search(searchQuery{words: []string{"慢查询"}, limit: 10})
	check(t, "indexed once", len(ms) == 1)
	if err := initSearch(e.h.db); err != nil {
		t.Fatal(err)
	}
	ms, _ = e.h.search(searchQuery{words: []string{"慢查询"}, limit: 10})
	check(t, "and not twice", len(ms) == 1)
}
