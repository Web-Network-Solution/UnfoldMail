-- ══════════════════════════════════════════════════════════════════
-- Email Service — FTS repair, trash timestamps, login throttling
-- ══════════════════════════════════════════════════════════════════

-- ─── 1. Rebuild the full-text index ───────────────────────────────
-- 0002 created a CONTENTLESS table (content=''). FTS5 does not store column
-- values for contentless tables, so `SELECT email_id FROM emails_fts` returned
-- NULL for every row. That made the search JOIN (`ON e.id = fts.email_id`)
-- match nothing and made `DELETE ... WHERE email_id = ?` a silent no-op.
--
-- Replace it with an ordinary FTS5 table. `email_id` and `user_id` are
-- UNINDEXED: their values are stored and readable (so joins, user scoping and
-- deletes all work) but they are not tokenized, so they cannot pollute
-- full-text matches.

DROP TABLE IF EXISTS emails_fts;

CREATE VIRTUAL TABLE emails_fts USING fts5(
    email_id UNINDEXED,
    user_id UNINDEXED,
    subject,
    sender,
    snippet,
    tokenize = 'unicode61'
);

-- Backfill from the authoritative table so existing mail becomes searchable.
INSERT INTO emails_fts (email_id, user_id, subject, sender, snippet)
SELECT id, user_id, COALESCE(subject, ''), COALESCE(sender, ''), COALESCE(snippet, '')
FROM emails;

-- ─── 2. Track when mail entered the trash ─────────────────────────
-- Retention used to purge trash by `received_at`, so moving a two-year-old
-- email to trash destroyed it on the next nightly run instead of 30 days
-- later. Purge by the deletion time instead.

ALTER TABLE emails ADD COLUMN trashed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_emails_trashed_at ON emails(trashed_at);

-- Anything already sitting in trash gets its clock started now rather than
-- being purged immediately on the next run.
UPDATE emails
SET trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE trashed_at IS NULL
  AND folder_id IN (SELECT id FROM folders WHERE type = 'trash');

-- ─── 3. Login throttling ──────────────────────────────────────────
-- Backs the per-address lockout in routes/auth.ts.

CREATE TABLE IF NOT EXISTS login_attempts (
    email TEXT PRIMARY KEY,
    failed_count INTEGER NOT NULL DEFAULT 0,
    first_failed_at TEXT NOT NULL,
    last_failed_at TEXT NOT NULL
);

-- ─── 4. Idempotency for inbound queue processing ──────────────────
-- A Cloudflare Queue redelivers on retry. Without this, a retry after a
-- partial write duplicated the email row, the R2 objects and the FTS entry.
-- The consumer claims (raw_key, user_id) before writing; a duplicate delivery
-- hits the primary key and is skipped.

CREATE TABLE IF NOT EXISTS processed_inbound (
    raw_key TEXT NOT NULL,
    user_id TEXT NOT NULL,
    email_id TEXT NOT NULL,
    processed_at TEXT NOT NULL,
    PRIMARY KEY (raw_key, user_id)
);

CREATE INDEX IF NOT EXISTS idx_processed_inbound_at ON processed_inbound(processed_at);

-- ─── 5. Indexes the query planner was missing ─────────────────────

CREATE INDEX IF NOT EXISTS idx_emails_user_received ON emails(user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_folders_user_type ON folders(user_id, type);
