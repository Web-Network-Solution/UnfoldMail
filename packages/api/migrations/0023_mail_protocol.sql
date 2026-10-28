-- Additive control-plane tables. Protocols are disabled until explicitly enabled.
CREATE TABLE IF NOT EXISTS protocol_passwords (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
 account_hash TEXT NOT NULL, created_at TEXT NOT NULL,
 last_used_at TEXT, revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS protocol_passwords_user ON protocol_passwords(user_id);
CREATE TABLE IF NOT EXISTS protocol_user_access (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
);
