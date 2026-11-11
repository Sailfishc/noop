package hub

import (
	"database/sql"
	"net/http"
	"strings"
	"unicode/utf8"
)

// Full-text search over messages (with the names of their attachments, as uploaded) and tasks (id, title, summary), for people
// (the search box) and agents (`remi search`). SQLite FTS5 with the trigram tokenizer: any 3 characters match, so
// Chinese needs no word list. A word shorter than 3 characters is matched with LIKE over the same text. Triggers keep
// the index in step: a message's row is its seq, a task's row is minus its number.

const searchSchema = `
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(kind UNINDEXED, text, tokenize = 'trigram');
CREATE TRIGGER IF NOT EXISTS search_msg_ai AFTER INSERT ON messages BEGIN
  INSERT INTO search (rowid, kind, text) VALUES (NEW.seq, 'm', NEW.text || ' ' || COALESCE((SELECT group_concat(COALESCE(u.name, j.value), ' ') FROM json_each(COALESCE(NEW.attachments, '[]')) j LEFT JOIN uploads u ON '/media/' || u.id = j.value), ''));
END;
CREATE TRIGGER IF NOT EXISTS search_msg_au AFTER UPDATE OF text, attachments ON messages BEGIN
  DELETE FROM search WHERE rowid = OLD.seq;
  INSERT INTO search (rowid, kind, text) VALUES (NEW.seq, 'm', NEW.text || ' ' || COALESCE((SELECT group_concat(COALESCE(u.name, j.value), ' ') FROM json_each(COALESCE(NEW.attachments, '[]')) j LEFT JOIN uploads u ON '/media/' || u.id = j.value), ''));
END;
CREATE TRIGGER IF NOT EXISTS search_msg_ad AFTER DELETE ON messages BEGIN
  DELETE FROM search WHERE rowid = OLD.seq;
END;
CREATE TRIGGER IF NOT EXISTS search_task_ai AFTER INSERT ON tasks_v1 BEGIN
  INSERT INTO search (rowid, kind, text) VALUES (-NEW.num, 't', 'T-' || printf('%04d', NEW.num) || ' ' || NEW.title || ' ' || NEW.summary);
END;
CREATE TRIGGER IF NOT EXISTS search_task_au AFTER UPDATE OF title, summary ON tasks_v1 BEGIN
  DELETE FROM search WHERE rowid = -OLD.num;
  INSERT INTO search (rowid, kind, text) VALUES (-NEW.num, 't', 'T-' || printf('%04d', NEW.num) || ' ' || NEW.title || ' ' || NEW.summary);
END;
CREATE TRIGGER IF NOT EXISTS search_task_ad AFTER DELETE ON tasks_v1 BEGIN
  DELETE FROM search WHERE rowid = -OLD.num;
END;`

// initSearch: the index and its triggers; what was there before the index is indexed once.
func initSearch(db *sql.DB) error {
	if _, err := db.Exec(searchSchema); err != nil {
		return err
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM search").Scan(&n); err != nil || n > 0 {
		return err
	}
	_, err := db.Exec(`INSERT INTO search (rowid, kind, text)
		SELECT seq, 'm', text || ' ' || COALESCE((SELECT group_concat(COALESCE(u.name, j.value), ' ') FROM json_each(COALESCE(messages.attachments, '[]')) j LEFT JOIN uploads u ON '/media/' || u.id = j.value), '') FROM messages;
		INSERT INTO search (rowid, kind, text) SELECT -num, 't', 'T-' || printf('%04d', num) || ' ' || title || ' ' || summary FROM tasks_v1;`)
	return err
}

// searchQuery: what to look for (all the words), where (channels; nil = all), from whom (a person's or an agent's id),
// seen by whom (reader: only the channels that person sees; "" = no such limit).
type searchQuery struct {
	words    []string
	channels []string
	author   string
	reader   string
	limit    int
}

// match: the index condition for the words: an FTS phrase for each word of 3 characters or more, a LIKE for shorter.
func (s searchQuery) match() (string, []any, bool) {
	var phrases []string
	var conds []string
	var args []any
	for _, w := range s.words[:min(len(s.words), 8)] {
		if utf8.RuneCountInString(w) >= 3 {
			phrases = append(phrases, `"`+strings.ReplaceAll(w, `"`, `""`)+`"`)
		} else {
			conds = append(conds, "text LIKE ? ESCAPE '\\'")
			args = append(args, "%"+strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(w)+"%")
		}
	}
	if len(phrases) == 0 && len(conds) == 0 {
		return "", nil, false
	}
	if len(phrases) > 0 {
		conds = append([]string{"search MATCH ?"}, conds...)
		args = append([]any{strings.Join(phrases, " AND ")}, args...)
	}
	return strings.Join(conds, " AND "), args, true
}

func inList(col string, ids []string) (string, []any) {
	if len(ids) == 0 {
		return "0", nil
	}
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	return col + " IN (?" + strings.Repeat(", ?", len(ids)-1) + ")", args
}

// search: the messages and tasks with all the words, newest first.
func (h *Hub) search(s searchQuery) ([]messageView, []taskView) {
	cond, margs, ok := s.match()
	if !ok {
		return nil, nil
	}
	where, args := []string{"m.seq IN (SELECT rowid FROM search WHERE kind = 'm' AND " + cond + ")"}, append([]any{}, margs...)
	twhere, targs := []string{"-num IN (SELECT rowid FROM search WHERE kind = 't' AND " + cond + ")"}, append([]any{}, margs...)
	if s.channels != nil {
		c, a := inList("m.channel_id", s.channels)
		where, args = append(where, c), append(args, a...)
		c, a = inList("channel_id", s.channels)
		twhere, targs = append(twhere, c), append(targs, a...)
	}
	if s.reader != "" {
		c, a := readableBy("m.channel_id", s.reader)
		where, args = append(where, c), append(args, a...)
		c, a = readableBy("channel_id", s.reader)
		twhere, targs = append(twhere, c), append(targs, a...)
	}
	if s.author != "" {
		where, args = append(where, "m.author_id = ?"), append(args, s.author)
		twhere, targs = append(twhere, "(agent_id = ? OR created_by = ?)"), append(targs, s.author, s.author)
	}
	ms := scanMessages(h.db.Query("SELECT "+messageCols+" FROM messages m WHERE "+strings.Join(where, " AND ")+" ORDER BY m.seq DESC LIMIT ?", append(args, s.limit)...))
	ts := scanTasks(h.db.Query("SELECT "+taskCols+" FROM tasks_v1 WHERE "+strings.Join(twhere, " AND ")+" ORDER BY updated DESC LIMIT ?", append(targs, min(s.limit, 20))...))
	return ms, h.withOutputs(ts)
}

// v1Search: the search box. GET /api/v1/search?q=WORDS[&channel=ID][&from=HANDLE][&limit=N]
func (h *Hub) v1Search(w http.ResponseWriter, q *request) {
	s := searchQuery{words: strings.Fields(q.query("q")), reader: q.who.userID, limit: clampInt(q.query("limit"), 30, 1, 100)}
	if len(s.words) == 0 {
		errJSON(w, 400, "要搜什么？")
		return
	}
	if c := q.query("channel"); c != "" {
		ch, ok := h.channel(c)
		if !ok || !h.canRead(q.who, ch.ID) {
			errJSON(w, 404, "没有这个频道")
			return
		}
		s.channels = []string{ch.ID}
	}
	if from := strings.TrimPrefix(q.query("from"), "@"); from != "" {
		if h.db.QueryRow("SELECT id FROM users WHERE handle = ?", from).Scan(&s.author) != nil &&
			h.db.QueryRow("SELECT id FROM agents WHERE handle = ?", from).Scan(&s.author) != nil {
			errJSON(w, 404, "没有 @"+from)
			return
		}
	}
	ms, ts := h.search(s)
	if ms == nil {
		ms = []messageView{}
	}
	if ts == nil {
		ts = []taskView{}
	}
	writeJSON(w, 200, obj{"messages": ms, "tasks": ts})
}
