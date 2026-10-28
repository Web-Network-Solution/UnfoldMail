CREATE TABLE setup_state (
 id INTEGER PRIMARY KEY CHECK(id=1), credential TEXT, method TEXT, expires_at INTEGER,
 plan TEXT, progress TEXT NOT NULL DEFAULT '[]', oauth_pending TEXT,
 lock_id TEXT, lock_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO setup_state(id) VALUES(1);
