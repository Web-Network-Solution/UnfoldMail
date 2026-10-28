export const REPORT_SCHEMA = `
CREATE TABLE IF NOT EXISTS mailbox_report_meta (since TEXT NOT NULL);
INSERT INTO mailbox_report_meta SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS(SELECT 1 FROM mailbox_report_meta);
CREATE TABLE IF NOT EXISTS mailbox_activity (email_id TEXT NOT NULL, direction TEXT NOT NULL, day TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(email_id,direction));
CREATE TABLE IF NOT EXISTS mailbox_activity_days(day TEXT PRIMARY KEY, sent INTEGER NOT NULL DEFAULT 0, received INTEGER NOT NULL DEFAULT 0, sent_bytes INTEGER NOT NULL DEFAULT 0, received_bytes INTEGER NOT NULL DEFAULT 0);
CREATE TRIGGER IF NOT EXISTS activity_count AFTER INSERT ON mailbox_activity BEGIN
 INSERT INTO mailbox_activity_days(day,sent,received,sent_bytes,received_bytes) VALUES(NEW.day,NEW.direction='sent',NEW.direction='received',(NEW.direction='sent')*NEW.bytes,(NEW.direction='received')*NEW.bytes)
 ON CONFLICT(day) DO UPDATE SET sent=sent+excluded.sent,received=received+excluded.received,sent_bytes=sent_bytes+excluded.sent_bytes,received_bytes=received_bytes+excluded.received_bytes;
END;
-- Existing retained messages are a best-effort baseline, not recovered deleted history.
INSERT OR IGNORE INTO mailbox_activity SELECT e.id,CASE WHEN f.type='sent' THEN 'sent' ELSE 'received' END,substr(e.received_at,1,10),COALESCE(e.size,0) FROM emails e JOIN folders f ON f.id=e.folder_id WHERE f.type IN ('inbox','sent') AND (e.delivery_status IS NULL OR e.delivery_status='sent');
CREATE TRIGGER IF NOT EXISTS activity_receive AFTER INSERT ON emails WHEN NEW.delivery_status IS NULL AND (SELECT type FROM folders WHERE id=NEW.folder_id) NOT IN ('drafts','sent') BEGIN
 INSERT OR IGNORE INTO mailbox_activity VALUES(NEW.id,'received',substr(NEW.received_at,1,10),COALESCE(NEW.size,0));
END;
CREATE TRIGGER IF NOT EXISTS activity_sent_insert AFTER INSERT ON emails WHEN NEW.delivery_status='sent' BEGIN
 INSERT OR IGNORE INTO mailbox_activity VALUES(NEW.id,'sent',substr(NEW.received_at,1,10),COALESCE(NEW.size,0));
END;
CREATE TRIGGER IF NOT EXISTS activity_sent_update AFTER UPDATE OF delivery_status ON emails WHEN NEW.delivery_status='sent' BEGIN
 INSERT OR IGNORE INTO mailbox_activity VALUES(NEW.id,'sent',strftime('%Y-%m-%d','now'),COALESCE(NEW.size,0));
END;
`;
