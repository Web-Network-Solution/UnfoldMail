-- Migration: Create shared_files table for large file uploads (>25MB, ≤1GB)
-- These files are stored in R2 and a download link is inserted into the email body.

CREATE TABLE IF NOT EXISTS shared_files (
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

-- Index for cleanup job: find expired shared files efficiently
CREATE INDEX IF NOT EXISTS idx_shared_files_expires ON shared_files(expires_at);
