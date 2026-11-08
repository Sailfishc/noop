package hub

import (
	"database/sql"
	"fmt"

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

func initSchema(db *sql.DB) error {
	_, err := db.Exec(schema)
	return err
}
