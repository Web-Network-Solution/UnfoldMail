-- Fix: shared_files table has FK pointing to non-existent users_bak
-- Recreate with correct FK to users table

ALTER TABLE shared_files RENAME TO shared_files_bak;

CREATE TABLE shared_files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size INTEGER NOT NULL,
    r2_key TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Copy any existing data (table is currently empty, but safe)
INSERT INTO shared_files SELECT * FROM shared_files_bak;

DROP TABLE shared_files_bak;

-- Recreate indexes from migration 0007
CREATE INDEX IF NOT EXISTS idx_shared_files_user ON shared_files(user_id, created_at);
