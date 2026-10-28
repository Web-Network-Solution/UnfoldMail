ALTER TABLE emails ADD COLUMN delivery_status TEXT;
ALTER TABLE emails ADD COLUMN delivery_error TEXT;

CREATE TABLE outbound_jobs (
  email_id TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  request_id TEXT,
  source_draft_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_outbound_request ON outbound_jobs(user_id, request_id);
CREATE INDEX idx_outbound_due ON outbound_jobs(status, next_attempt_at);
CREATE INDEX idx_outbound_user ON outbound_jobs(user_id);
CREATE INDEX idx_emails_thread_page ON emails(user_id, thread_id, received_at DESC, id DESC);
CREATE INDEX idx_emails_folder_unread ON emails(user_id, folder_id, is_read);
