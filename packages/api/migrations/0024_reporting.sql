-- Published reporting data; changed daily rows and freshness commit atomically.
CREATE TABLE mailbox_report_state (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 updated_at TEXT NOT NULL, history_since TEXT NOT NULL
);
CREATE TABLE mailbox_report_days (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 day TEXT NOT NULL, n INTEGER NOT NULL, bytes INTEGER NOT NULL,
 sent INTEGER NOT NULL, received INTEGER NOT NULL,
 sent_bytes INTEGER NOT NULL, received_bytes INTEGER NOT NULL,
 attachments INTEGER NOT NULL, attachment_bytes INTEGER NOT NULL,
 PRIMARY KEY(user_id,day)
);
CREATE INDEX idx_mailbox_report_day ON mailbox_report_days(day,user_id);
CREATE INDEX idx_shared_files_created ON shared_files(created_at);
