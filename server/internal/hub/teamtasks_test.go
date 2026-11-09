package hub

import (
	"fmt"
	"testing"
	"time"
)

type taskEnv struct {
	*env
	zw, wl, ll joined
	token, mid string
	aid, cid   string
	otherToken string
}

// newTaskEnv: 张伟 (admin), 王磊 who owns @acha on his Mac, 刘丽; all three and @acha in one channel.
func newTaskEnv(t *testing.T, dispatch string, confirm bool) *taskEnv {
	e := &taskEnv{env: newEnv(t)}
	e.zw = e.join("zhang@corp.com", "zhangwei", "admin", "")
	e.wl = e.join("wang@corp.com", "wanglei", "member", e.zw.session)
	e.ll = e.join("liu@corp.com", "liuli", "member", e.zw.session)
	r := e.do("POST", "/api/v1/machines", e.wl.session, map[string]any{"name": "王磊的 Mac"})
	e.token, e.mid = r.body["token"].(string), r.body["machine"].(map[string]any)["id"].(string)
	r = e.do("POST", "/api/v1/machines", e.zw.session, map[string]any{"name": "张伟的 Mac"})
	e.otherToken = r.body["token"].(string)
	r = e.do("POST", "/api/v1/agents", e.wl.session, map[string]any{"handle": "acha", "name": "阿查", "machine_id": e.mid, "dispatch": dispatch, "confirm": confirm, "repo": "~/work/pay", "model": "gpt-5.5"})
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
	e := newTaskEnv(t, "channel", true)
	m := e.post(e.zw.session, "@acha 看下 /orders 的慢查询\n昨晚 P99 3 秒", "")
	r := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil)
	ts := r.body["tasks"].([]any)
	check(t, "an @agent becomes a task", len(ts) == 1, r)
	tk := ts[0].(map[string]any)
	id := tk["id"].(string)
	check(t, "numbered, titled, waiting for the owner", id == "T-0001" && tk["title"] == "看下 /orders 的慢查询" && tk["state"] == "pending" && tk["branch"] == "agent/T-0001", resp{raw: []byte(fmt.Sprint(tk))})
	md := tk["mandate"].(map[string]any)
	check(t, "the mandate: who asked, under which rule, how far", md["by"] == e.zw.id && md["rule"] == "channel" && md["confirm"] == true &&
		md["branch"] == "agent/T-0001" && md["autonomy"] == "assist" && md["model"] == "gpt-5.5", resp{raw: []byte(fmt.Sprint(md))})
	check(t, "no acceptance criteria yet", tk["acceptance"] == "")
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
	root := e.do("GET", "/api/v1/messages/"+m["id"].(string)+"/thread", e.zw.session, nil).body["root"].(map[string]any)
	rx := root["reactions"].([]any)
	check(t, "the agent puts 👀 on what it took up", len(rx) == 1 && rx[0].(map[string]any)["emoji"] == "👀" &&
		rx[0].(map[string]any)["author"].(map[string]any)["kind"] == "agent", resp{raw: []byte(fmt.Sprint(root))})
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"reaction": "🔍"})
	root = e.do("GET", "/api/v1/messages/"+m["id"].(string)+"/thread", e.zw.session, nil).body["root"].(map[string]any)
	rx = root["reactions"].([]any)
	check(t, "then its own emoji for how it read it, in place of the 👀", len(rx) == 1 && rx[0].(map[string]any)["emoji"] == "🔍", resp{raw: []byte(fmt.Sprint(root))})
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"reaction": "ok"})
	check(t, "not just any text", len(e.do("GET", "/api/v1/messages/"+m["id"].(string)+"/thread", e.zw.session, nil).body["root"].(map[string]any)["reactions"].([]any)) == 1)
	check(t, "and the agent's repo", r.body["agent"].(map[string]any)["repo"] == "~/work/pay", r)

	// acceptance criteria: the agent may propose them while people wrote none; people can always rewrite them
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"acceptance": "P99 < 200ms"})
	check(t, "the agent proposes criteria", e.task(id)["acceptance"] == "P99 < 200ms")
	check(t, "a bystander cannot edit them", e.do("PATCH", "/api/v1/tasks/"+id, e.ll.session, map[string]any{"acceptance": "x"}).status == 403)
	r = e.do("PATCH", "/api/v1/tasks/"+id, e.zw.session, map[string]any{"acceptance": "P99 < 100ms，不锁表"})
	check(t, "the creator rewrites them", r.body["acceptance"] == "P99 < 100ms，不锁表", r)
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"acceptance": "随便"})
	check(t, "the agent does not overwrite people's criteria", e.task(id)["acceptance"] == "P99 < 100ms，不锁表")

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

	// a run that changed nothing (a lookup, an answer): its summary is the result, so nobody has to accept it
	r = e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "没有锁表风险", "answer": true, "result": "unconfirmed"})
	check(t, "an unconfirmed answer still waits for review", r.body["state"] == "review", r)
	e.post(e.zw.session, "再确认一下", m["id"].(string))
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	r = e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "确认没有锁表风险", "answer": true})
	check(t, "an answer is done at once", r.body["state"] == "done", r)
	e.post(e.zw.session, "那 /refunds 呢", m["id"].(string))
	check(t, "a reply still goes on", e.task(id)["state"] == "queued")
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)

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
	e := newTaskEnv(t, "owner", true)
	e.post(e.zw.session, "@acha 帮个忙", "")
	tk := e.task("T-0001")
	check(t, "only the owner may dispatch: closed with why", tk["state"] == "closed" && tk["summary"] == "@acha 只接主人派的活", resp{raw: []byte(fmt.Sprint(tk))})
	e.post(e.wl.session, "@acha 我自己派的", "")
	check(t, "the owner's own needs no confirmation", e.task("T-0002")["state"] == "queued")

	e.do("PATCH", "/api/v1/agents/"+e.aid, e.wl.session, map[string]any{"dispatch": "channel", "confirm": false})
	m := e.post(e.ll.session, "@acha 开放派活", "")
	check(t, "channel, no confirm: anyone in the channel", e.task("T-0003")["state"] == "queued")
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
	e.do("PATCH", "/api/v1/agents/"+e.aid, e.wl.session, map[string]any{"confirm": true})
	e.post(e.ll.session, "@acha 帮我查日志", "")
	r := e.do("POST", "/api/v1/tasks/T-0004/decline", e.wl.session, map[string]any{"reason": "这周排满了"})
	check(t, "declined with a reason", r.body["state"] == "closed" && r.body["summary"] == "主人没有接这个活：这周排满了", r)

	// an agent's own message never makes a task
	r = e.do("POST", "/api/v1/channels/"+e.cid+"/messages", e.token, map[string]any{"text": "@acha 自言自语", "as_agent": e.aid})
	check(t, "agents do not dispatch", r.status == 200 && len(e.do("GET", "/api/v1/tasks", e.zw.session, nil).body["tasks"].([]any)) == 4, r)
}

func TestTaskPRsAndGitlabHook(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
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

	ended := func(token string) int {
		return len(e.do("GET", "/api/v1/machine/tasks?ended=T-0001,T-0099", token, nil).body["tasks"].([]any))
	}
	check(t, "an ended task's folder is kept for a week", ended(e.token) == 0)
	e.advance(endedKeep + time.Minute)
	check(t, "then the machine may remove it", ended(e.token) == 1)
	check(t, "not another machine's", ended(e.otherToken) == 0)
}

func TestTaskTeamScopeAndAcceptance(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	r := e.do("POST", "/api/v1/channels", e.ll.session, map[string]any{"name": "产品", "members": []any{}})
	other := r.body["id"].(string)
	say := func(text string) {
		if r := e.do("POST", "/api/v1/channels/"+other+"/messages", e.ll.session, map[string]any{"text": text}); r.status != 200 {
			t.Fatalf("post: %d %s", r.status, r.raw)
		}
	}
	say("@acha 帮忙看下需求")
	check(t, "channel scope: not called where it is not", len(e.do("GET", "/api/v1/tasks", e.zw.session, nil).body["tasks"].([]any)) == 0)

	e.do("PATCH", "/api/v1/agents/"+e.aid, e.wl.session, map[string]any{"dispatch": "team", "confirm": true})
	say("@acha 帮忙看下需求\n验收标准：\n- 列出三个风险\n- 给出排期")
	ts := e.do("GET", "/api/v1/tasks?channel="+other, e.ll.session, nil).body["tasks"].([]any)
	check(t, "team scope: a task anywhere", len(ts) == 1, resp{raw: []byte(fmt.Sprint(ts))})
	tk := ts[0].(map[string]any)
	md := tk["mandate"].(map[string]any)
	check(t, "it joined, and waits for its owner", tk["state"] == "pending" && md["joined"] == true && md["rule"] == "team", resp{raw: []byte(fmt.Sprint(tk))})
	check(t, "the agent is now in the channel", e.h.isMember(other, "agent", e.aid))
	check(t, "acceptance criteria come out of the message", tk["acceptance"] == "- 列出三个风险\n- 给出排期" && tk["body"] == "@acha 帮忙看下需求", resp{raw: []byte(fmt.Sprint(tk))})
}

func TestDispatchMigration(t *testing.T) {
	e := newTaskEnv(t, "channel", true)
	e.h.db.Exec("UPDATE agents SET dispatch = 'open', confirm = 1 WHERE id = ?", e.aid)
	if err := initSchema(e.h.db); err != nil {
		t.Fatal(err)
	}
	a, _ := e.h.agent(e.aid)
	check(t, "open → channel without confirmation", a.Dispatch == "channel" && !a.Confirm, resp{raw: []byte(fmt.Sprint(a))})
	e.h.db.Exec("UPDATE agents SET dispatch = 'confirm', confirm = 0 WHERE id = ?", e.aid)
	_ = initSchema(e.h.db)
	a, _ = e.h.agent(e.aid)
	check(t, "confirm → channel with confirmation", a.Dispatch == "channel" && a.Confirm, resp{raw: []byte(fmt.Sprint(a))})
}

// People see five statuses and a "needs you" mark; the run's state stays underneath.
func TestTaskStatusAndReopen(t *testing.T) {
	e := newTaskEnv(t, "channel", true)
	m := e.post(e.zw.session, "@acha 看下慢查询", "")
	id := e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)["id"].(string)
	tk := e.task(id)
	check(t, "pending: todo, needs the owner's yes", tk["status"] == "todo" && tk["needs"] == "confirm", resp{raw: []byte(fmt.Sprint(tk))})
	e.do("POST", "/api/v1/tasks/"+id+"/confirm", e.wl.session, nil)
	tk = e.task(id)
	check(t, "queued: in progress, nothing needed", tk["status"] == "in_progress" && tk["needs"] == "", resp{raw: []byte(fmt.Sprint(tk))})
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "blocked", "summary": "没有数据库权限"})
	tk = e.task(id)
	check(t, "blocked: still in progress, needs a person", tk["status"] == "in_progress" && tk["needs"] == "unblock", resp{raw: []byte(fmt.Sprint(tk))})
	r := e.do("GET", "/api/v1/tasks?status=in_progress", e.zw.session, nil)
	check(t, "filter by status", len(r.body["tasks"].([]any)) == 1, r)
	check(t, "a status filter must be one of the five", e.do("GET", "/api/v1/tasks?status=blocked", e.zw.session, nil).status == 400)
	r = e.do("POST", "/api/v1/tasks/"+id+"/accept", e.zw.session, nil)
	check(t, "people may call it done themselves", r.body["status"] == "done", r)
	check(t, "only the parties reopen", e.do("POST", "/api/v1/tasks/"+id+"/reopen", e.ll.session, nil).status == 403)
	r = e.do("POST", "/api/v1/tasks/"+id+"/reopen", e.zw.session, map[string]any{"note": "还有 /refunds"})
	check(t, "reopened: back in progress", r.body["status"] == "in_progress" && r.body["state"] == "queued", r)
	r = e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	fresh := r.body["new"].([]any)
	check(t, "the agent hears why", len(fresh) == 1 && fresh[0].(map[string]any)["text"] == "重新打开了这个任务：还有 /refunds", r)
	check(t, "reopen only from done or closed", e.do("POST", "/api/v1/tasks/"+id+"/reopen", e.zw.session, nil).status == 409)
}

// As in Raft, a task is a message someone has to act on: a question is only answered; a run is tracked when the
// person asks for it ("as task"), converts it, or the agent claims it.
func TestTaskTracking(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	tasksOf := func(m map[string]any) map[string]any {
		return e.do("GET", "/api/v1/tasks?thread="+m["id"].(string), e.zw.session, nil).body["tasks"].([]any)[0].(map[string]any)
	}
	q := e.post(e.zw.session, "@acha /orders 的索引有哪些", "")
	tk := tasksOf(q)
	id := tk["id"].(string)
	check(t, "an @agent is a conversation turn, not a tracked task", tk["tracked"] == false && tk["state"] == "queued", resp{raw: []byte(fmt.Sprint(tk))})
	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	r := e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "有两个", "answer": true})
	check(t, "answered: done, still untracked", r.body["state"] == "done" && r.body["tracked"] == false, r)
	r = e.do("GET", "/api/v1/tasks?tracked=1", e.zw.session, nil)
	check(t, "the board has none", len(r.body["tasks"].([]any)) == 0, r)

	// the agent claims what it has to act on
	c := e.post(e.zw.session, "@acha 给 /orders 加个索引", "")
	id2 := tasksOf(c)["id"].(string)
	e.do("POST", "/api/v1/tasks/"+id2+"/claim", e.token, nil)
	r = e.do("POST", "/api/v1/tasks/"+id2+"/report", e.token, map[string]any{"track": true, "title": "给 orders 加索引"})
	check(t, "the agent claims it, with its title", r.body["tracked"] == true && r.body["title"] == "给 orders 加索引", r)

	// a run that ends with something to accept is tracked even if the agent forgot to claim it
	d := e.post(e.zw.session, "@acha 写个周报", "")
	id3 := tasksOf(d)["id"].(string)
	e.do("POST", "/api/v1/tasks/"+id3+"/claim", e.token, nil)
	r = e.do("POST", "/api/v1/tasks/"+id3+"/report", e.token, map[string]any{"state": "review", "summary": "周报在 out/ 里"})
	check(t, "review without answer: tracked", r.body["tracked"] == true && r.body["status"] == "in_review", r)

	// the composer's "as task"
	m := e.do("POST", "/api/v1/channels/"+e.cid+"/messages", e.zw.session, map[string]any{"text": "@acha 整理一下慢查询清单", "as_task": true}).body
	check(t, "as task: tracked from the start", tasksOf(m)["tracked"] == true)
	check(t, "as task needs an agent", e.do("POST", "/api/v1/channels/"+e.cid+"/messages", e.zw.session, map[string]any{"text": "整理清单", "as_task": true}).status == 400)
	check(t, "a thread message cannot be a task", e.do("POST", "/api/v1/channels/"+e.cid+"/messages", e.zw.session,
		map[string]any{"text": "@acha 也看下这个", "as_task": true, "thread_id": q["id"]}).status == 400)

	// convert later
	check(t, "a bystander cannot convert", e.do("POST", "/api/v1/tasks/"+id+"/track", e.ll.session, nil).status == 403)
	r = e.do("POST", "/api/v1/tasks/"+id+"/track", e.zw.session, nil)
	check(t, "the asker converts the answer into a task", r.body["tracked"] == true, r)
	r = e.do("GET", "/api/v1/tasks?tracked=1", e.zw.session, nil)
	check(t, "four on the board now", len(r.body["tasks"].([]any)) == 4, r)
}
