-- ══════════════════════════════════════════════════════════════════
-- Migration 0007: Performance & Read/Write Cost Optimization Indexes
-- ══════════════════════════════════════════════════════════════════

-- 1. Index shared_files by user_id and created_at to speed up admin stats/reports aggregation
CREATE INDEX IF NOT EXISTS idx_shared_files_user ON shared_files(user_id, created_at);

-- 2. Index attachments by created_at for fast date-range filtering in reports & retention
CREATE INDEX IF NOT EXISTS idx_attachments_created_at ON attachments(created_at);

-- 3. Index emails by received_at for fast date-range filtering across system-wide queries
CREATE INDEX IF NOT EXISTS idx_emails_received_at ON emails(received_at);
