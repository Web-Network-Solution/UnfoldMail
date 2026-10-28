-- Fresh installations only. Baseline equivalent to migrations through 0021.
-- Mail metadata is created inside MailboxDO, never in this central database.
-- Refuse any existing application schema BEFORE making changes (malformed JSON error).
SELECT CASE WHEN EXISTS (
 SELECT 1 FROM sqlite_master WHERE type='table'
 AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' AND name != 'd1_migrations'
) THEN json('Fresh installation requires an empty database') ELSE 1 END;

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE login_attempts (
    email TEXT PRIMARY KEY,
    failed_count INTEGER NOT NULL DEFAULT 0,
    first_failed_at TEXT NOT NULL,
    last_failed_at TEXT NOT NULL
);

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

CREATE TABLE sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE "shared_files" (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size INTEGER NOT NULL,
    r2_key TEXT NOT NULL,
    -- Compatibility column for older Worker versions; NOT an expiration policy.
    expires_at TEXT NOT NULL DEFAULT '9999-12-31T23:59:59Z',
    created_at TEXT DEFAULT (datetime('now')), lifecycle TEXT NOT NULL DEFAULT 'retained'
  CHECK(lifecycle IN ('staged', 'retained', 'deleting')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE shared_uploads (
  share_id TEXT PRIMARY KEY REFERENCES shared_files(id) ON DELETE CASCADE,
  upload_id TEXT,
  status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','completing'))
, part_size INTEGER NOT NULL DEFAULT 8388608
  CHECK(part_size IN (5242880,8388608,16777216,33554432)));

CREATE TABLE shared_upload_parts (
  share_id TEXT NOT NULL REFERENCES shared_uploads(share_id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  PRIMARY KEY(share_id, part_number)
);

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

CREATE TABLE contacts (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE, phone TEXT NOT NULL DEFAULT '',
 company TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', groups_json TEXT NOT NULL DEFAULT '[]',
 revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
 UNIQUE(user_id,email)
);

CREATE TABLE calendar_events (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 uid TEXT NOT NULL, organizer TEXT NOT NULL COLLATE NOCASE, title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
 start_at TEXT NOT NULL, end_at TEXT NOT NULL, series_end_at TEXT NOT NULL, timezone TEXT NOT NULL,
 all_day INTEGER NOT NULL DEFAULT 0, recurrence TEXT NOT NULL DEFAULT '',
 excluded_dates TEXT NOT NULL DEFAULT '[]', reminder_minutes INTEGER,
 next_reminder_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','cancelled')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, mutation_id TEXT NOT NULL DEFAULT '', meeting_json TEXT NOT NULL DEFAULT 'null', UNIQUE(owner_id,uid)
);

CREATE TABLE calendar_attendees (
 event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
 email TEXT NOT NULL COLLATE NOCASE,
 response TEXT NOT NULL DEFAULT 'needs-action' CHECK(response IN ('needs-action','accepted','tentative','declined')),
 token_hash TEXT NOT NULL UNIQUE,
 PRIMARY KEY(event_id,email)
);

CREATE TABLE calendar_deliveries (
 id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, recipient TEXT NOT NULL,
 kind TEXT NOT NULL, payload TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed','uncertain','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
 error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sent_copy_saved INTEGER NOT NULL DEFAULT 0,
 dedupe_key TEXT NOT NULL UNIQUE
);

CREATE TABLE mailbox_routes (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 state TEXT NOT NULL CHECK(state IN ('d1','copying','verified','active')) DEFAULT 'd1',
 purge_legacy INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
, provision_new INTEGER NOT NULL DEFAULT 0 CHECK(provision_new IN (0,1)));

CREATE TABLE mailbox_metrics (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 emails INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
 attachments INTEGER NOT NULL DEFAULT 0, attachment_bytes INTEGER NOT NULL DEFAULT 0,
 sent INTEGER NOT NULL DEFAULT 0, received INTEGER NOT NULL DEFAULT 0,
 today INTEGER NOT NULL DEFAULT 0, week INTEGER NOT NULL DEFAULT 0,
 database_bytes INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);

CREATE TABLE mailbox_shared_pins (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 email_id TEXT NOT NULL, share_id TEXT NOT NULL REFERENCES shared_files(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(user_id,email_id,share_id)
);

CREATE TABLE mailbox_forwarding_snapshots (
 snapshot_key TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE mailbox_deletions (
  user_id TEXT PRIMARY KEY,
  prefix_index INTEGER NOT NULL DEFAULT -1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE INDEX idx_shared_files_user ON shared_files(user_id, created_at);

CREATE INDEX idx_shared_files_cleanup ON shared_files(lifecycle, created_at);

CREATE INDEX idx_forwarding_audit_date ON forwarding_audit(created_at);

CREATE INDEX contacts_owner_name ON contacts(user_id,name,id);

CREATE INDEX calendar_owner_range ON calendar_events(owner_id,start_at,end_at);

CREATE INDEX calendar_reminders ON calendar_events(next_reminder_at) WHERE next_reminder_at IS NOT NULL AND status='confirmed';

CREATE INDEX calendar_attendee_email ON calendar_attendees(email,event_id);

CREATE INDEX calendar_delivery_due ON calendar_deliveries(status,next_attempt_at);

CREATE INDEX idx_mailbox_shared_pins_share ON mailbox_shared_pins(share_id);

CREATE TRIGGER calendar_event_limit BEFORE INSERT ON calendar_events
WHEN (SELECT COUNT(*) FROM calendar_events WHERE owner_id=NEW.owner_id)>=5000
BEGIN SELECT RAISE(ABORT,'Calendar limit is 5000 events'); END;

CREATE TRIGGER mailbox_pin_guard BEFORE INSERT ON mailbox_shared_pins
WHEN NOT EXISTS (SELECT 1 FROM shared_files WHERE id=NEW.share_id AND lifecycle!='deleting' AND NOT EXISTS(SELECT 1 FROM shared_uploads WHERE share_id=NEW.share_id))
BEGIN SELECT RAISE(ABORT,'Shared upload is unavailable; upload the file again'); END;

CREATE TRIGGER provision_new_mailbox AFTER INSERT ON users
BEGIN
  INSERT INTO mailbox_routes(user_id,state,provision_new) VALUES(NEW.id,'copying',1);
END;
INSERT INTO settings(key,value) VALUES ('archive_after_days','365');
INSERT INTO settings(key,value) VALUES ('delete_trash_after_days','30');

-- These historical migrations are covered by this baseline; do not replay them.
