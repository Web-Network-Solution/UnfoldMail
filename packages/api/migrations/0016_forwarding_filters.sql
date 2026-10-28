-- Additive only. Mailbox rows, attachments and existing delivery jobs are unchanged.
CREATE TABLE forwarding_configs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE forwarding_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_forwarding_audit_date ON forwarding_audit(created_at);
-- Snapshot references deliberately outlive deletion of the original email/account.
-- Cleanup cancels orphaned jobs and releases the private snapshots.
CREATE TABLE forwarding_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  source_email_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  subject TEXT NOT NULL,
  snapshot_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','sending','sent','failed','uncertain','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_email_id, destination)
);
CREATE INDEX idx_forwarding_due ON forwarding_jobs(status,next_attempt_at);
CREATE INDEX idx_forwarding_user ON forwarding_jobs(user_id,created_at);
CREATE INDEX idx_forwarding_snapshot ON forwarding_jobs(snapshot_key);
CREATE INDEX idx_forwarding_updated ON forwarding_jobs(status,updated_at);
