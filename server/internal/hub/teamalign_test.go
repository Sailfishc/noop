package hub

import (
	"strings"
	"testing"
)

// An alignment stops the task for its creator once; "按这个做" writes the criteria (as edited) and wakes the agent; a
// second alignment is refused; the call counts as align.
func TestAlign(t *testing.T) {
	e := newTaskEnv(t, "channel", false)
	id, _, m := e.claimed("@acha 重写退款对账")
	root := m["id"].(string)
	align := map[string]any{"state": "align", "summary": "看完了代码，先对一下", "run": 1, "align": map[string]any{
		"acceptance": []any{"对账结果和财务导出一致", "跑完不超过 10 分钟", "", "a", "b", "c"}, "not_doing": []any{"不改导出格式"}, "approach": "按天分批", "dirty": true}}
	r := e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, align)
	check(t, "align reported", r.status == 200, r)
	tk := e.task(id)
	d := tk["decision"].(map[string]any)
	check(t, "a decision of kind align, waiting for the creator", tk["state"] == "needs_decision" && tk["needs"] == "decide" && tk["aligned"] == true &&
		d["kind"] == "align" && len(d["acceptance"].([]any)) == 5 && d["dirty"] == true && d["approach"] == "按天分批")
	check(t, "the creator holds it, to align", tk["holder"].(map[string]any)["why"] == "align" && tk["holder"].(map[string]any)["id"] == e.zw.id)
	calls := tk["calls"].([]any)
	last := calls[len(calls)-1].(map[string]any)
	checkv(t, "the call counts as align", last["kind"] == "align" && last["class"] == "align" && last["who"] == e.zw.id, calls)
	check(t, "on 待你处理", len(e.inbox(e.zw.session)) == 1)
	msgs := e.do("GET", "/api/v1/messages/"+root+"/thread", e.zw.session, nil).body["replies"].([]any)
	text := msgs[len(msgs)-1].(map[string]any)["text"].(string)
	checkv(t, "the thread says the criteria", strings.Contains(text, "1. 对账结果和财务导出一致") && strings.Contains(text, "不做：不改导出格式"), text)

	check(t, "someone else can't say go", e.do("POST", "/api/v1/tasks/"+id+"/decide", e.ll.session, map[string]any{"acceptance": "x"}).status == 403)
	check(t, "not with no criteria left", e.do("POST", "/api/v1/tasks/"+id+"/decide", e.zw.session, map[string]any{"acceptance": " \n "}).status == 400)
	r = e.do("POST", "/api/v1/tasks/"+id+"/decide", e.zw.session, map[string]any{"acceptance": "对账结果和财务导出一致\n跑完不超过 5 分钟\n"})
	check(t, "按这个做", r.status == 200, r)
	tk = e.task(id)
	checkv(t, "the criteria as edited are the task's; the agent is woken", tk["acceptance"] == "对账结果和财务导出一致\n跑完不超过 5 分钟" && tk["state"] == "queued", tk["acceptance"])

	e.do("POST", "/api/v1/tasks/"+id+"/claim", e.token, nil)
	align["run"] = e.task(id)["runs"]
	r = e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, align)
	check(t, "a second alignment is refused", r.status == 409, r)
	check(t, "and the task goes on", e.task(id)["state"] == "running")
	r = e.do("POST", "/api/v1/tasks/"+id+"/report", e.token, map[string]any{"state": "review", "summary": "好了", "run": align["run"]})
	check(t, "it delivers", r.status == 200 && e.task(id)["state"] == "review", r)

	// a reply instead of the button: the agent hears it, and it may not align again
	id2, _, m2 := e.claimed("@acha 整理发布流程")
	e.do("POST", "/api/v1/tasks/"+id2+"/report", e.token, map[string]any{"state": "align", "summary": "先对一下", "run": 1, "align": map[string]any{"acceptance": []any{"写成一页文档"}}})
	e.post(e.zw.session, "再加一条：要有回滚步骤", m2["id"].(string))
	tk = e.task(id2)
	check(t, "a reply wakes the agent", tk["state"] == "queued" && tk["aligned"] == true)
	id3, _, _ := e.claimed("@acha 看看日志")
	r = e.do("POST", "/api/v1/tasks/"+id3+"/report", e.token, map[string]any{"state": "align", "run": 1, "align": map[string]any{"acceptance": []any{" "}}})
	check(t, "align without criteria is refused", r.status == 400, r)
}
