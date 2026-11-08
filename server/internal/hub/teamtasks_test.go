package hub

import (
	"fmt"
	"testing"
)

type taskEnv struct {
	*env
	zw, wl, ll joined
	token, mid string
	aid, cid   string
	otherToken string
}

// newTaskEnv: 张伟 (admin), 王磊 who owns @acha on his Mac, 刘丽; all three and @acha in one channel.
func newTaskEnv(t *testing.T, dispatch string) *taskEnv {
	e := &taskEnv{env: newEnv(t)}
	e.zw = e.join("zhang@corp.com", "zhangwei", "admin", "")
	e.wl = e.join("wang@corp.com", "wanglei", "member", e.zw.session)
	e.ll = e.join("liu@corp.com", "liuli", "member", e.zw.session)
	r := e.do("POST", "/api/v1/machines", e.wl.session, map[string]any{"name": "王磊的 Mac"})
	e.token, e.mid = r.body["token"].(string), r.body["machine"].(map[string]any)["id"].(string)
	r = e.do("POST", "/api/v1/machines", e.zw.session, map[string]any{"name": "张伟的 Mac"})
	e.otherToken = r.body["token"].(string)
	r = e.do("POST", "/api/v1/agents", e.wl.session, map[string]any{"handle": "acha", "name": "阿查", "machine_id": e.mid, "dispatch": dispatch, "repo": "~/work/pay"})
	e.aid = r.body["id"].(string)
	check(t, "agent has its repo", r.body["repo"] == "~/work/pay", r)
	r = e.do("POST", "/api/v1/channels", e.zw.session, map[string]any{"name": "支付后端", "topic": "订单服务", "members": []any{
		map[string]any{"kind": "user", "id": e.wl.id}, map[string]any{"kind": "user", "id": e.ll.id}, map[string]any{"kind": "agent", "id": e.aid}}})
	e.cid = r.body["id"].(string)
	return e
}

func (e *taskEnv) post(session, text, thread string) map[string]any {
	body := map[string]any{"text": text}
	if thread != "" {
		body["thread_id"] = thread
	}
	r := e.do("POST", "/api/v1/channels/"+e.cid+"/messages", session, body)
	if r.status != 200 {
		e.t.Fatalf("post: %d %s", r.status, r.raw)
	}
	return r.body
}

func (e *taskEnv) task(id string) map[string]any {
	return e.do("GET", "/api/v1/tasks/"+id, e.zw.session, nil).body
}

func (e *taskEnv) inbox(s string) []any {
	return e.do("GET", "/api/v1/inbox", s, nil).body["tasks"].([]any)
}

func TestTaskConfirmClaimReport(t *testing.T) {
	e := newTaskEnv(t, "confirm")
	m := e.post(e.zw.session, "@acha 看下 /orders 的慢查询\n昨晚 P99 3 秒", "")
	r := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil)
	ts := r.body["tasks"].([]any)
	check(t, "an @agent becomes a task", len(ts) == 1, r)
	tk := ts[0].(map[string]any)
	id := tk["id"].(string)
	check(t, "numbered, titled, waiting for the owner", id == "T-0001" && tk["title"] == "看下 /orders 的慢查询" && tk["state"] == "pending" && tk["branch"] == "agent/T-0001", resp{raw: []byte(fmt.Sprint(tk))})
	e.post(e.zw.session, "没 @ 的消息", "")
	check(t, "plain messages are not tasks", len(e.do("GET", "/api/v1/tasks", e.zw.session, nil).body["tasks"].([]any)) == 1)

	check(t, "the owner's inbox has it", len(e.inbox(e.wl.session)) == 1)
	check(t, "the creator's does not (yet)", len(e.inbox(e.zw.session)) == 0)
	check(t, "a machine cannot claim before it is confirmed", e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil).status == 409)
	check(t, "only the owner confirms", e.do("POST", "/api/v1/tasks/"+id+"/confirm", e.ll.session, nil).status == 403)
	check(t, "the owner confirms", e.do("POST", "/api/v1/tasks/"+id+"/confirm", e.wl.session, nil).body["state"] == "queued")

	r = e.do("GET", "/api/v1/machine/tasks", e.token, nil)
	check(t, "the machine sees its queued task", len(r.body["tasks"].([]any)) == 1, r)
	check(t, "another machine cannot claim it", e.do("POST", "/api/v1/tasks/"+id+"/claim", e.otherToken, nil).status == 403)
	r = e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	check(t, "claim", r.status == 200 && r.body["task"].(map[string]any)["state"] == "running" && r.body["task"].(map[string]any)["runs"] == float64(1), r)
	check(t, "the claim brings the request", len(r.body["new"].([]any)) == 1 && r.body["channel"].(map[string]any)["topic"] == "订单服务", r)
	check(t, "and the agent's repo", r.body["agent"].(map[string]any)["repo"] == "~/work/pay", r)

	// progress stays on the card; the result goes to the thread
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"step": "读 orders 表的执行计划", "session": "thr_1"})
	tk = e.task(id)
	check(t, "step and session", tk["step"] == "读 orders 表的执行计划" && tk["session"] == "thr_1", resp{raw: []byte(fmt.Sprint(tk))})
	r = e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "加了 (user_id, created_at) 索引，P99 降到 80ms"})
	check(t, "result", r.body["state"] == "review" && r.body["step"] == "", r)
	th := e.do("GET", "/api/v1/messages/"+m["id"].(string)+"/thread", e.zw.session, nil).body["replies"].([]any)
	last := th[len(th)-1].(map[string]any)
	check(t, "the summary is the agent's reply in the thread", last["text"] == "加了 (user_id, created_at) 索引，P99 降到 80ms" && last["author"].(map[string]any)["kind"] == "agent", resp{raw: []byte(fmt.Sprint(last))})
	check(t, "the creator reviews it", len(e.inbox(e.zw.session)) == 1)
	check(t, "a stale run cannot report", e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "failed"}).status == 409)

	// the task subscribes to its thread: a reply reopens it, and the next claim hands it over
	e.post(e.zw.session, "顺便把 /refunds 也看一下", m["id"].(string))
	check(t, "a reply reopens it", e.task(id)["state"] == "queued")
	r = e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	fresh := r.body["new"].([]any)
	check(t, "the next run gets only what is new", len(fresh) == 1 && fresh[0].(map[string]any)["text"] == "顺便把 /refunds 也看一下" && r.body["task"].(map[string]any)["runs"] == float64(2), r)

	// said while it runs: the run's end turns into another turn
	e.post(e.wl.session, "注意别锁表", m["id"].(string))
	check(t, "running stays running", e.task(id)["state"] == "running")
	r = e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "/refunds 也加了索引"})
	check(t, "unseen words queue the next turn", r.body["state"] == "queued", r)
	r = e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	check(t, "with them", len(r.body["new"].([]any)) == 1, r)

	// a decision card
	r = e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "needs_decision", "summary": "加索引要锁表约 30 秒",
		"decision": map[string]any{"question": "现在上线吗？", "options": []any{"A: 现在上", "B: 夜里再上"}, "recommendation": "B"}})
	check(t, "needs a decision", r.body["state"] == "needs_decision" && r.body["decision"].(map[string]any)["question"] == "现在上线吗？", r)
	check(t, "outsiders cannot decide", e.do("POST", "/api/v1/tasks/"+id+"/decide", e.ll.session, map[string]any{"choice": "A"}).status == 403)
	r = e.do("POST", "/api/v1/tasks/"+id+"/decide", e.zw.session, map[string]any{"choice": "B: 夜里再上"})
	check(t, "the creator decides; it goes back to the agent", r.body["state"] == "queued" && r.body["decision"].(map[string]any)["answer"] == "B: 夜里再上", r)
	r = e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	check(t, "the answer is in the new messages", r.body["new"].([]any)[0].(map[string]any)["text"] == "决定：B: 夜里再上", r)

	// a merged PR finishes it
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "PR 已开"})
	r = e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"pr": map[string]any{"provider": "github", "url": "https://github.com/acme/pay/pull/7", "number": 7, "state": "merged", "checks": "success"}})
	check(t, "merged PR → done", r.body["state"] == "done" && r.body["pr"].(map[string]any)["number"] == float64(7), r)
}

func TestTaskDispatchRules(t *testing.T) {
	e := newTaskEnv(t, "owner")
	e.post(e.zw.session, "@acha 帮个忙", "")
	tk := e.task("T-0001")
	check(t, "only the owner may dispatch: closed with why", tk["state"] == "closed" && tk["summary"] == "@acha 只接主人派的活", resp{raw: []byte(fmt.Sprint(tk))})
	e.post(e.wl.session, "@acha 我自己派的", "")
	check(t, "the owner's own needs no confirmation", e.task("T-0002")["state"] == "queued")

	e.do("PATCH", "/api/v1/agents/"+e.aid, e.wl.session, map[string]any{"dispatch": "open"})
	m := e.post(e.ll.session, "@acha 开放派活", "")
	check(t, "open: anyone in the channel", e.task("T-0003")["state"] == "queued")
	e.post(e.zw.session, "@acha 再说一次", m["id"].(string))
	check(t, "an @ in its own thread is not a second task", e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"] != nil &&
		len(e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)) == 1)

	// cancel: the creator or the owner, not a bystander
	check(t, "an admin can cancel any task", e.do("POST", "/api/v1/tasks/T-0003/cancel", e.zw.session, nil).status == 200)
	check(t, "cancelled", e.task("T-0003")["state"] == "closed")
	e.post(e.zw.session, "取消了还说话", m["id"].(string))
	check(t, "a cancelled task stays closed", e.task("T-0003")["state"] == "closed")
	check(t, "a member who is neither cannot cancel", e.do("POST", "/api/v1/tasks/T-0002/cancel", e.ll.session, nil).status == 403)

	// declined by the owner
	e.do("PATCH", "/api/v1/agents/"+e.aid, e.wl.session, map[string]any{"dispatch": "confirm"})
	e.post(e.ll.session, "@acha 帮我查日志", "")
	r := e.do("POST", "/api/v1/tasks/T-0004/decline", e.wl.session, map[string]any{"reason": "这周排满了"})
	check(t, "declined with a reason", r.body["state"] == "closed" && r.body["summary"] == "主人没有接这个活：这周排满了", r)

	// an agent's own message never makes a task
	r = e.do("POST", "/api/v1/channels/"+e.cid+"/messages", e.token, map[string]any{"text": "@acha 自言自语", "as_agent": e.aid})
	check(t, "agents do not dispatch", r.status == 200 && len(e.do("GET", "/api/v1/tasks", e.zw.session, nil).body["tasks"].([]any)) == 4, r)
}

func TestTaskPRsAndGitlabHook(t *testing.T) {
	e := newTaskEnv(t, "open")
	e.post(e.zw.session, "@acha 改一下", "")
	e.do("POST", "/api/v1/tasks/T-0001/claim", e.token, nil)
	e.do("POST", "/api/v1/tasks/T-0001/report", e.token, map[string]any{"state": "review", "summary": "改好了",
		"pr": map[string]any{"provider": "gitlab", "url": "https://code.corp/pay/orders/-/merge_requests/3", "number": 3, "state": "open", "checks": "pending", "repo": "pay/orders"}})
	r := e.do("GET", "/api/v1/machine/tasks?prs=1", e.token, nil)
	check(t, "the machine follows its open PRs", len(r.body["tasks"].([]any)) == 1, r)
	check(t, "not someone else's", len(e.do("GET", "/api/v1/machine/tasks?prs=1", e.otherToken, nil).body["tasks"].([]any)) == 0)

	hook := func(secret string, body map[string]any) resp {
		return e.do("POST", "/api/v1/hooks/gitlab", "", body, "X-Gitlab-Token", secret)
	}
	check(t, "hooks are off without a secret", hook("", map[string]any{}).status == 401)
	e.h.cfg.GitWebhookSecret = "s3cret"
	check(t, "a wrong secret is refused", hook("nope", map[string]any{}).status == 401)
	r = hook("s3cret", map[string]any{"object_kind": "push", "ref": "refs/heads/agent/T-0001"})
	check(t, "push events are ignored", r.status == 200 && r.body["ignored"] == "push", r)
	r = hook("s3cret", map[string]any{"object_kind": "pipeline", "object_attributes": map[string]any{"ref": "agent/T-0001", "status": "failed"}})
	check(t, "a pipeline reaches the task's PR", r.status == 200 && e.task("T-0001")["pr"].(map[string]any)["checks"] == "failure", r)
	r = hook("s3cret", map[string]any{"object_kind": "merge_request", "object_attributes": map[string]any{"iid": 3, "source_branch": "agent/T-0001", "state": "merged", "url": "https://code.corp/pay/orders/-/merge_requests/3"}})
	tk := e.task("T-0001")
	check(t, "merged on Ant Code → done", r.status == 200 && tk["state"] == "done" && tk["pr"].(map[string]any)["state"] == "merged", resp{raw: []byte(fmt.Sprint(tk))})
	r = hook("s3cret", map[string]any{"object_kind": "merge_request", "object_attributes": map[string]any{"source_branch": "feature/x", "state": "merged"}})
	check(t, "other branches are not tasks", r.body["ignored"] == "not a task branch", r)
}
