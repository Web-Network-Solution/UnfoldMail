-- ══════════════════════════════════════════════════════════════════
-- Email Service — Initial Schema
-- ══════════════════════════════════════════════════════════════════

-- Users (BetterAuth manages session/account tables separately)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'employee' CHECK(role IN ('admin', 'employee')),
    must_reset_password INTEGER DEFAULT 0,
    signature_html TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Folders (system + custom per user)
CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'custom' CHECK(type IN ('inbox', 'sent', 'drafts', 'trash', 'archive', 'custom')),
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, name)
);

-- Email metadata (bodies stored in R2)
CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    sender_name TEXT DEFAULT '',
    recipients_to TEXT NOT NULL DEFAULT '[]',
    recipients_cc TEXT DEFAULT '[]',
    recipients_bcc TEXT DEFAULT '[]',
    subject TEXT DEFAULT '',
    snippet TEXT DEFAULT '',
    r2_body_key TEXT NOT NULL,
    is_read INTEGER DEFAULT 0,
    is_starred INTEGER DEFAULT 0,
    is_archived INTEGER DEFAULT 0,
    has_attachments INTEGER DEFAULT 0,
    size INTEGER DEFAULT 0,
    in_reply_to TEXT,
    message_id TEXT,
    received_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(folder_id) REFERENCES folders(id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Attachments metadata (files stored in R2)
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    email_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    r2_key TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
);

-- Global settings (retention policy, etc.)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Default retention settings
INSERT OR IGNORE INTO settings (key, value) VALUES ('archive_after_days', '365');
INSERT OR IGNORE INTO settings (key, value) VALUES ('delete_trash_after_days', '30');

-- ─── Indexes ──────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_emails_user_folder
    ON emails(user_id, folder_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_emails_thread
    ON emails(thread_id, received_at ASC);

CREATE INDEX IF NOT EXISTS idx_emails_user_unread
    ON emails(user_id, is_read, folder_id);

CREATE INDEX IF NOT EXISTS idx_emails_message_id
    ON emails(message_id);

CREATE INDEX IF NOT EXISTS idx_emails_archived
    ON emails(user_id, is_archived);

CREATE INDEX IF NOT EXISTS idx_folders_user
    ON folders(user_id);

CREATE INDEX IF NOT EXISTS idx_attachments_email
    ON attachments(email_id);
