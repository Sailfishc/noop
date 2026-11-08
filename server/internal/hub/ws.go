package hub

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Sockets. Owner clients (/api/stream) get every new event; ?v=2 clients also get {"$status": …} frames.
// The primary daemon keeps one socket (/api/host/stream) and gets {"type":"inbox"} nudges and watcher counts.
// "ping" is answered with "pong" on both, as the Worker's auto-response did.

type sock struct {
	out  chan []byte
	tags []string
}

type sockets struct {
	mu    sync.Mutex
	byTag map[string]map[*sock]struct{}
}

func (s *sockets) add(k *sock) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, t := range k.tags {
		if s.byTag[t] == nil {
			s.byTag[t] = map[*sock]struct{}{}
		}
		s.byTag[t][k] = struct{}{}
	}
}

func (s *sockets) remove(k *sock) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, t := range k.tags {
		delete(s.byTag[t], k)
	}
}

func (s *sockets) count(tag string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.byTag[tag])
}

// send never blocks: a client too slow to keep up loses frames (it re-reads the feed on reconnect).
func (s *sockets) send(tag string, msg []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k := range s.byTag[tag] {
		select {
		case k.out <- msg:
		default:
		}
	}
}

func (h *Hub) ownerStream(w http.ResponseWriter, r *http.Request) {
	var who *principal
	h.locked(func() { who = h.who(r) })
	if who == nil {
		errJSON(w, 401, "unauthorized")
		return
	}
	tags := []string{"owner"}
	if r.URL.Query().Get("v") == "2" {
		tags = append(tags, "v2")
	}
	h.serveSocket(w, r, tags, func() { h.locked(h.tellWatchers) }, func() { h.locked(h.tellWatchers) })
}

func (h *Hub) hostStream(w http.ResponseWriter, r *http.Request) {
	var who *principal
	h.locked(func() { who = h.who(r) })
	if who == nil {
		errJSON(w, 401, "unauthorized")
		return
	}
	if !who.machine {
		errJSON(w, 403, "forbidden")
		return
	}
	h.serveSocket(w, r, []string{"host"}, func() { h.locked(func() { h.touchHost(); h.pushStatus(); h.tellWatchers() }) }, func() { h.locked(func() { h.touchHost(); h.pushStatus() }) })
}

func (h *Hub) serveSocket(w http.ResponseWriter, r *http.Request, tags []string, opened, closed func()) {
	if r.Header.Get("upgrade") != "websocket" {
		errJSON(w, 426, "websocket expected")
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true}) // auth is the token, not the origin
	if err != nil {
		return
	}
	c.SetReadLimit(64 << 10)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	k := &sock{out: make(chan []byte, 256), tags: tags}
	h.socks.add(k)
	opened()
	defer func() {
		h.socks.remove(k)
		c.Close(websocket.StatusNormalClosure, "")
		defer func() { // the connection is hijacked: nothing can be written back, so only log
			if v := recover(); v != nil {
				h.cfg.Logf("socket close: %v", v)
			}
		}()
		closed()
	}()
	go func() { // reader: answer pings, notice the close
		defer cancel()
		for {
			typ, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			if typ == websocket.MessageText && string(data) == "ping" {
				select {
				case k.out <- []byte("pong"):
				default:
				}
			}
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-k.out:
			wctx, wcancel := context.WithTimeout(ctx, 10*time.Second)
			err := c.Write(wctx, websocket.MessageText, msg)
			wcancel()
			if err != nil {
				return
			}
		}
	}
}
