package hub

import (
	"path"
	"regexp"
	"strings"
)

// Evidence (step 2 of the positioning): when an agent delivers, it says for each acceptance criterion how it checked
// it: it ran something and saw the result, it looked (a page, a file), or it could not verify it (and how a person
// can). The server never runs anything again; it only keeps the record honest: a criterion the agent said nothing
// about gets an entry "unstated", instead of the delivery being refused (refusing would only make the agent run once
// more to fill in words, and what people want is to see where nothing was checked).

const evidenceProof = 2000

// evidenceView: how one criterion (Criterion, from 1) was verified: ran | saw | not_verified, or unstated (the
// agent said nothing); Proof: the command and the last lines of its output, what it looked at, or why not and how to
// check by hand; File: a file under out/ (a screenshot) that backs it, uploaded with the task's outputs.
type evidenceView struct {
	Criterion int    `json:"criterion"`
	How       string `json:"how"`
	Proof     string `json:"proof,omitempty"`
	File      string `json:"file,omitempty"`
}

var bulletRE = regexp.MustCompile(`^\s*(?:[-*•]|\d+[.)、]|[（(]?\d+[）)])\s*`)

// criteriaOf: a task's acceptance criteria, one per non-empty line.
func criteriaOf(acceptance string) []string {
	var out []string
	for _, l := range strings.Split(acceptance, "\n") {
		if l = strings.TrimSpace(bulletRE.ReplaceAllString(l, "")); l != "" {
			out = append(out, l)
		}
	}
	return out
}

// fillEvidence: one entry per criterion, in order: what the agent reported (its last word on each), "unstated" where
// it said nothing. Entries for criteria the task doesn't have are dropped; a task without criteria keeps none.
func fillEvidence(acceptance string, got []evidenceView) []evidenceView {
	n := len(criteriaOf(acceptance))
	out := make([]evidenceView, n)
	for i := range out {
		out[i] = evidenceView{Criterion: i + 1, How: "unstated"}
	}
	for _, e := range got {
		if e.Criterion < 1 || e.Criterion > n {
			continue
		}
		how := e.How
		if how != "ran" && how != "saw" {
			how = "not_verified"
		}
		file := ""
		if f := strings.TrimSpace(e.File); f != "" {
			file = trimmed(path.Clean(strings.TrimPrefix(strings.TrimPrefix(f, "./"), "out/")), 300)
		}
		out[e.Criterion-1] = evidenceView{Criterion: e.Criterion, How: how, Proof: clip(strings.TrimSpace(e.Proof), evidenceProof), File: file}
	}
	return out
}
