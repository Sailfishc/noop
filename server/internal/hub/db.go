package hub

import (
	"database/sql"
	"fmt"
	"strings"

	_ "modernc.org/sqlite" // pure Go: no cgo, one static binary
)

// OpenDB opens (or creates) the hub's SQLite file. One connection: every statement is serialized, and the hub's
// own mutex makes multi-statement operations (claims, sign-in checks) atomic.
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

// Sessions, small settings (kv) and stored files (media, 1 MB chunks). A database from noop's single-person days
// still has its other tables (events, inbox, files, history, …); nothing reads them now.
const schema = `
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS media (id TEXT, n INTEGER, type TEXT, data BLOB, PRIMARY KEY (id, n));
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, email TEXT, created INTEGER, last_seen INTEGER, ua TEXT, scope TEXT);
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
CREATE TABLE IF NOT EXISTS task_events (task_id TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, needs TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS task_events_task ON task_events (task_id, at);
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
	if _, err := db.Exec(signupSchema); err != nil {
		return err
	}
	if _, err := db.Exec(triggersSchema); err != nil {
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
		"ALTER TABLE tasks_v1 ADD COLUMN usage TEXT",                                  // tokens its runs used, added up
		"ALTER TABLE agents ADD COLUMN paused TEXT NOT NULL DEFAULT ''",               // no longer read: runtimes on machines are held back instead (teamquota.go)
		"ALTER TABLE tasks_v1 ADD COLUMN titled INTEGER NOT NULL DEFAULT 0",           // its title was given (by the agent or a person), not cut from the request
		"ALTER TABLE tasks_v1 ADD COLUMN handler TEXT NOT NULL DEFAULT ''",            // who takes it when it stops for people ("" = its creator)
		"ALTER TABLE tasks_v1 ADD COLUMN cancelled_at INTEGER",                        // when a person cancelled it (teammetrics.go: was it asked again)
		"ALTER TABLE tasks_v1 ADD COLUMN news INTEGER NOT NULL DEFAULT 0",             // something new for its running agent (teamsteer.go)
		"ALTER TABLE tasks_v1 ADD COLUMN asked TEXT NOT NULL DEFAULT '[]'",            // questions its agent put to people (remi ask)
		"ALTER TABLE tasks_v1 ADD COLUMN repos TEXT NOT NULL DEFAULT '[]'",            // repositories its agent declared (remi repo)
		"ALTER TABLE machines ADD COLUMN team INTEGER NOT NULL DEFAULT 0",             // a team Computer: admins put agents on it (teamowned.go)
		"ALTER TABLE machines ADD COLUMN sync_team_config INTEGER NOT NULL DEFAULT 0", // a person's own machine takes the team config repository too (its owner chose so)
		"ALTER TABLE channels ADD COLUMN conventions TEXT NOT NULL DEFAULT ''",        // how this channel works, for its agents
		"ALTER TABLE tasks_v1 ADD COLUMN handoffs TEXT NOT NULL DEFAULT '[]'",         // its agent's handoffs to other agents, each a card a person clicks (teamhandoff.go)
		"ALTER TABLE tasks_v1 ADD COLUMN submits TEXT NOT NULL DEFAULT '[]'",          // its agent's submissions to outside services (remi submit, at most 3)
		"ALTER TABLE triggers ADD COLUMN max_per_day INTEGER NOT NULL DEFAULT 10",     // firings a day at most (teamtriggers.go)
		"ALTER TABLE triggers ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0",          // firings skipped: the last task still open, or the day's limit
		"ALTER TABLE triggers ADD COLUMN last_task TEXT",                              // the task it opened last
		"ALTER TABLE triggers ADD COLUMN day TEXT NOT NULL DEFAULT ''",                // the day day_fires counts (2006-01-02, the server's zone)
		"ALTER TABLE triggers ADD COLUMN day_fires INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE triggers ADD COLUMN skipped_run INTEGER NOT NULL DEFAULT 0", // skipped in a row since it last fired
		"ALTER TABLE triggers ADD COLUMN skip_reason TEXT NOT NULL DEFAULT ''",   // why the last one was: busy (its last task is open) | limit
		"ALTER TABLE triggers ADD COLUMN stuck_noted TEXT NOT NULL DEFAULT ''",   // the stuck task its creator was told about, once
		"ALTER TABLE channels ADD COLUMN private INTEGER NOT NULL DEFAULT 0",     // only its members see it (chat.go canRead)
		"ALTER TABLE users ADD COLUMN preferences TEXT NOT NULL DEFAULT ''",      // 「我的偏好」: given to agents on the tasks they ask for (teammemory.go)
		"ALTER TABLE channels ADD COLUMN dm_agent TEXT",                          // a person's private chat with this agent (teamdm.go)
		"ALTER TABLE tasks_v1 ADD COLUMN aligned INTEGER NOT NULL DEFAULT 0",     // its agent aligned with people once (teamalign.go): never again
		"ALTER TABLE tasks_v1 ADD COLUMN evidence TEXT NOT NULL DEFAULT '[]'",    // per acceptance criterion, how its agent verified it (teamevidence.go)
		"ALTER TABLE task_events ADD COLUMN who TEXT NOT NULL DEFAULT ''",        // the person the task needed then ("" = nobody); teammetrics.go
	} {
		if _, err := db.Exec(alter); err != nil && !strings.Contains(err.Error(), "duplicate column") {
			return err
		}
	}
	// one private chat per person and agent
	if _, err := db.Exec("CREATE UNIQUE INDEX IF NOT EXISTS channels_dm ON channels (created_by, dm_agent) WHERE dm_agent IS NOT NULL"); err != nil {
		return err
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
	if _, err := db.Exec(thumbsSchemaTable); err != nil {
		return err
	}
	if _, err := db.Exec(remindersSchema); err != nil {
		return err
	}
	if _, err := db.Exec(runtimeStatusSchema); err != nil {
		return err
	}
	if _, err := db.Exec(agentMachinesSchema); err != nil {
		return err
	}
	return initSearch(db)
}
