package hub

import (
	"errors"
	"io"
	"net/http"
	"strings"
)

// /api/v1: Remi's API. Several people, each with their own machines and agents, in channels with threads.

type access int

const (
	public  access = iota // no credential
	person                // a person's session
	machine               // a per-machine token
	anyone                // a person or a per-machine token
)

func (h *Hub) v1Routes() *http.ServeMux {
	m := http.NewServeMux()
	r := func(pattern string, a access, f func(http.ResponseWriter, *request)) {
		m.HandleFunc(pattern, h.v1Handler(a, f, defaultLimit))
	}

	r("POST /api/v1/login", public, h.v1Login)
	r("GET /api/v1/invites/{code}", public, h.v1InviteInfo)
	r("POST /api/v1/invites/{code}/accept", public, h.v1InviteAccept)
	r("GET /api/v1/workspace", public, h.v1Workspace)
	r("PATCH /api/v1/workspace", person, h.v1WorkspacePatch)
	r("POST /api/v1/signup", public, h.v1SignupCreate)
	r("GET /api/v1/signup/{token}", public, h.v1SignupStatus)
	r("POST /api/v1/signup/{token}/session", public, h.v1SignupSession)
	r("GET /api/v1/signups", person, h.v1Signups)
	r("POST /api/v1/signups/{id}/approve", person, h.v1SignupDecide(true))
	r("POST /api/v1/signups/{id}/reject", person, h.v1SignupDecide(false))
	r("POST /api/v1/logout", person, h.v1Logout)
	r("GET /api/v1/me", anyone, h.v1Me)

	r("POST /api/v1/invites", person, h.v1InviteCreate)
	r("POST /api/v1/login-codes", person, h.v1LoginCodeCreate)
	r("GET /api/v1/sessions", person, h.v1Sessions)
	r("DELETE /api/v1/sessions/{id}", person, h.v1SessionDelete)
	r("GET /api/v1/git", person, h.v1Git)
	r("PUT /api/v1/git/platforms", person, h.v1GitPlatforms)
	r("GET /api/v1/users", anyone, h.v1Users)
	r("PATCH /api/v1/users/{id}", person, h.v1UserPatch)

	r("GET /api/v1/machines", anyone, h.v1Machines)
	r("POST /api/v1/machines", person, h.v1MachineCreate)
	r("DELETE /api/v1/machines/{id}", person, h.v1MachineDelete)
	r("POST /api/v1/machines/enroll", person, h.v1MachineEnroll)
	r("PATCH /api/v1/machines/{id}", person, h.v1MachinePatch)
	r("POST /api/v1/machines/{id}/join", person, h.v1MachineJoinCode)
	r("POST /api/v1/machines/join", public, h.v1MachineJoin)
	m.HandleFunc("GET /api/v1/install.sh", h.v1InstallScript)
	r("PUT /api/v1/machine", machine, h.v1MachineReport)

	r("GET /api/v1/repos", anyone, h.v1Repos)
	r("GET /api/v1/search", person, h.v1Search)
	r("GET /api/v1/agents", anyone, h.v1Agents)
	r("POST /api/v1/agents", person, h.v1AgentCreate)
	r("PATCH /api/v1/agents/{id}", person, h.v1AgentPatch)
	r("DELETE /api/v1/agents/{id}", person, h.v1AgentDelete)

	r("GET /api/v1/channels", anyone, h.v1Channels)
	r("POST /api/v1/channels", person, h.v1ChannelCreate)
	r("GET /api/v1/channels/{id}", anyone, h.v1Channel)
	r("PATCH /api/v1/channels/{id}", person, h.v1ChannelPatch)
	r("POST /api/v1/channels/{id}/members", person, h.v1MemberAdd)
	r("DELETE /api/v1/channels/{id}/members/{kind}/{member}", person, h.v1MemberRemove)
	r("GET /api/v1/channels/{id}/messages", anyone, h.v1Messages)
	r("POST /api/v1/channels/{id}/messages", anyone, h.v1Post)
	r("GET /api/v1/messages/{id}/thread", anyone, h.v1Thread)
	r("PATCH /api/v1/messages/{id}", anyone, h.v1Edit)
	r("GET /api/v1/updates", anyone, h.v1Updates)

	r("GET /api/v1/tasks", anyone, h.v1Tasks)
	r("GET /api/v1/tasks/{id}", anyone, h.v1Task)
	r("GET /api/v1/inbox", person, h.v1Inbox)
	r("GET /api/v1/metrics", person, h.v1Metrics)
	r("GET /api/v1/reminders", person, h.v1Reminders)
	r("POST /api/v1/reminders", person, h.v1ReminderCreate)
	r("DELETE /api/v1/reminders/{id}", person, h.v1ReminderDelete)
	r("POST /api/v1/reminders/{id}/seen", person, h.v1ReminderSeen)
	r("PATCH /api/v1/tasks/{id}", person, h.v1TaskPatch)
	r("POST /api/v1/tasks/{id}/confirm", person, h.v1TaskConfirm)
	r("POST /api/v1/tasks/{id}/decline", person, h.v1TaskDecline)
	r("POST /api/v1/tasks/{id}/cancel", person, h.v1TaskCancel)
	r("POST /api/v1/tasks/{id}/retry", person, h.v1TaskRetryNow)
	r("POST /api/v1/tasks/{id}/accept", person, h.v1TaskAccept)
	r("POST /api/v1/tasks/{id}/reopen", person, h.v1TaskReopen)
	r("POST /api/v1/tasks/{id}/track", person, h.v1TaskTrack)
	r("POST /api/v1/tasks/{id}/takeover", person, h.v1TaskTakeover)
	r("GET /api/v1/team/config", person, h.v1TeamConfig)
	r("PUT /api/v1/team/config", person, h.v1TeamConfigPut)
	// an agent's own look-ups while it runs (the teamagent command; the run's read token)
	r("GET /api/v1/agent/read", public, h.v1AgentRead)
	r("GET /api/v1/agent/search", public, h.v1AgentSearch)
	r("GET /api/v1/agent/tasks", public, h.v1AgentTasks)
	r("GET /api/v1/agent/tasks/{id}", public, h.v1AgentTask)
	r("GET /api/v1/agent/channel", public, h.v1AgentChannel)
	r("GET /api/v1/agent/who", public, h.v1AgentWho)
	r("GET /api/v1/agent/file", public, h.v1AgentFile)
	r("GET /api/v1/agent/memory", public, h.v1AgentMemory)
	r("POST /api/v1/agent/say", public, h.v1AgentSay)
	r("POST /api/v1/agent/remind", public, h.v1AgentRemind)
	r("POST /api/v1/agent/ask", public, h.v1AgentAsk)
	r("POST /api/v1/agent/repo", public, h.v1AgentRepo)
	r("POST /api/v1/agent/handoff", public, h.v1AgentHandoff)
	r("POST /api/v1/agent/delegate", public, h.v1AgentDelegate)
	r("POST /api/v1/agent/submit", public, h.v1AgentSubmit)
	r("POST /api/v1/tasks/{id}/handoff", person, h.v1TaskHandoff)
	r("GET /api/v1/triggers", person, h.v1Triggers)
	r("POST /api/v1/triggers", person, h.v1TriggerCreate)
	r("POST /api/v1/triggers/{id}/confirm", person, h.v1TriggerConfirm)
	r("PATCH /api/v1/triggers/{id}", person, h.v1TriggerPatch)
	r("DELETE /api/v1/triggers/{id}", person, h.v1TriggerDelete)
	r("POST /api/v1/hooks/github", public, h.v1GithubHook)
	r("POST /api/v1/tasks/{id}/decide", person, h.v1TaskDecide)
	r("GET /api/v1/machine/tasks", machine, h.v1MachineTasks)
	r("POST /api/v1/tasks/{id}/claim", machine, h.v1TaskClaim)
	r("POST /api/v1/tasks/{id}/report", machine, h.v1TaskReport)
	r("POST /api/v1/hooks/gitlab", public, h.v1GitlabHook)
	r("POST /api/v1/tasks/{id}/checkpoint", machine, h.v1Checkpoint)
	m.HandleFunc("POST /api/v1/tasks/{id}/checkpoint/files", h.v1Handler(machine, h.v1CheckpointFiles, maxCheckpointFiles+1))
	r("POST /api/v1/asks/{id}/claim", machine, h.v1AskClaim)
	r("POST /api/v1/asks/{id}/answer", machine, h.v1AskAnswer)
	m.HandleFunc("POST /api/v1/tasks/{id}/outputs/file", h.v1Handler(machine, h.v1OutputUpload, maxOutputFile+1))
	m.HandleFunc("POST /api/v1/agent/upload", h.v1Handler(public, h.v1AgentUpload, maxOutputFile+1))
	m.HandleFunc("POST /api/v1/tasks/{id}/outputs/preview", h.v1Handler(machine, h.v1OutputPreview, maxUpload+1))
	r("GET /api/v1/outputs/{id}/link", person, h.v1OutputLink)
	r("POST /api/v1/hooks/wait/{token}", public, h.v1WaitHook)
	r("POST /api/v1/tasks/{id}/wait", machine, h.v1WaitCheck)
	r("GET /api/v1/outputs/{id}/content", public, h.v1OutputContent)
	m.HandleFunc("POST /api/v1/uploads", h.v1Handler(person, h.v1Upload, maxAttachment+1))
	r("GET /api/v1/messages/{id}/attachments", person, h.v1MessageAttachments)
	r("GET /api/v1/media/{id}", anyone, h.v1Media)
	r("GET /api/v1/media/{id}/signed", public, h.v1MediaSigned)

	m.HandleFunc("GET /api/v1/stream", h.v1Stream)
	m.HandleFunc("/api/v1/", func(w http.ResponseWriter, r *http.Request) { errJSON(w, 404, "not found") })
	return m
}

// v1Handler reads the body (without the lock), checks the credential, then runs f with h.mu held.
func (h *Hub) v1Handler(a access, f func(http.ResponseWriter, *request), limit int64) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, ok := readBody(w, r, limit)
		if !ok {
			return
		}
		q := &request{r: r, body: body}
		h.mu.Lock()
		defer h.mu.Unlock()
		if a != public {
			q.who = h.who(r)
			switch {
			case q.who == nil || (q.who.userID == "" && a != public):
				errJSON(w, 401, "unauthorized")
				return
			case a == person && q.who.machine, a == machine && !q.who.machine:
				errJSON(w, 403, "forbidden")
				return
			}
		}
		f(w, q)
	}
}

func readBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			errJSON(w, 413, "request too large")
		} else {
			errJSON(w, 400, "could not read body")
		}
		return nil, false
	}
	return body, true
}

func trimmed(s string, n int) string { return truncRunes(strings.TrimSpace(s), n) }
