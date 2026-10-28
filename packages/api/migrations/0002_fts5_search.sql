-- ══════════════════════════════════════════════════════════════════
-- Email Service — Full-Text Search (FTS5)
-- ══════════════════════════════════════════════════════════════════

-- FTS5 virtual table for email search
-- Indexes subject, sender, and snippet for fast text queries
CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
    email_id,
    user_id,
    subject,
    sender,
    snippet,
    content='',
    contentless_delete=1
);

-- Note: We use a contentless FTS5 table and manually manage inserts/deletes
-- in the application layer (email-processor.ts) rather than triggers,
-- because D1 triggers on virtual tables can be unreliable.
-- The application code MUST call insertFtsEntry() and deleteFtsEntry()
-- whenever emails are created or deleted.
