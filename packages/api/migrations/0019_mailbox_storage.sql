-- Additive rollout metadata. Existing mailboxes remain on D1 until explicitly migrated.
CREATE TABLE mailbox_routes (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 state TEXT NOT NULL CHECK(state IN ('d1','copying','verified','active')) DEFAULT 'd1',
 purge_legacy INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE mailbox_metrics (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 emails INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
 attachments INTEGER NOT NULL DEFAULT 0, attachment_bytes INTEGER NOT NULL DEFAULT 0,
 sent INTEGER NOT NULL DEFAULT 0, received INTEGER NOT NULL DEFAULT 0,
 today INTEGER NOT NULL DEFAULT 0, week INTEGER NOT NULL DEFAULT 0,
 database_bytes INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
-- Protect staged shared files referenced by a migrated draft before committing its mailbox.
CREATE TABLE mailbox_shared_pins (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 email_id TEXT NOT NULL, share_id TEXT NOT NULL REFERENCES shared_files(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(user_id,email_id,share_id)
);
CREATE INDEX idx_mailbox_shared_pins_share ON mailbox_shared_pins(share_id);
CREATE TRIGGER mailbox_pin_guard BEFORE INSERT ON mailbox_shared_pins
WHEN NOT EXISTS (SELECT 1 FROM shared_files WHERE id=NEW.share_id AND lifecycle!='deleting' AND NOT EXISTS(SELECT 1 FROM shared_uploads WHERE share_id=NEW.share_id))
BEGIN SELECT RAISE(ABORT,'Shared upload is unavailable; upload the file again'); END;
CREATE TRIGGER mailbox_freeze_folders_insert BEFORE INSERT ON folders
WHEN EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=NEW.user_id AND state!='d1' AND purge_legacy=0)
BEGIN SELECT RAISE(ABORT,'Mailbox maintenance: legacy writes are frozen'); END;
CREATE TRIGGER mailbox_freeze_folders_update BEFORE UPDATE ON folders
WHEN EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=OLD.user_id AND state!='d1' AND purge_legacy=0) OR EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=NEW.user_id AND state!='d1' AND purge_legacy=0)
BEGIN SELECT RAISE(ABORT,'Mailbox maintenance: legacy writes are frozen'); END;
CREATE TRIGGER mailbox_freeze_folders_delete BEFORE DELETE ON folders
WHEN EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=OLD.user_id AND state!='d1' AND purge_legacy=0)
BEGIN SELECT RAISE(ABORT,'Mailbox maintenance: legacy writes are frozen'); END;
CREATE TRIGGER mailbox_freeze_emails_insert BEFORE INSERT ON emails
WHEN EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=NEW.user_id AND state!='d1' AND purge_legacy=0)
BEGIN SELECT RAISE(ABORT,'Mailbox maintenance: legacy writes are frozen'); END;
CREATE TRIGGER mailbox_freeze_emails_update BEFORE UPDATE ON emails
WHEN EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=OLD.user_id AND state!='d1' AND purge_legacy=0) OR EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=NEW.user_id AND state!='d1' AND purge_legacy=0)
BEGIN SELECT RAISE(ABORT,'Mailbox maintenance: legacy writes are frozen'); END;
CREATE TRIGGER mailbox_freeze_emails_delete BEFORE DELETE ON emails
WHEN EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=OLD.user_id AND state!='d1' AND purge_legacy=0)
BEGIN SELECT RAISE(ABORT,'Mailbox maintenance: legacy writes are frozen'); END;
CREATE TRIGGER mailbox_freeze_attachments_insert BEFORE INSERT ON attachments
WHEN EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=(SELECT user_id FROM emails WHERE id=NEW.email_id) AND state!='d1' AND purge_legacy=0)
BEGIN SELECT RAISE(ABORT,'Mailbox maintenance: legacy writes are frozen'); END;
CREATE TRIGGER mailbox_freeze_attachments_update BEFORE UPDATE ON attachments
WHEN EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=(SELECT user_id FROM emails WHERE id=OLD.email_id) AND state!='d1' AND purge_legacy=0) OR EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=(SELECT user_id FROM emails WHERE id=NEW.email_id) AND state!='d1' AND purge_legacy=0)
BEGIN SELECT RAISE(ABORT,'Mailbox maintenance: legacy writes are frozen'); END;
CREATE TRIGGER mailbox_freeze_attachments_delete BEFORE DELETE ON attachments
WHEN EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=(SELECT user_id FROM emails WHERE id=OLD.email_id) AND state!='d1' AND purge_legacy=0)
BEGIN SELECT RAISE(ABORT,'Mailbox maintenance: legacy writes are frozen'); END;
CREATE TRIGGER mailbox_freeze_processed_inbound_insert BEFORE INSERT ON processed_inbound
WHEN EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=NEW.user_id AND state!='d1' AND purge_legacy=0)
BEGIN SELECT RAISE(ABORT,'Mailbox maintenance: legacy writes are frozen'); END;
CREATE TRIGGER mailbox_freeze_processed_inbound_update BEFORE UPDATE ON processed_inbound
WHEN EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=OLD.user_id AND state!='d1' AND purge_legacy=0) OR EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=NEW.user_id AND state!='d1' AND purge_legacy=0)
BEGIN SELECT RAISE(ABORT,'Mailbox maintenance: legacy writes are frozen'); END;
CREATE TRIGGER mailbox_freeze_processed_inbound_delete BEFORE DELETE ON processed_inbound
WHEN EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=OLD.user_id AND state!='d1' AND purge_legacy=0)
BEGIN SELECT RAISE(ABORT,'Mailbox maintenance: legacy writes are frozen'); END;
CREATE TRIGGER mailbox_freeze_outbound_jobs_insert BEFORE INSERT ON outbound_jobs
WHEN EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=NEW.user_id AND state!='d1' AND purge_legacy=0)
BEGIN SELECT RAISE(ABORT,'Mailbox maintenance: legacy writes are frozen'); END;
CREATE TRIGGER mailbox_freeze_outbound_jobs_update BEFORE UPDATE ON outbound_jobs
WHEN EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=OLD.user_id AND state!='d1' AND purge_legacy=0) OR EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=NEW.user_id AND state!='d1' AND purge_legacy=0)
BEGIN SELECT RAISE(ABORT,'Mailbox maintenance: legacy writes are frozen'); END;
CREATE TRIGGER mailbox_freeze_outbound_jobs_delete BEFORE DELETE ON outbound_jobs
WHEN EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=OLD.user_id AND state!='d1' AND purge_legacy=0)
BEGIN SELECT RAISE(ABORT,'Mailbox maintenance: legacy writes are frozen'); END;
CREATE TRIGGER mailbox_freeze_forwarding_jobs_insert BEFORE INSERT ON forwarding_jobs
WHEN EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=NEW.user_id AND state!='d1' AND purge_legacy=0)
BEGIN SELECT RAISE(ABORT,'Mailbox maintenance: legacy writes are frozen'); END;
CREATE TRIGGER mailbox_freeze_forwarding_jobs_update BEFORE UPDATE ON forwarding_jobs
WHEN EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=OLD.user_id AND state!='d1' AND purge_legacy=0) OR EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=NEW.user_id AND state!='d1' AND purge_legacy=0)
BEGIN SELECT RAISE(ABORT,'Mailbox maintenance: legacy writes are frozen'); END;
CREATE TRIGGER mailbox_freeze_forwarding_jobs_delete BEFORE DELETE ON forwarding_jobs
WHEN EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=OLD.user_id AND state!='d1' AND purge_legacy=0)
BEGIN SELECT RAISE(ABORT,'Mailbox maintenance: legacy writes are frozen'); END;
CREATE TRIGGER mailbox_freeze_email_shared_files_insert BEFORE INSERT ON email_shared_files
WHEN EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=(SELECT user_id FROM emails WHERE id=NEW.email_id) AND state!='d1' AND purge_legacy=0)
BEGIN SELECT RAISE(ABORT,'Mailbox maintenance: legacy writes are frozen'); END;
CREATE TRIGGER mailbox_freeze_email_shared_files_update BEFORE UPDATE ON email_shared_files
WHEN EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=(SELECT user_id FROM emails WHERE id=OLD.email_id) AND state!='d1' AND purge_legacy=0) OR EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=(SELECT user_id FROM emails WHERE id=NEW.email_id) AND state!='d1' AND purge_legacy=0)
BEGIN SELECT RAISE(ABORT,'Mailbox maintenance: legacy writes are frozen'); END;
CREATE TRIGGER mailbox_freeze_email_shared_files_delete BEFORE DELETE ON email_shared_files
WHEN EXISTS(SELECT 1 FROM mailbox_routes WHERE user_id=(SELECT user_id FROM emails WHERE id=OLD.email_id) AND state!='d1' AND purge_legacy=0)
BEGIN SELECT RAISE(ABORT,'Mailbox maintenance: legacy writes are frozen'); END;

CREATE TABLE mailbox_forwarding_snapshots (
 snapshot_key TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
