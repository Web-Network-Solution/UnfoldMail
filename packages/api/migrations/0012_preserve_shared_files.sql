-- Shared download links outlive the uploader's mailbox and account.
-- Rebuild only this table to make attribution nullable, with SET NULL on deletion.
-- No other table references shared_files. IDs and R2 keys remain unchanged.
CREATE TABLE shared_files_preserved (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size INTEGER NOT NULL,
    r2_key TEXT NOT NULL,
    -- Compatibility column for older Worker versions; NOT an expiration policy.
    expires_at TEXT NOT NULL DEFAULT '9999-12-31T23:59:59Z',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO shared_files_preserved
    (id, user_id, filename, mime_type, size, r2_key, expires_at, created_at)
SELECT id, user_id, filename, mime_type, size, r2_key, expires_at, created_at
FROM shared_files;

DROP TABLE shared_files;
ALTER TABLE shared_files_preserved RENAME TO shared_files;
CREATE INDEX idx_shared_files_user ON shared_files(user_id, created_at);
