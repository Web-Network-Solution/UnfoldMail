-- This file sorts before 0005_threading_inline_and_indexes.sql on fresh installs.
-- Recreate only columns present at this point; the next migration adds threading fields.
-- Migration: Add super_admin role to the users table CHECK constraint
--
-- Strategy: Rename ALL dependent tables first (folders, emails, attachments,
-- sessions) so their ON DELETE CASCADE FK references are detached.
-- Then drop + recreate users with the updated CHECK constraint.
-- Then recreate all dependent tables pointing to the new users table.
-- This preserves all data safely.

-- Step 1: Rename all dependent tables (detaches FK references)
ALTER TABLE attachments RENAME TO attachments_bak;
ALTER TABLE emails RENAME TO emails_bak;
ALTER TABLE folders RENAME TO folders_bak;
ALTER TABLE sessions RENAME TO sessions_bak;
ALTER TABLE users RENAME TO users_bak;

-- Step 2: Recreate users with updated CHECK
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'employee' CHECK(role IN ('super_admin', 'admin', 'employee')),
    must_reset_password INTEGER DEFAULT 0,
    signature_html TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);
INSERT INTO users SELECT * FROM users_bak;

-- Step 3: Recreate folders pointing to new users
CREATE TABLE folders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'custom' CHECK(type IN ('inbox', 'sent', 'drafts', 'trash', 'archive', 'custom')),
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, name)
);
INSERT INTO folders SELECT * FROM folders_bak;

-- Step 4: Recreate emails pointing to new users/folders
CREATE TABLE emails (
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
    trashed_at TEXT,
    FOREIGN KEY(folder_id) REFERENCES folders(id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
INSERT INTO emails SELECT * FROM emails_bak;

-- Step 5: Recreate attachments
CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    email_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    r2_key TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
);
INSERT INTO attachments SELECT * FROM attachments_bak;

-- Step 6: Recreate sessions
CREATE TABLE sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
INSERT INTO sessions SELECT * FROM sessions_bak;

-- Step 7: Drop backup tables (no FKs pointing to these)
DROP TABLE users_bak;
DROP TABLE folders_bak;
DROP TABLE emails_bak;
DROP TABLE attachments_bak;
DROP TABLE sessions_bak;

-- Step 8: Promote first admin to super_admin
UPDATE users SET role = 'super_admin'
WHERE id = (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1);
