package hub

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Channels, threads and messages. A public channel is visible to everyone in the workspace (≤ 10 people); posting
// needs membership. A private channel (and everything in it: messages, threads, tasks, outputs, triggers, search hits,
// live frames) is visible to its members only, admins included: canRead is the one rule, and every way out goes
// through it (teamprivate_test.go knocks on each as an outsider). A message with thread_id is a reply in that top-level message's thread. Agents post through
// their machine's token.

type member struct {
	Kind string `json:"kind"` // "user" | "agent"
	ID   string `json:"id"`
}

type channelView struct {
	ID    string `json:"id"`
	Slug  string `json:"slug"`
	Name  string `json:"name"`
	Topic string `json:"topic"`
	Repo  string `json:"repo"` // its usual repository, a hint for agents: host/owner/name, "" = none
	// Conventions: how this channel works ("PR 标题用中文", "发布前在 #ops 说一声"): every agent working here reads
	// them; the channel's members edit them.
	Conventions string `json:"conventions"`
	// Private: only its members see it, or that it exists; only its creator (CreatedBy) may make it public
	Private   bool   `json:"private"`
	CreatedBy string `json:"created_by"`
	// DMAgent: a private chat between its creator and this agent (teamdm.go); its name is the agent's handle
	DMAgent  string   `json:"dm_agent,omitempty"`
	Archived bool     `json:"archived"`
	Created  int64    `json:"created"`
	Members  []member `json:"members"`
	LastSeq  int64    `json:"last_seq"`
}

func (h *Hub) channel(id string) (channelView, bool) {
	var c channelView
	err := h.db.QueryRow("SELECT id, slug, name, topic, repo, conventions, private, COALESCE(created_by, ''), COALESCE(dm_agent, ''), archived, created FROM channels WHERE id = ? OR slug = ?", id, id).
		Scan(&c.ID, &c.Slug, &c.Name, &c.Topic, &c.Repo, &c.Conventions, &c.Private, &c.CreatedBy, &c.DMAgent, &c.Archived, &c.Created)
	if err != nil {
		return c, false
	}
	c.Members = h.members(c.ID)
	_ = h.db.QueryRow("SELECT COALESCE(MAX(seq), 0) FROM messages WHERE channel_id = ?", c.ID).Scan(&c.LastSeq)
	return c, true
}

func (h *Hub) members(channelID string) []member {
	rows, err := h.db.Query("SELECT kind, member_id FROM channel_members WHERE channel_id = ? ORDER BY joined", channelID)
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []member{}
	for rows.Next() {
		var m member
		if err := rows.Scan(&m.Kind, &m.ID); err != nil {
			panic(err)
		}
		out = append(out, m)
	}
	return out
}

func (h *Hub) isMember(channelID, kind, id string) bool {
	return h.count("SELECT COUNT(*) FROM channel_members WHERE channel_id = ? AND kind = ? AND member_id = ?", channelID, kind, id) == 1
}

// canRead: a person reads every public channel and the private ones they are in; a machine reads the channels one of
// its agents is in.
func (h *Hub) canRead(w *principal, channelID string) bool {
	if w.machineID == "" {
		return h.userCanRead(w.userID, channelID)
	}
	return h.count(`SELECT COUNT(*) FROM channel_members cm JOIN agent_machines am ON am.agent_id = cm.member_id
		WHERE cm.channel_id = ? AND cm.kind = 'agent' AND am.machine_id = ?`, channelID, w.machineID) > 0
}

// userCanRead: the person sees the channel: it is public, or they are in it.
func (h *Hub) userCanRead(userID, channelID string) bool {
	return h.count(`SELECT COUNT(*) FROM channels c WHERE c.id = ? AND (c.private = 0 OR EXISTS (SELECT 1 FROM channel_members cm
		WHERE cm.channel_id = c.id AND cm.kind = 'user' AND cm.member_id = ?))`, channelID, userID) > 0
}

// isPrivate: the channel is private.
func (h *Hub) isPrivate(channelID string) bool {
	return h.count("SELECT COUNT(*) FROM channels WHERE id = ? AND private = 1", channelID) > 0
}

// memberOrAdmin: in the channel, or an admin (who may act on a public channel without joining it; not on a private one).
func (h *Hub) memberOrAdmin(channelID, userID string) bool {
	return h.isMember(channelID, "user", userID) || (h.isAdmin(userID) && !h.isPrivate(channelID))
}

// readableBy: an SQL condition on col (a channel id): the person sees that channel. With its arguments.
func readableBy(col, userID string) (string, []any) {
	return col + ` IN (SELECT c.id FROM channels c WHERE c.private = 0 OR EXISTS (SELECT 1 FROM channel_members cm
		WHERE cm.channel_id = c.id AND cm.kind = 'user' AND cm.member_id = ?))`, []any{userID}
}

// mayBringAgent: who may put an agent into a private channel: its owner, or anyone when it takes work from the whole
// team (its dispatch scope). Others' agents are left out: what is said there reaches the computer it runs on.
func (h *Hub) mayBringAgent(userID string, a agentView) bool {
	return a.OwnerID == userID || a.Dispatch == "team"
}

// ---------------------------------------------------------------- live updates

// broadcastPeople: to every person's socket (channel list, people, agents changed).
func (h *Hub) broadcastPeople(frame obj) {
	b, _ := json.Marshal(frame)
	h.socks.send("people", b)
}

// broadcastChannel: to the people in the channel and the machines of the agents in it.
func (h *Hub) broadcastChannel(channelID string, frame obj) {
	b, _ := json.Marshal(frame)
	rows, err := h.db.Query(`SELECT 'u:' || member_id FROM channel_members WHERE channel_id = ? AND kind = 'user'
		UNION SELECT 'm:' || am.machine_id FROM channel_members cm JOIN agent_machines am ON am.agent_id = cm.member_id
		WHERE cm.channel_id = ? AND cm.kind = 'agent'`, channelID, channelID)
	if err != nil {
		panic(err)
	}
	var tags []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			panic(err)
		}
		tags = append(tags, t)
	}
	rows.Close()
	for _, t := range tags {
		h.socks.send(t, b)
	}
}

func (h *Hub) channelChanged(id string) {
	if c, ok := h.channel(id); ok {
		if !c.Private { // a private one: its members only (and its agents' machines)
			h.broadcastPeople(obj{"type": "channel", "channel": c})
		}
		h.broadcastChannel(id, obj{"type": "channel", "channel": c}) // machines too (people get it twice; it is idempotent)
	}
}

// channelRemoved tells a person a private channel is gone for them (they left, or were taken out).
func (h *Hub) channelRemoved(channelID, userID string) {
	b, _ := json.Marshal(obj{"type": "channel_removed", "id": channelID})
	h.socks.send("u:"+userID, b)
}

// v1Stream: one socket per client. People get {type: message|message_edited|channel|user|agent|machine, …};
// machines get the messages and channel changes of the channels their agents are in.
func (h *Hub) v1Stream(w http.ResponseWriter, r *http.Request) {
	var who *principal
	h.locked(func() { who = h.who(r) })
	if who == nil || who.userID == "" {
		errJSON(w, 401, "unauthorized")
		return
	}
	if who.machine && who.machineID == "" {
		errJSON(w, 403, "forbidden")
		return
	}
	tags := []string{"people", "u:" + who.userID}
	if who.machine {
		tags = []string{"m:" + who.machineID}
	}
	machineState := func() {
		if who.machine {
			ms := h.scanMachines(h.db.Query("SELECT "+machineCols+" FROM machines WHERE id = ?", who.machineID))
			if len(ms) > 0 {
				h.broadcastPeople(obj{"type": "machine", "machine": ms[0]})
			}
		}
	}
	h.serveSocket(w, r, tags, func() { h.locked(machineState) }, func() {
		h.locked(func() {
			if who.machine {
				h.must(h.db.Exec("UPDATE machines SET last_seen = ? WHERE id = ?", h.nowMs(), who.machineID))
			}
			machineState()
		})
	})
}

// ---------------------------------------------------------------- channels

func (h *Hub) v1Channels(w http.ResponseWriter, q *request) {
	rows, err := h.db.Query("SELECT id FROM channels WHERE archived = 0 OR ? = '1' ORDER BY name", q.query("archived"))
	if err != nil {
		panic(err)
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			panic(err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	out := []channelView{}
	for _, id := range ids {
		if !h.canRead(q.who, id) {
			continue
		}
		c, _ := h.channel(id)
		out = append(out, c)
	}
	writeJSON(w, 200, obj{"channels": out})
}

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

func (h *Hub) v1ChannelCreate(w http.ResponseWriter, q *request) {
	var b struct {
		Slug    string   `json:"slug"`
		Name    string   `json:"name"`
		Topic   string   `json:"topic"`
		Members []member `json:"members"`
		Private bool     `json:"private"`
		// DMAgent: the private chat with this agent, made now or the one there is (teamdm.go)
		DMAgent string `json:"dm_agent"`
	}
	_ = q.json(&b)
	if b.DMAgent != "" {
		h.v1DMOpen(w, q, b.DMAgent)
		return
	}
	name := trimmed(b.Name, 40)
	if name == "" {
		errJSON(w, 400, "name required")
		return
	}
	slug := strings.ToLower(strings.TrimSpace(b.Slug))
	if b.Private {
		// slugs are unique across the team: one made from the name (or chosen) would let others find out by its clash
		for slug = "p-" + randHex(4); h.count("SELECT COUNT(*) FROM channels WHERE slug = ?", slug) > 0; slug = "p-" + randHex(4) {
		}
	} else if slug == "" {
		slug = strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(name), "-"), "-")
		if slug == "" || h.count("SELECT COUNT(*) FROM channels WHERE slug = ?", slug) > 0 {
			slug = "ch-" + randHex(3) // a Chinese name, or taken
		}
	}
	if !channelSlugRE.MatchString(slug) {
		errJSON(w, 400, "slug 只能用小写字母、数字和 -")
		return
	}
	if h.count("SELECT COUNT(*) FROM channels WHERE slug = ?", slug) > 0 {
		errJSON(w, 409, "频道 "+slug+" 已经存在")
		return
	}
	for _, m := range b.Members {
		if !h.memberExists(m) {
			errJSON(w, 400, "没有这个成员："+m.Kind+" "+m.ID)
			return
		}
		if b.Private && m.Kind == "agent" {
			if a, _ := h.agent(m.ID); !h.mayBringAgent(q.who.userID, a) {
				errJSON(w, 403, "@"+a.Handle+" 不接整个团队的活，只有它的主人能把它拉进私有频道")
				return
			}
		}
	}
	id := newID("c_")
	h.must(h.db.Exec("INSERT INTO channels (id, slug, name, topic, private, created_by, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
		id, slug, name, trimmed(b.Topic, 500), boolInt(b.Private), q.who.userID, h.nowMs()))
	h.addMember(id, member{"user", q.who.userID})
	for _, m := range b.Members {
		h.addMember(id, m)
	}
	h.channelChanged(id)
	c, _ := h.channel(id)
	writeJSON(w, 200, c)
}

func (h *Hub) memberExists(m member) bool {
	switch m.Kind {
	case "user":
		return h.count("SELECT COUNT(*) FROM users WHERE id = ? AND disabled = 0", m.ID) == 1
	case "agent":
		return h.count("SELECT COUNT(*) FROM agents WHERE id = ?", m.ID) == 1
	}
	return false
}

func (h *Hub) addMember(channelID string, m member) {
	h.must(h.db.Exec("INSERT OR IGNORE INTO channel_members (channel_id, kind, member_id, joined) VALUES (?, ?, ?, ?)", channelID, m.Kind, m.ID, h.nowMs()))
}

func (h *Hub) v1Channel(w http.ResponseWriter, q *request) {
	c, ok := h.channel(q.r.PathValue("id"))
	if !ok || !h.canRead(q.who, c.ID) {
		errJSON(w, 404, "not found")
		return
	}
	writeJSON(w, 200, c)
}

func (h *Hub) v1ChannelPatch(w http.ResponseWriter, q *request) {
	c, ok := h.channel(q.r.PathValue("id"))
	if !ok || !h.canRead(q.who, c.ID) {
		errJSON(w, 404, "not found")
		return
	}
	if !h.memberOrAdmin(c.ID, q.who.userID) {
		errJSON(w, 403, "先加入这个频道")
		return
	}
	var b struct {
		Name     *string `json:"name"`
		Topic    *string `json:"topic"`
		Repo     *string `json:"repo"`
		Archived *bool   `json:"archived"`
		// Conventions: up to 4000 characters
		Conventions *string `json:"conventions"`
		// Private: false makes a private channel public (its creator only; there is no way back)
		Private *bool `json:"private"`
	}
	_ = q.json(&b)
	if c.DMAgent != "" && (b.Name != nil || b.Private != nil || b.Topic != nil) {
		errJSON(w, 400, "私聊不能改名、改说明或转公开；要多人一起，新建一个私有频道")
		return
	}
	madePublic := false
	if b.Private != nil && *b.Private != c.Private {
		if *b.Private {
			errJSON(w, 400, "公开频道不能转成私有：大家已经看过了。要私下聊，新建一个私有频道")
			return
		}
		if c.CreatedBy != q.who.userID {
			errJSON(w, 403, "只有创建这个频道的人能把它转为公开")
			return
		}
		madePublic = true
	}
	if b.Conventions != nil {
		if utf8.RuneCountInString(strings.TrimSpace(*b.Conventions)) > maxConventions {
			errJSON(w, 400, "频道约定最多 4000 字")
			return
		}
		h.must(h.db.Exec("UPDATE channels SET conventions = ? WHERE id = ?", strings.TrimSpace(*b.Conventions), c.ID))
	}
	if b.Repo != nil {
		r := normRemote(*b.Repo)
		if r == "" && strings.TrimSpace(*b.Repo) != "" {
			errJSON(w, 400, "仓库要写成地址，比如 https://github.com/owner/name")
			return
		}
		h.must(h.db.Exec("UPDATE channels SET repo = ? WHERE id = ?", r, c.ID))
	}
	if b.Name != nil {
		if n := trimmed(*b.Name, 40); n != "" {
			h.must(h.db.Exec("UPDATE channels SET name = ? WHERE id = ?", n, c.ID))
		}
	}
	if b.Topic != nil {
		h.must(h.db.Exec("UPDATE channels SET topic = ? WHERE id = ?", trimmed(*b.Topic, 500), c.ID))
	}
	if b.Archived != nil {
		h.must(h.db.Exec("UPDATE channels SET archived = ? WHERE id = ?", *b.Archived, c.ID))
	}
	if madePublic { // its history, tasks and members stay; everyone hears of it as of a new channel (channelChanged)
		h.must(h.db.Exec("UPDATE channels SET private = 0 WHERE id = ?", c.ID))
	}
	h.channelChanged(c.ID)
	c, _ = h.channel(c.ID)
	writeJSON(w, 200, c)
}

// v1MemberAdd: a person joins, or a member adds another person or any agent. A private channel: no joining, its members
// bring people in, and agents only as mayBringAgent says.
func (h *Hub) v1MemberAdd(w http.ResponseWriter, q *request) {
	c, ok := h.channel(q.r.PathValue("id"))
	if !ok || !h.canRead(q.who, c.ID) {
		errJSON(w, 404, "not found")
		return
	}
	if c.DMAgent != "" {
		errJSON(w, 403, "私聊只有你和这个 Agent；要多人一起，新建一个私有频道")
		return
	}
	var m member
	_ = q.json(&m)
	if m.Kind == "" {
		m = member{"user", q.who.userID} // join
	}
	self := m.Kind == "user" && m.ID == q.who.userID
	if !self && !h.isMember(c.ID, "user", q.who.userID) {
		errJSON(w, 403, "先加入这个频道")
		return
	}
	if !h.memberExists(m) {
		errJSON(w, 400, "没有这个成员")
		return
	}
	if c.Private && m.Kind == "agent" {
		if a, _ := h.agent(m.ID); !h.mayBringAgent(q.who.userID, a) {
			errJSON(w, 403, "@"+a.Handle+" 不接整个团队的活，只有它的主人能把它拉进私有频道")
			return
		}
	}
	h.addMember(c.ID, m)
	h.channelChanged(c.ID)
	c, _ = h.channel(c.ID)
	writeJSON(w, 200, c)
}

// v1MemberRemove: anyone leaves; a member removes an agent; an admin removes anyone (from a private channel only when
// in it). A private channel its last person leaves is archived.
func (h *Hub) v1MemberRemove(w http.ResponseWriter, q *request) {
	c, ok := h.channel(q.r.PathValue("id"))
	if !ok || !h.canRead(q.who, c.ID) {
		errJSON(w, 404, "not found")
		return
	}
	if c.DMAgent != "" {
		errJSON(w, 403, "私聊的成员是固定的")
		return
	}
	m := member{q.r.PathValue("kind"), q.r.PathValue("member")}
	self := m.Kind == "user" && m.ID == q.who.userID
	inIt := h.isMember(c.ID, "user", q.who.userID)
	allowed := self || (m.Kind == "agent" && inIt) || (h.isAdmin(q.who.userID) && (inIt || !c.Private))
	if !allowed {
		errJSON(w, 403, "forbidden")
		return
	}
	h.channelChanged(c.ID) // before: the removed member hears it too
	h.must(h.db.Exec("DELETE FROM channel_members WHERE channel_id = ? AND kind = ? AND member_id = ?", c.ID, m.Kind, m.ID))
	if c.Private {
		if m.Kind == "user" {
			h.channelRemoved(c.ID, m.ID)
		}
		if h.count("SELECT COUNT(*) FROM channel_members WHERE channel_id = ? AND kind = 'user'", c.ID) == 0 {
			h.must(h.db.Exec("UPDATE channels SET archived = 1 WHERE id = ?", c.ID)) // nobody left who could see it
		}
	}
	h.channelChanged(c.ID)
	c, _ = h.channel(c.ID)
	writeJSON(w, 200, c)
}

// ---------------------------------------------------------------- messages

type mention struct {
	Kind   string `json:"kind"`
	ID     string `json:"id"`
	Handle string `json:"handle"`
}

type messageView struct {
	ID          string    `json:"id"`
	Seq         int64     `json:"seq"`
	ChannelID   string    `json:"channel_id"`
	ThreadID    *string   `json:"thread_id"`
	Author      member    `json:"author"`
	Text        string    `json:"text"`
	Mentions    []mention `json:"mentions"`
	Attachments []string  `json:"attachments"`
	ClientID    *string   `json:"client_id,omitempty"`
	Created     int64     `json:"created"`
	Edited      *int64    `json:"edited"`
	ReplyCount  int64     `json:"reply_count"`
	LastReplyAt *int64    `json:"last_reply_at"`
	// Reactions: who put which emoji on it, oldest first (an agent's 👀: it took the message up)
	Reactions []reaction `json:"reactions"`
}

type reaction struct {
	Emoji  string `json:"emoji"`
	Author member `json:"author"`
}

const messageCols = `m.id, m.seq, m.channel_id, m.thread_id, m.author_kind, m.author_id, m.text, COALESCE(m.mentions, '[]'),
	COALESCE(m.attachments, '[]'), m.client_id, m.created, m.edited,
	(SELECT COUNT(*) FROM messages r WHERE r.thread_id = m.id), (SELECT MAX(created) FROM messages r WHERE r.thread_id = m.id),
	(SELECT json_group_array(json_object('emoji', x.emoji, 'author', json_object('kind', x.author_kind, 'id', x.author_id)))
	  FROM (SELECT * FROM reactions WHERE message_id = m.id ORDER BY created) x)`

func scanMessages(rows *sql.Rows, err error) []messageView {
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []messageView{}
	for rows.Next() {
		var m messageView
		var mentions, att, reactions string
		if err := rows.Scan(&m.ID, &m.Seq, &m.ChannelID, &m.ThreadID, &m.Author.Kind, &m.Author.ID, &m.Text, &mentions, &att,
			&m.ClientID, &m.Created, &m.Edited, &m.ReplyCount, &m.LastReplyAt, &reactions); err != nil {
			panic(err)
		}
		_ = json.Unmarshal([]byte(reactions), &m.Reactions)
		if m.Reactions == nil {
			m.Reactions = []reaction{}
		}
		_ = json.Unmarshal([]byte(mentions), &m.Mentions)
		_ = json.Unmarshal([]byte(att), &m.Attachments)
		if m.Mentions == nil {
			m.Mentions = []mention{}
		}
		if m.Attachments == nil {
			m.Attachments = []string{}
		}
		out = append(out, m)
	}
	return out
}

// react puts an emoji on a message (once per author) and sends the message out again.
func (h *Hub) react(messageID string, author member, emoji string) {
	res, err := h.db.Exec("INSERT OR IGNORE INTO reactions (message_id, author_kind, author_id, emoji, created) VALUES (?, ?, ?, ?, ?)",
		messageID, author.Kind, author.ID, emoji, h.nowMs())
	if err != nil {
		panic(err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return
	}
	if m, ok := h.message(messageID); ok {
		h.broadcastChannel(m.ChannelID, obj{"type": "message_edited", "message": m})
	}
}

func (h *Hub) message(id string) (messageView, bool) {
	ms := scanMessages(h.db.Query("SELECT "+messageCols+" FROM messages m WHERE m.id = ?", id))
	if len(ms) == 0 {
		return messageView{}, false
	}
	return ms[0], true
}

var channelSlugRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,47}$`)

var mentionRE = regexp.MustCompile(`(?:^|[^\w@])@([a-z][a-z0-9_-]{1,31})`)

// mentions resolves @handles to the people and agents they name (unknown handles are plain text).
func (h *Hub) mentions(text string) []mention {
	out := []mention{}
	seen := map[string]bool{}
	for _, m := range mentionRE.FindAllStringSubmatch(text, -1) {
		handle := m[1]
		if seen[handle] {
			continue
		}
		seen[handle] = true
		var id string
		if h.db.QueryRow("SELECT id FROM users WHERE handle = ?", handle).Scan(&id) == nil {
			out = append(out, mention{"user", id, handle})
		} else if h.db.QueryRow("SELECT id FROM agents WHERE handle = ?", handle).Scan(&id) == nil {
			out = append(out, mention{"agent", id, handle})
		}
	}
	return out
}

// v1Messages: a channel's top-level messages, oldest first, a page before ?before=<seq> (default: the newest).
func (h *Hub) v1Messages(w http.ResponseWriter, q *request) {
	c, ok := h.channel(q.r.PathValue("id"))
	if !ok || !h.canRead(q.who, c.ID) {
		errJSON(w, 404, "not found")
		return
	}
	before, _ := strconv.ParseInt(q.query("before"), 10, 64)
	if before <= 0 {
		before = 1 << 62
	}
	limit := clampInt(q.query("limit"), 50, 1, 200)
	ms := scanMessages(h.db.Query("SELECT "+messageCols+" FROM messages m WHERE m.channel_id = ? AND m.thread_id IS NULL AND m.seq < ? ORDER BY m.seq DESC LIMIT ?",
		c.ID, before, limit+1))
	more := len(ms) > limit
	if more {
		ms = ms[:limit]
	}
	for i, j := 0, len(ms)-1; i < j; i, j = i+1, j-1 {
		ms[i], ms[j] = ms[j], ms[i]
	}
	writeJSON(w, 200, obj{"messages": ms, "more": more})
}

func (h *Hub) v1Thread(w http.ResponseWriter, q *request) {
	root, ok := h.message(q.r.PathValue("id"))
	if !ok || !h.canRead(q.who, root.ChannelID) {
		errJSON(w, 404, "not found")
		return
	}
	if root.ThreadID != nil { // a reply: show its whole thread
		root, _ = h.message(*root.ThreadID)
	}
	replies := scanMessages(h.db.Query("SELECT "+messageCols+" FROM messages m WHERE m.thread_id = ? ORDER BY m.seq", root.ID))
	writeJSON(w, 200, obj{"root": root, "replies": replies})
}

// v1Post: a person posts as themselves; a machine posts as one of its agents ({as_agent}). Both must be in the channel.
func (h *Hub) v1Post(w http.ResponseWriter, q *request) {
	c, ok := h.channel(q.r.PathValue("id"))
	if !ok || !h.canRead(q.who, c.ID) {
		errJSON(w, 404, "not found")
		return
	}
	var b struct {
		Text        string          `json:"text"`
		ThreadID    string          `json:"thread_id"`
		AsTask      bool            `json:"as_task"` // the composer's "as task": track it as a task from the start
		ClientID    string          `json:"client_id"`
		Attachments json.RawMessage `json:"attachments"`
		AsAgent     string          `json:"as_agent"`
	}
	if err := q.json(&b); err != nil {
		errJSON(w, 400, "bad json")
		return
	}
	author := member{"user", q.who.userID}
	if q.who.machine {
		a, ok := h.agent(b.AsAgent)
		if !ok || !h.agentOn(a.ID, q.who.machineID) {
			errJSON(w, 403, "这台机器上没有这个 Agent")
			return
		}
		author = member{"agent", a.ID}
	}
	if c.Archived {
		errJSON(w, 409, "频道已归档")
		return
	}
	if !h.isMember(c.ID, author.Kind, author.ID) {
		errJSON(w, 403, "先加入这个频道")
		return
	}
	if why := h.dmClosed(c, author); why != "" {
		errJSON(w, 403, why)
		return
	}
	if b.ClientID != "" {
		if !clientIDRE.MatchString(b.ClientID) {
			errJSON(w, 400, "bad client_id")
			return
		}
		var prev string
		if h.db.QueryRow("SELECT id FROM messages WHERE author_kind = ? AND author_id = ? AND client_id = ?", author.Kind, author.ID, b.ClientID).Scan(&prev) == nil {
			m, _ := h.message(prev) // a retry: the first one stands
			writeJSON(w, 200, m)
			return
		}
	}
	files, ok := ownerAttachments(b.Attachments)
	if !ok {
		errJSON(w, 400, "bad attachments")
		return
	}
	for _, f := range files {
		if h.count("SELECT COUNT(*) FROM media WHERE id = ?", f[7:]) == 0 {
			errJSON(w, 400, "attachment not found")
			return
		}
	}
	text := strings.TrimRight(b.Text, " \t\n")
	if isBlank(text) && len(files) == 0 {
		errJSON(w, 400, "text required")
		return
	}
	if len(text) > 40_000 {
		errJSON(w, 413, "消息太长（40 KB 以内）")
		return
	}
	var thread any
	if b.ThreadID != "" {
		root, ok := h.message(b.ThreadID)
		if !ok || root.ChannelID != c.ID {
			errJSON(w, 400, "没有这个线程")
			return
		}
		if root.ThreadID != nil {
			thread = *root.ThreadID // replying to a reply: same thread
		} else {
			thread = root.ID
		}
	}
	if b.AsTask {
		if thread != nil {
			errJSON(w, 400, "线程里的消息是讨论，不能作为任务；在频道里另发一条吧")
			return
		}
		agents := 0
		for _, mm := range h.postMentions(c, thread == nil, author, text) {
			if mm.Kind == "agent" {
				agents++
			}
		}
		if agents == 0 {
			errJSON(w, 400, "作为任务要 @ 一个 Agent")
			return
		}
	}
	mentions, _ := json.Marshal(h.postMentions(c, thread == nil, author, text))
	att, _ := json.Marshal(files)
	var clientID any
	if b.ClientID != "" {
		clientID = b.ClientID
	}
	id := newID("msg_")
	h.must(h.db.Exec(`INSERT INTO messages (id, channel_id, thread_id, author_kind, author_id, text, mentions, attachments, client_id, created)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, c.ID, thread, author.Kind, author.ID, text, string(mentions), string(att), clientID, h.nowMs()))
	m, _ := h.message(id)
	h.broadcastChannel(c.ID, obj{"type": "message", "message": m})
	h.onPosted(m, b.AsTask)
	writeJSON(w, 200, m)
}

func (h *Hub) v1Edit(w http.ResponseWriter, q *request) {
	m, ok := h.message(q.r.PathValue("id"))
	if !ok || !h.canRead(q.who, m.ChannelID) {
		errJSON(w, 404, "not found")
		return
	}
	mine := (m.Author.Kind == "user" && !q.who.machine && m.Author.ID == q.who.userID)
	if m.Author.Kind == "agent" && q.who.machine {
		a, ok := h.agent(m.Author.ID)
		mine = ok && h.agentOn(a.ID, q.who.machineID)
	}
	if !mine {
		errJSON(w, 403, "只能改自己的消息")
		return
	}
	var b struct{ Text string }
	_ = q.json(&b)
	if isBlank(b.Text) {
		errJSON(w, 400, "text required")
		return
	}
	c, _ := h.channel(m.ChannelID)
	mentions, _ := json.Marshal(h.postMentions(c, m.ThreadID == nil, m.Author, b.Text))
	h.must(h.db.Exec("UPDATE messages SET text = ?, mentions = ?, edited = ? WHERE id = ?", b.Text, string(mentions), h.nowMs(), m.ID))
	m, _ = h.message(m.ID)
	h.broadcastChannel(m.ChannelID, obj{"type": "message_edited", "message": m})
	writeJSON(w, 200, m)
}

// v1Updates: every message after ?after=<seq> in the channels this client follows (a person: the ones they are in;
// a machine: its agents'), for catching up after a reconnect. Up to 500 at a time; more=true means ask again.
func (h *Hub) v1Updates(w http.ResponseWriter, q *request) {
	after, _ := strconv.ParseInt(q.query("after"), 10, 64)
	var rows *sql.Rows
	var err error
	if q.who.machine {
		rows, err = h.db.Query("SELECT "+messageCols+` FROM messages m WHERE m.seq > ? AND m.channel_id IN (
			SELECT cm.channel_id FROM channel_members cm JOIN agent_machines am ON am.agent_id = cm.member_id WHERE cm.kind = 'agent' AND am.machine_id = ?)
			ORDER BY m.seq LIMIT 501`, after, q.who.machineID)
	} else {
		rows, err = h.db.Query("SELECT "+messageCols+` FROM messages m WHERE m.seq > ? AND m.channel_id IN (
			SELECT channel_id FROM channel_members WHERE kind = 'user' AND member_id = ?) ORDER BY m.seq LIMIT 501`, after, q.who.userID)
	}
	ms := scanMessages(rows, err)
	more := len(ms) > 500
	if more {
		ms = ms[:500]
	}
	writeJSON(w, 200, obj{"messages": ms, "more": more})
}
