package hub

import (
	"database/sql"
	"fmt"
	"strings"

	_ "modernc.org/sqlite" // pure Go: no cgo, one static binary
)

// OpenDB opens (or creates) the hub's SQLite file. One connection: every statement is serialized, and the hub's
// own mutex makes multi-statement operations (compare-and-swap commits, sign-in checks) atomic, the way the
// Durable Object's single thread did in cloud/.
func OpenDB(path string) (*sql.DB, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(on)&_pragma=synchronous(NORMAL)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	if err := initSchema(db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// The same tables as cloud/src/index.ts and cloud/src/files.ts, so data can move between the two.
const schema = `
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, json TEXT, ref TEXT);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS events_ref ON events (ref);
CREATE INDEX IF NOT EXISTS events_client_id ON events (json_extract(json, '$.client_id')) WHERE json_extract(json, '$.client_id') IS NOT NULL;
CREATE TABLE IF NOT EXISTS inbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS media (id TEXT, n INTEGER, type TEXT, data BLOB, PRIMARY KEY (id, n));
CREATE TABLE IF NOT EXISTS auth_codes (email TEXT PRIMARY KEY, hash TEXT, expires INTEGER, attempts INTEGER);
CREATE TABLE IF NOT EXISTS auth_sends (email TEXT, ts INTEGER, sent INTEGER);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, email TEXT, created INTEGER, last_seen INTEGER, ua TEXT, scope TEXT);
CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, content BLOB, hash TEXT, version INTEGER NOT NULL,
  updated TEXT, by TEXT, deleted INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS files_rev ON files (rev);
CREATE TABLE IF NOT EXISTS history (seq INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, version INTEGER, hash TEXT,
  content BLOB, ts TEXT, by TEXT, msg TEXT);
CREATE INDEX IF NOT EXISTS history_path ON history (path, version);
CREATE TABLE IF NOT EXISTS files_meta (k TEXT PRIMARY KEY, v INTEGER);
`

// TeamAgent's own model: people, their machines and agents, channels, threads and messages (one workspace per server).
const teamSchema = `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, handle TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', totp_secret TEXT NOT NULL, totp_last INTEGER NOT NULL DEFAULT -1,
  disabled INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invites (hash TEXT PRIMARY KEY, email TEXT NOT NULL, role TEXT NOT NULL, created_by TEXT,
  created INTEGER NOT NULL, expires INTEGER NOT NULL, pending_secret TEXT, used_by TEXT, used_at INTEGER);
CREATE TABLE IF NOT EXISTS login_fails (email TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS enroll_codes (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_codes (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  os TEXT, arch TEXT, runtimes TEXT, max_sessions INTEGER NOT NULL DEFAULT 3, created INTEGER NOT NULL, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, machine_id TEXT, handle TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', runtime TEXT NOT NULL DEFAULT 'codex',
  dispatch TEXT NOT NULL DEFAULT 'channel', autonomy TEXT NOT NULL DEFAULT 'assist', created INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '',
  created_by TEXT, created INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS channel_members (channel_id TEXT NOT NULL, kind TEXT NOT NULL, member_id TEXT NOT NULL, joined INTEGER NOT NULL,
  PRIMARY KEY (channel_id, kind, member_id));
CREATE INDEX IF NOT EXISTS channel_members_member ON channel_members (kind, member_id);
CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, channel_id TEXT NOT NULL,
  thread_id TEXT, author_kind TEXT NOT NULL, author_id TEXT NOT NULL, text TEXT NOT NULL, mentions TEXT, attachments TEXT,
  client_id TEXT, created INTEGER NOT NULL, edited INTEGER);
CREATE INDEX IF NOT EXISTS messages_channel ON messages (channel_id, thread_id, seq);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, seq);
CREATE TABLE IF NOT EXISTS tasks_v1 (id TEXT PRIMARY KEY, num INTEGER NOT NULL UNIQUE, channel_id TEXT NOT NULL,
  thread_id TEXT NOT NULL, agent_id TEXT NOT NULL, created_by TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  state TEXT NOT NULL, step TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', decision TEXT, pr TEXT,
  branch TEXT NOT NULL DEFAULT '', session TEXT NOT NULL DEFAULT '', claimed_by TEXT, confirmed_by TEXT, runs INTEGER NOT NULL DEFAULT 0,
  seen_seq INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_v1_thread ON tasks_v1 (thread_id);
CREATE INDEX IF NOT EXISTS tasks_v1_agent ON tasks_v1 (agent_id, state);
CREATE TABLE IF NOT EXISTS task_outputs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0, service TEXT NOT NULL DEFAULT '', external_id TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  media TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '', versions TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS task_outputs_task ON task_outputs (task_id, created);
CREATE TABLE IF NOT EXISTS reactions (message_id TEXT NOT NULL, author_kind TEXT NOT NULL, author_id TEXT NOT NULL, emoji TEXT NOT NULL,
  created INTEGER NOT NULL, PRIMARY KEY (message_id, author_kind, author_id, emoji));
CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, name TEXT NOT NULL, user_id TEXT NOT NULL, created INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS messages_client ON messages (author_kind, author_id, client_id) WHERE client_id IS NOT NULL;
`

func initSchema(db *sql.DB) error {
	if _, err := db.Exec(schema); err != nil {
		return err
	}
	if _, err := db.Exec(teamSchema); err != nil {
		return err
	}
	for _, alter := range []string{
		"ALTER TABLE sessions ADD COLUMN user_id TEXT", // sessions now belong to a person (NULL: a legacy noop owner session)
		"ALTER TABLE agents ADD COLUMN repo TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE machines ADD COLUMN info TEXT",      // what the daemon detected: its runtimes and Git credentials (machineInfo)
		"ALTER TABLE machines ADD COLUMN join_hash TEXT", // a one-time code the install script trades for the token
		"ALTER TABLE machines ADD COLUMN join_expires INTEGER",
		"ALTER TABLE machines ADD COLUMN machine_key TEXT",                 // the computer's own id (a file in its data dir): joining again finds its record
		"ALTER TABLE agents ADD COLUMN confirm INTEGER NOT NULL DEFAULT 1", // people other than the owner wait for the owner's yes
		"ALTER TABLE agents ADD COLUMN model TEXT NOT NULL DEFAULT ''",     // "" = the runtime's default model
		"ALTER TABLE tasks_v1 ADD COLUMN acceptance TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE tasks_v1 ADD COLUMN mandate TEXT",
		"ALTER TABLE tasks_v1 ADD COLUMN repo TEXT NOT NULL DEFAULT ''", // host/owner/name, "" = a general task
		"ALTER TABLE channels ADD COLUMN repo TEXT NOT NULL DEFAULT ''", // the channel's default repository
		"ALTER TABLE agents ADD COLUMN memory TEXT NOT NULL DEFAULT ''", // the agent's memory.md: what it keeps between tasks
		"ALTER TABLE tasks_v1 ADD COLUMN wait TEXT",                     // what a waiting task waits for (teamwaits.go)
		"ALTER TABLE tasks_v1 ADD COLUMN wait_token TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE tasks_v1 ADD COLUMN result TEXT NOT NULL DEFAULT ''",     // confirmed | unconfirmed: did the agent see the result
		"ALTER TABLE tasks_v1 ADD COLUMN tracked INTEGER NOT NULL DEFAULT 1",  // a task people track; 0: a conversation turn (an answer)
		"ALTER TABLE tasks_v1 ADD COLUMN read_token TEXT NOT NULL DEFAULT ''", // what its runs read the chat with (teamcontext.go)
		"ALTER TABLE tasks_v1 ADD COLUMN failures INTEGER NOT NULL DEFAULT 0", // runs in a row that failed or died (teamhealth.go)
		"ALTER TABLE tasks_v1 ADD COLUMN last_failure TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE tasks_v1 ADD COLUMN usage TEXT",                    // tokens its runs used, added up
		"ALTER TABLE agents ADD COLUMN paused TEXT NOT NULL DEFAULT ''", // why it takes no work now (teamhealth.go); "" = it does
	} {
		if _, err := db.Exec(alter); err != nil && !strings.Contains(err.Error(), "duplicate column") {
			return err
		}
	}
	// dispatch used to say both who and whether to confirm: owner | confirm (channel, confirm) | open (channel, no confirm)
	for _, up := range []string{
		"UPDATE agents SET dispatch = 'channel', confirm = 0 WHERE dispatch = 'open'",
		"UPDATE agents SET dispatch = 'channel', confirm = 1 WHERE dispatch = 'confirm'",
	} {
		if _, err := db.Exec(up); err != nil {
			return err
		}
	}
	return initSearch(db)
}
