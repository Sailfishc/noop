package hub

import (
	"errors"
	"io"
	"net/http"
	"strings"
)

// /api/v1: TeamAgent's own API. Several people, each with their own machines and agents, in channels with threads.
// The legacy noop routes (/api/files, /api/host/…) keep serving the daemons' data sync.

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
		m.HandleFunc(pattern, h.v1Handler(a, f))
	}

	r("POST /api/v1/login", public, h.v1Login)
	r("GET /api/v1/invites/{code}", public, h.v1InviteInfo)
	r("POST /api/v1/invites/{code}/accept", public, h.v1InviteAccept)
	r("POST /api/v1/logout", person, h.v1Logout)
	r("GET /api/v1/me", anyone, h.v1Me)

	r("POST /api/v1/invites", person, h.v1InviteCreate)
	r("GET /api/v1/users", anyone, h.v1Users)
	r("PATCH /api/v1/users/{id}", person, h.v1UserPatch)

	r("GET /api/v1/machines", anyone, h.v1Machines)
	r("POST /api/v1/machines", person, h.v1MachineCreate)
	r("DELETE /api/v1/machines/{id}", person, h.v1MachineDelete)
	r("PUT /api/v1/machine", machine, h.v1MachineReport)

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
	r("POST /api/v1/tasks/{id}/confirm", person, h.v1TaskConfirm)
	r("POST /api/v1/tasks/{id}/decline", person, h.v1TaskDecline)
	r("POST /api/v1/tasks/{id}/cancel", person, h.v1TaskCancel)
	r("POST /api/v1/tasks/{id}/accept", person, h.v1TaskAccept)
	r("POST /api/v1/tasks/{id}/decide", person, h.v1TaskDecide)
	r("GET /api/v1/machine/tasks", machine, h.v1MachineTasks)
	r("POST /api/v1/tasks/{id}/claim", machine, h.v1TaskClaim)
	r("POST /api/v1/tasks/{id}/report", machine, h.v1TaskReport)
	r("POST /api/v1/hooks/gitlab", public, h.v1GitlabHook)

	m.HandleFunc("GET /api/v1/stream", h.v1Stream)
	m.HandleFunc("/api/v1/", func(w http.ResponseWriter, r *http.Request) { errJSON(w, 404, "not found") })
	return m
}

// v1Handler reads the body (without the lock), checks the credential, then runs f with h.mu held.
func (h *Hub) v1Handler(a access, f func(http.ResponseWriter, *request)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, ok := readBody(w, r, defaultLimit)
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
