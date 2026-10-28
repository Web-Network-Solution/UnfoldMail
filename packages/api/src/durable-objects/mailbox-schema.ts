// Mailbox schema for new mailboxes: v1 plus the v2 write guard. Later versions
// (v3 ai_candidates onward) are applied in order by MailboxDO; keep them there.
export const MAILBOX_SCHEMA = String.raw`
CREATE TABLE IF NOT EXISTS mailbox_write_guard (valid INTEGER NOT NULL CHECK(valid=1));
CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
    email_id UNINDEXED,
    user_id UNINDEXED,
    subject,
    sender,
    snippet,
    tokenize = 'unicode61'
);
CREATE TABLE IF NOT EXISTS processed_inbound (
    message_key TEXT NOT NULL,
    user_id TEXT NOT NULL,
    email_id TEXT NOT NULL,
    processed_at TEXT NOT NULL,
    PRIMARY KEY (message_key, user_id)
);
CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'custom' CHECK(type IN ('inbox', 'sent', 'drafts', 'trash', 'archive', 'custom')),
    created_at TEXT DEFAULT (datetime('now')),

    UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS emails (
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
    trashed_at TEXT, references_chain TEXT, delivery_status TEXT, delivery_error TEXT,
    FOREIGN KEY(folder_id) REFERENCES folders(id)
);
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    email_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    r2_key TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')), content_id TEXT, disposition TEXT NOT NULL DEFAULT 'attachment',
    FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS outbound_jobs (
  email_id TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL ,
  payload TEXT NOT NULL,
  request_id TEXT,
  source_draft_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mailbox_threads (
 user_id TEXT NOT NULL ,
 folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
 thread_id TEXT NOT NULL,
 latest_email_id TEXT NOT NULL,
 last_message_at TEXT NOT NULL,
 message_count INTEGER NOT NULL,
 unread_count INTEGER NOT NULL,
 has_attachments INTEGER NOT NULL,
 participants TEXT NOT NULL,
 PRIMARY KEY (user_id, folder_id, thread_id)
);
CREATE TABLE IF NOT EXISTS email_shared_files (
  email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  share_id TEXT NOT NULL ,
  PRIMARY KEY(email_id, share_id)
);
CREATE TABLE IF NOT EXISTS forwarding_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT ,
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
CREATE INDEX IF NOT EXISTS idx_processed_inbound_at ON processed_inbound(processed_at);
CREATE INDEX IF NOT EXISTS idx_emails_archive_scan ON emails(is_archived, received_at);
CREATE INDEX IF NOT EXISTS idx_attachments_disposition ON attachments(email_id, disposition);
CREATE INDEX IF NOT EXISTS idx_attachments_created_at ON attachments(created_at);
CREATE INDEX IF NOT EXISTS idx_emails_received_at ON emails(received_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_request ON outbound_jobs(user_id, request_id);
CREATE INDEX IF NOT EXISTS idx_outbound_due ON outbound_jobs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbound_user ON outbound_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_emails_thread_page ON emails(user_id, thread_id, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_emails_folder_unread ON emails(user_id, folder_id, is_read);
CREATE INDEX IF NOT EXISTS idx_mailbox_threads_page ON mailbox_threads(user_id, folder_id, last_message_at DESC, thread_id DESC);
CREATE INDEX IF NOT EXISTS idx_mailbox_threads_all ON mailbox_threads(user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_thread_summary ON emails(user_id, folder_id, thread_id, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_emails_user_folder ON emails(user_id, folder_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id, received_at ASC);
CREATE INDEX IF NOT EXISTS idx_emails_user_unread ON emails(user_id, is_read, folder_id);
CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
CREATE INDEX IF NOT EXISTS idx_emails_archived ON emails(user_id, is_archived);
CREATE INDEX IF NOT EXISTS idx_emails_trashed_at ON emails(trashed_at);
CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id);
CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments(email_id);
CREATE INDEX IF NOT EXISTS idx_email_shared_files_share ON email_shared_files(share_id);
CREATE INDEX IF NOT EXISTS idx_forwarding_due ON forwarding_jobs(status,next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_forwarding_user ON forwarding_jobs(user_id,created_at);
CREATE INDEX IF NOT EXISTS idx_forwarding_snapshot ON forwarding_jobs(snapshot_key);
CREATE INDEX IF NOT EXISTS idx_forwarding_updated ON forwarding_jobs(status,updated_at);
CREATE TRIGGER IF NOT EXISTS email_thread_insert AFTER INSERT ON emails BEGIN
DELETE FROM mailbox_threads WHERE user_id = NEW.user_id AND folder_id = NEW.folder_id AND thread_id = NEW.thread_id;
 INSERT INTO mailbox_threads
 SELECT e.user_id, e.folder_id, e.thread_id,
  (SELECT x.id FROM emails x WHERE x.user_id = e.user_id AND x.folder_id = e.folder_id AND x.thread_id = e.thread_id ORDER BY x.received_at DESC, x.id DESC LIMIT 1),
  MAX(e.received_at), COUNT(*), SUM(CASE WHEN e.is_read = 0 THEN 1 ELSE 0 END), MAX(e.has_attachments), GROUP_CONCAT(DISTINCT e.sender)
 FROM emails e WHERE e.user_id = NEW.user_id AND e.folder_id = NEW.folder_id AND e.thread_id = NEW.thread_id
 GROUP BY e.user_id, e.folder_id, e.thread_id;
END;
CREATE TRIGGER IF NOT EXISTS email_thread_delete AFTER DELETE ON emails BEGIN
DELETE FROM mailbox_threads WHERE user_id = OLD.user_id AND folder_id = OLD.folder_id AND thread_id = OLD.thread_id;
 INSERT INTO mailbox_threads
 SELECT e.user_id, e.folder_id, e.thread_id,
  (SELECT x.id FROM emails x WHERE x.user_id = e.user_id AND x.folder_id = e.folder_id AND x.thread_id = e.thread_id ORDER BY x.received_at DESC, x.id DESC LIMIT 1),
  MAX(e.received_at), COUNT(*), SUM(CASE WHEN e.is_read = 0 THEN 1 ELSE 0 END), MAX(e.has_attachments), GROUP_CONCAT(DISTINCT e.sender)
 FROM emails e WHERE e.user_id = OLD.user_id AND e.folder_id = OLD.folder_id AND e.thread_id = OLD.thread_id
 GROUP BY e.user_id, e.folder_id, e.thread_id;
END;
CREATE TRIGGER IF NOT EXISTS email_thread_update AFTER UPDATE OF folder_id, thread_id, user_id, received_at, is_read, has_attachments, sender ON emails BEGIN
DELETE FROM mailbox_threads WHERE user_id = OLD.user_id AND folder_id = OLD.folder_id AND thread_id = OLD.thread_id;
 INSERT INTO mailbox_threads
 SELECT e.user_id, e.folder_id, e.thread_id,
  (SELECT x.id FROM emails x WHERE x.user_id = e.user_id AND x.folder_id = e.folder_id AND x.thread_id = e.thread_id ORDER BY x.received_at DESC, x.id DESC LIMIT 1),
  MAX(e.received_at), COUNT(*), SUM(CASE WHEN e.is_read = 0 THEN 1 ELSE 0 END), MAX(e.has_attachments), GROUP_CONCAT(DISTINCT e.sender)
 FROM emails e WHERE e.user_id = OLD.user_id AND e.folder_id = OLD.folder_id AND e.thread_id = OLD.thread_id
 GROUP BY e.user_id, e.folder_id, e.thread_id;
DELETE FROM mailbox_threads WHERE user_id = NEW.user_id AND folder_id = NEW.folder_id AND thread_id = NEW.thread_id;
 INSERT INTO mailbox_threads
 SELECT e.user_id, e.folder_id, e.thread_id,
  (SELECT x.id FROM emails x WHERE x.user_id = e.user_id AND x.folder_id = e.folder_id AND x.thread_id = e.thread_id ORDER BY x.received_at DESC, x.id DESC LIMIT 1),
  MAX(e.received_at), COUNT(*), SUM(CASE WHEN e.is_read = 0 THEN 1 ELSE 0 END), MAX(e.has_attachments), GROUP_CONCAT(DISTINCT e.sender)
 FROM emails e WHERE e.user_id = NEW.user_id AND e.folder_id = NEW.folder_id AND e.thread_id = NEW.thread_id
 GROUP BY e.user_id, e.folder_id, e.thread_id;
END;

CREATE TABLE IF NOT EXISTS mailbox_days(day TEXT PRIMARY KEY,n INTEGER NOT NULL DEFAULT 0,bytes INTEGER NOT NULL DEFAULT 0,sent INTEGER NOT NULL DEFAULT 0,received INTEGER NOT NULL DEFAULT 0,sent_bytes INTEGER NOT NULL DEFAULT 0,received_bytes INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS mailbox_attachment_days(day TEXT PRIMARY KEY,n INTEGER NOT NULL DEFAULT 0,bytes INTEGER NOT NULL DEFAULT 0);
CREATE TRIGGER IF NOT EXISTS mailbox_counter_emails_insert AFTER INSERT ON emails BEGIN
INSERT INTO mailbox_days(day,n,bytes,sent,sent_bytes,received,received_bytes) VALUES(substr(NEW.received_at,1,10),1,1*NEW.size,1*COALESCE((SELECT type='sent' FROM folders WHERE id=NEW.folder_id),0),(1*COALESCE((SELECT type='sent' FROM folders WHERE id=NEW.folder_id),0))*NEW.size,1*COALESCE((SELECT type='inbox' FROM folders WHERE id=NEW.folder_id),0),(1*COALESCE((SELECT type='inbox' FROM folders WHERE id=NEW.folder_id),0))*NEW.size) ON CONFLICT(day) DO UPDATE SET n=n+excluded.n,bytes=bytes+excluded.bytes,sent=sent+excluded.sent,sent_bytes=sent_bytes+excluded.sent_bytes,received=received+excluded.received,received_bytes=received_bytes+excluded.received_bytes;
END;
CREATE TRIGGER IF NOT EXISTS mailbox_counter_emails_update AFTER UPDATE ON emails BEGIN
INSERT INTO mailbox_days(day,n,bytes,sent,sent_bytes,received,received_bytes) VALUES(substr(OLD.received_at,1,10),-1,-1*OLD.size,-1*COALESCE((SELECT type='sent' FROM folders WHERE id=OLD.folder_id),0),(-1*COALESCE((SELECT type='sent' FROM folders WHERE id=OLD.folder_id),0))*OLD.size,-1*COALESCE((SELECT type='inbox' FROM folders WHERE id=OLD.folder_id),0),(-1*COALESCE((SELECT type='inbox' FROM folders WHERE id=OLD.folder_id),0))*OLD.size) ON CONFLICT(day) DO UPDATE SET n=n+excluded.n,bytes=bytes+excluded.bytes,sent=sent+excluded.sent,sent_bytes=sent_bytes+excluded.sent_bytes,received=received+excluded.received,received_bytes=received_bytes+excluded.received_bytes;
INSERT INTO mailbox_days(day,n,bytes,sent,sent_bytes,received,received_bytes) VALUES(substr(NEW.received_at,1,10),1,1*NEW.size,1*COALESCE((SELECT type='sent' FROM folders WHERE id=NEW.folder_id),0),(1*COALESCE((SELECT type='sent' FROM folders WHERE id=NEW.folder_id),0))*NEW.size,1*COALESCE((SELECT type='inbox' FROM folders WHERE id=NEW.folder_id),0),(1*COALESCE((SELECT type='inbox' FROM folders WHERE id=NEW.folder_id),0))*NEW.size) ON CONFLICT(day) DO UPDATE SET n=n+excluded.n,bytes=bytes+excluded.bytes,sent=sent+excluded.sent,sent_bytes=sent_bytes+excluded.sent_bytes,received=received+excluded.received,received_bytes=received_bytes+excluded.received_bytes;
END;
CREATE TRIGGER IF NOT EXISTS mailbox_counter_emails_delete AFTER DELETE ON emails BEGIN
INSERT INTO mailbox_days(day,n,bytes,sent,sent_bytes,received,received_bytes) VALUES(substr(OLD.received_at,1,10),-1,-1*OLD.size,-1*COALESCE((SELECT type='sent' FROM folders WHERE id=OLD.folder_id),0),(-1*COALESCE((SELECT type='sent' FROM folders WHERE id=OLD.folder_id),0))*OLD.size,-1*COALESCE((SELECT type='inbox' FROM folders WHERE id=OLD.folder_id),0),(-1*COALESCE((SELECT type='inbox' FROM folders WHERE id=OLD.folder_id),0))*OLD.size) ON CONFLICT(day) DO UPDATE SET n=n+excluded.n,bytes=bytes+excluded.bytes,sent=sent+excluded.sent,sent_bytes=sent_bytes+excluded.sent_bytes,received=received+excluded.received,received_bytes=received_bytes+excluded.received_bytes;
END;
CREATE TRIGGER IF NOT EXISTS mailbox_counter_attachments_insert AFTER INSERT ON attachments BEGIN
INSERT INTO mailbox_attachment_days(day,n,bytes) VALUES(substr(NEW.created_at,1,10),1,1*NEW.size) ON CONFLICT(day) DO UPDATE SET n=n+excluded.n,bytes=bytes+excluded.bytes;
END;
CREATE TRIGGER IF NOT EXISTS mailbox_counter_attachments_update AFTER UPDATE ON attachments BEGIN
INSERT INTO mailbox_attachment_days(day,n,bytes) VALUES(substr(OLD.created_at,1,10),-1,-1*OLD.size) ON CONFLICT(day) DO UPDATE SET n=n+excluded.n,bytes=bytes+excluded.bytes;
INSERT INTO mailbox_attachment_days(day,n,bytes) VALUES(substr(NEW.created_at,1,10),1,1*NEW.size) ON CONFLICT(day) DO UPDATE SET n=n+excluded.n,bytes=bytes+excluded.bytes;
END;
CREATE TRIGGER IF NOT EXISTS mailbox_counter_attachments_delete AFTER DELETE ON attachments BEGIN
INSERT INTO mailbox_attachment_days(day,n,bytes) VALUES(substr(OLD.created_at,1,10),-1,-1*OLD.size) ON CONFLICT(day) DO UPDATE SET n=n+excluded.n,bytes=bytes+excluded.bytes;
END;
`;
export const MAILBOX_TABLES = ["folders", "emails", "attachments", "processed_inbound", "outbound_jobs", "forwarding_jobs", "email_shared_files", "mailbox_threads", "emails_fts"] as const;
