-- Maintain summaries on writes so opening a folder does not group its entire email history.
CREATE TABLE mailbox_threads (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
CREATE INDEX idx_mailbox_threads_page ON mailbox_threads(user_id, folder_id, last_message_at DESC, thread_id DESC);
CREATE INDEX idx_mailbox_threads_all ON mailbox_threads(user_id, last_message_at DESC);
CREATE INDEX idx_email_thread_summary ON emails(user_id, folder_id, thread_id, received_at DESC, id DESC);

CREATE TRIGGER email_thread_insert AFTER INSERT ON emails BEGIN
DELETE FROM mailbox_threads WHERE user_id = NEW.user_id AND folder_id = NEW.folder_id AND thread_id = NEW.thread_id;
 INSERT INTO mailbox_threads
 SELECT e.user_id, e.folder_id, e.thread_id,
  (SELECT x.id FROM emails x WHERE x.user_id = e.user_id AND x.folder_id = e.folder_id AND x.thread_id = e.thread_id ORDER BY x.received_at DESC, x.id DESC LIMIT 1),
  MAX(e.received_at), COUNT(*), SUM(CASE WHEN e.is_read = 0 THEN 1 ELSE 0 END), MAX(e.has_attachments), GROUP_CONCAT(DISTINCT e.sender)
 FROM emails e WHERE e.user_id = NEW.user_id AND e.folder_id = NEW.folder_id AND e.thread_id = NEW.thread_id
 GROUP BY e.user_id, e.folder_id, e.thread_id;
END;

CREATE TRIGGER email_thread_delete AFTER DELETE ON emails BEGIN
DELETE FROM mailbox_threads WHERE user_id = OLD.user_id AND folder_id = OLD.folder_id AND thread_id = OLD.thread_id;
 INSERT INTO mailbox_threads
 SELECT e.user_id, e.folder_id, e.thread_id,
  (SELECT x.id FROM emails x WHERE x.user_id = e.user_id AND x.folder_id = e.folder_id AND x.thread_id = e.thread_id ORDER BY x.received_at DESC, x.id DESC LIMIT 1),
  MAX(e.received_at), COUNT(*), SUM(CASE WHEN e.is_read = 0 THEN 1 ELSE 0 END), MAX(e.has_attachments), GROUP_CONCAT(DISTINCT e.sender)
 FROM emails e WHERE e.user_id = OLD.user_id AND e.folder_id = OLD.folder_id AND e.thread_id = OLD.thread_id
 GROUP BY e.user_id, e.folder_id, e.thread_id;
END;

CREATE TRIGGER email_thread_update AFTER UPDATE OF folder_id, thread_id, user_id, received_at, is_read, has_attachments, sender ON emails BEGIN
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

INSERT INTO mailbox_threads
 SELECT e.user_id, e.folder_id, e.thread_id,
 (SELECT x.id FROM emails x WHERE x.user_id = e.user_id AND x.folder_id = e.folder_id AND x.thread_id = e.thread_id ORDER BY x.received_at DESC, x.id DESC LIMIT 1),
 MAX(e.received_at), COUNT(*), SUM(CASE WHEN e.is_read = 0 THEN 1 ELSE 0 END), MAX(e.has_attachments), GROUP_CONCAT(DISTINCT e.sender)
 FROM emails e GROUP BY e.user_id, e.folder_id, e.thread_id;
