-- ══════════════════════════════════════════════════════════════════
-- Email Service — threading chain, inline attachments, dedupe key,
-- and the indexes the retention job needs
-- ══════════════════════════════════════════════════════════════════

-- ─── 1. Full References chain ─────────────────────────────────────
-- Outbound replies previously set References to the immediate parent only.
-- RFC 5322 wants the accumulated chain, and mail clients use it to thread
-- when In-Reply-To alone is ambiguous.

ALTER TABLE emails ADD COLUMN references_chain TEXT;

-- ─── 2. Inline (cid:) attachment support ──────────────────────────
-- Embedded images arrive as attachments with a Content-ID and
-- `Content-Disposition: inline`. Storing them as ordinary attachments made
-- every HTML mail with a logo show a broken image and a spurious paperclip.

ALTER TABLE attachments ADD COLUMN content_id TEXT;
ALTER TABLE attachments ADD COLUMN disposition TEXT NOT NULL DEFAULT 'attachment';

-- ─── 3. Stable inbound dedupe key ─────────────────────────────────
-- The claim used to be keyed on the per-attempt staging object name, so an
-- Email Routing redelivery (a different staging object for the same message)
-- was not recognised as a duplicate. It is now keyed on the RFC Message-ID,
-- which is stable across delivery attempts.

ALTER TABLE processed_inbound RENAME COLUMN raw_key TO message_key;

-- ─── 4. Indexes ───────────────────────────────────────────────────
-- The nightly archive pass filters on exactly this pair and was full-scanning
-- the emails table.

CREATE INDEX IF NOT EXISTS idx_emails_archive_scan ON emails(is_archived, received_at);
CREATE INDEX IF NOT EXISTS idx_attachments_disposition ON attachments(email_id, disposition);
