package hub

import (
	"net/http"
	"regexp"
	"sort"
	"strings"
)

// Repositories. An agent is not tied to a repository: the repository follows the task. A repository is named by its
// remote, "host/owner/name" (github.com/acme/pay), the same on every machine; each machine reports the remotes of
// the checkouts it has (never their paths), and resolves a task's remote to its own checkout (or clones it).
//
// A task's repository is one named in the message (a URL, or owner/name of a repository a machine reported), or the
// repository of an earlier task in the same thread; otherwise none: it starts in a general work directory, and the
// agent declares a repository when the work turns out to need one (`remi repo`, teamsteer.go). The channel's default
// repository is a hint the agent gets, not a rule.

type repoRef struct {
	Remote string `json:"remote"` // host/owner/name
	Name   string `json:"name"`   // the last part, for display
}

var (
	remoteURLRE  = regexp.MustCompile(`^(?i)[a-z+]+://(?:[^@/]+@)?([^/:]+)(?::\d+)?/(.+)$`)
	remoteSCPRE  = regexp.MustCompile(`^(?:[^@/]+@)?([^:/]+):(.+)$`)
	remoteBareRE = regexp.MustCompile(`^(?i)([a-z0-9.-]+\.[a-z]{2,})/(.+)$`)
	repoPathRE   = regexp.MustCompile(`^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$`)
	// in a message: a web or clone address, or a bare host/owner/name
	repoURLInText = regexp.MustCompile(`(?i)(?:https?://|ssh://|git@)[^\s)>\]"'，。、]+|\b[a-z0-9.-]+\.[a-z]{2,}/[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+`)
	ownerNameRE   = regexp.MustCompile(`(?:^|[\s(（:：])([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)(?:$|[\s)）,，。.!?])`)
)

// normRemote: a clone address, web address or host/owner/name → "host/owner/name" ("" when it is none of these).
// Web addresses lose their /-/tree/…, /pull/… and similar tails.
func normRemote(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimSuffix(strings.TrimSuffix(s, "/"), ".git")
	var host, path string
	if m := remoteURLRE.FindStringSubmatch(s); m != nil {
		host, path = m[1], m[2]
	} else if m := remoteBareRE.FindStringSubmatch(s); m != nil {
		host, path = m[1], m[2]
	} else if m := remoteSCPRE.FindStringSubmatch(s); m != nil && strings.Contains(m[1], ".") {
		host, path = m[1], m[2]
	} else {
		return ""
	}
	host = strings.ToLower(host)
	path = strings.TrimSuffix(strings.Trim(path, "/"), ".git")
	if i := strings.Index(path, "/-/"); i >= 0 { // GitLab web pages
		path = path[:i]
	}
	parts := strings.Split(path, "/")
	if host == "github.com" && len(parts) > 2 { // github.com/owner/name/pull/3, /tree/main/…
		parts = parts[:2]
	}
	path = strings.TrimSuffix(strings.Join(parts, "/"), ".git")
	if !strings.Contains(host, ".") || !repoPathRE.MatchString(path) || len(host)+len(path) > 200 {
		return ""
	}
	return host + "/" + path
}

func repoName(remote string) string { return remote[strings.LastIndexByte(remote, '/')+1:] }

// knownRepos: every repository some machine reported, with the machines that have it.
func (h *Hub) knownRepos() map[string][]machineView {
	out := map[string][]machineView{}
	for _, m := range h.scanMachines(h.db.Query("SELECT " + machineCols + " FROM machines ORDER BY created")) {
		for _, r := range m.Repos {
			out[r.Remote] = append(out[r.Remote], m)
		}
	}
	return out
}

// repoInText: the repository a message names, if any.
func (h *Hub) repoInText(text string) string {
	for _, u := range repoURLInText.FindAllString(text, 5) {
		if r := normRemote(strings.TrimRight(u, ".,;:!?")); r != "" {
			return r
		}
	}
	// owner/name of a repository a machine has (one match only: "a/b" is often just a path)
	known := h.knownRepos()
	found := ""
	for _, m := range ownerNameRE.FindAllStringSubmatch(text, 10) {
		want := strings.ToLower(m[1])
		for r := range known {
			if strings.HasSuffix(strings.ToLower(r), "/"+want) {
				if found != "" && found != r {
					return ""
				}
				found = r
			}
		}
	}
	return found
}

// taskRepo: where a new task runs (see the top of this file).
func (h *Hub) taskRepo(text, root string) string {
	if r := h.repoInText(text); r != "" {
		return r
	}
	var r string
	_ = h.db.QueryRow("SELECT repo FROM tasks_v1 WHERE thread_id = ? AND repo != '' ORDER BY num DESC LIMIT 1", root).Scan(&r)
	return r
}

type repoView struct {
	Remote   string   `json:"remote"`
	Name     string   `json:"name"`
	Machines []string `json:"machines"` // ids of the machines that have it
}

// v1Repos: the repositories the team's machines have, for picking a channel's default.
func (h *Hub) v1Repos(w http.ResponseWriter, q *request) {
	out := []repoView{}
	for r, ms := range h.knownRepos() {
		v := repoView{Remote: r, Name: repoName(r), Machines: []string{}}
		for _, m := range ms {
			v.Machines = append(v.Machines, m.ID)
		}
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Remote < out[j].Remote })
	writeJSON(w, 200, obj{"repos": out})
}
