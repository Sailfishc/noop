package hub

import (
	"net/http"
	"strings"
)

// Aligning (step 2 of the positioning): for a larger request without acceptance criteria, the agent reads first and
// then stops once to say what "done" will mean. When to align is text in its prompt (src/teamwork.ts), not a switch
// here; what the server holds is the rest:
//
//   - an alignment is a decision of kind align: the task stays needs_decision, so 待你决定, a reply waking the agent
//     and going on in the same session all work as for any decision;
//   - a task aligns at most once (tasks_v1.aligned): a second one is refused, so "ask only once" does not depend on
//     the agent remembering it;
//   - "按这个做" writes the criteria (as the person left them) into the task's acceptance and wakes the agent; a reply
//     in the thread instead goes to the agent as any reply does, and it does not align again.

const maxAlign = 5

// alignReport: what an agent reports with state align.
type alignReport struct {
	Acceptance []string `json:"acceptance"`
	NotDoing   []string `json:"not_doing"`
	Approach   string   `json:"approach"`
	Dirty      bool     `json:"dirty"` // its work directory had changes when it stopped (its machine looked)
}

// alignDecision: the decision an align report becomes, or why it is refused (and the status to refuse it with).
func (h *Hub) alignDecision(t taskView, a *alignReport) (*decisionView, string, int) {
	if t.Aligned {
		return nil, "这个任务已经对齐过一次，不能再对齐：按现有的验收标准继续", 409
	}
	if a == nil {
		return nil, "align 要带 align.acceptance", 400
	}
	d := &decisionView{Kind: "align", Question: "做完意味着", Approach: trimmed(strings.TrimSpace(a.Approach), 300), Dirty: a.Dirty}
	for _, c := range a.Acceptance {
		if c = trimmed(strings.TrimSpace(c), 300); c != "" && len(d.Acceptance) < maxAlign {
			d.Acceptance = append(d.Acceptance, c)
		}
	}
	for _, c := range a.NotDoing {
		if c = trimmed(strings.TrimSpace(c), 300); c != "" && len(d.NotDoing) < 2 {
			d.NotDoing = append(d.NotDoing, c)
		}
	}
	if len(d.Acceptance) == 0 {
		return nil, "align 要带至少一条 acceptance", 400
	}
	return d, "", 0
}

// alignText: the alignment as the agent's message in the thread says it.
func alignText(d decisionView) string {
	var b strings.Builder
	b.WriteString("做完意味着：")
	for i, c := range d.Acceptance {
		b.WriteString("\n" + string(rune('1'+i)) + ". " + c)
	}
	if len(d.NotDoing) > 0 {
		b.WriteString("\n不做：" + strings.Join(d.NotDoing, "；"))
	}
	if d.Approach != "" {
		b.WriteString("\n做法：" + d.Approach)
	}
	b.WriteString("\n\n点「按这个做」，或者回一句话改。")
	return b.String()
}

// alignGo: a person says "按这个做" on an alignment, with the criteria as they left them (nil: as proposed).
func (h *Hub) alignGo(w http.ResponseWriter, q *request, t taskView, edited *string) {
	criteria := strings.Join(t.Decision.Acceptance, "\n")
	if edited != nil {
		var lines []string
		for _, l := range strings.Split(*edited, "\n") {
			if l = strings.TrimSpace(l); l != "" {
				lines = append(lines, l)
			}
		}
		if len(lines) == 0 {
			errJSON(w, 400, "至少留一条标准")
			return
		}
		criteria = strings.Join(lines, "\n")
	}
	t.Decision.Answer, t.Decision.AnsweredBy = "按这个做", q.who.userID
	h.setTask(t.ID, map[string]any{"decision": jsonOrNil(t.Decision), "acceptance": clip(criteria, 4000)})
	m := h.insertMessage(t.ChannelID, &t.ThreadID, member{"user", q.who.userID}, "按这个做。验收标准：\n"+criteria)
	h.onPosted(m, false)
	t, _ = h.task(t.ID)
	h.taskChanged(t.ID)
	writeJSON(w, 200, h.taskOut(q, t))
}
