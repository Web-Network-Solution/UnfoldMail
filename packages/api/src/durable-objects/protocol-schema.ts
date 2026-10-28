/** Additive mailbox migration. UIDs never reuse deleted values. Folder moves get new UIDs. */
export const PROTOCOL_SCHEMA = String.raw`
CREATE TABLE IF NOT EXISTS protocol_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
INSERT OR IGNORE INTO protocol_state(id,revision) VALUES(1,1);
CREATE TABLE IF NOT EXISTS protocol_messages (
 uid INTEGER PRIMARY KEY AUTOINCREMENT CHECK(uid < 4294967295),
 email_id TEXT NOT NULL UNIQUE REFERENCES emails(id) ON DELETE CASCADE,
 answered INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
 draft INTEGER NOT NULL DEFAULT 0, raw_size INTEGER
);
CREATE TABLE IF NOT EXISTS protocol_imports (
 request_id TEXT PRIMARY KEY, email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS protocol_notices (
 email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE, status TEXT NOT NULL, PRIMARY KEY(email_id,status)
);
CREATE TABLE IF NOT EXISTS protocol_subscriptions (
 folder_id TEXT PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
 subscribed INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO protocol_messages(email_id)
 SELECT id FROM emails ORDER BY received_at,id;
CREATE TRIGGER IF NOT EXISTS protocol_email_insert AFTER INSERT ON emails BEGIN
 INSERT INTO protocol_messages(email_id) VALUES(NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS protocol_email_move AFTER UPDATE OF folder_id,r2_body_key,message_id ON emails
 WHEN OLD.folder_id != NEW.folder_id OR OLD.r2_body_key != NEW.r2_body_key OR OLD.message_id IS NOT NEW.message_id BEGIN
 UPDATE protocol_messages SET uid=(SELECT seq+1 FROM sqlite_sequence WHERE name='protocol_messages'),deleted=0,raw_size=NULL WHERE email_id=NEW.id;
 UPDATE sqlite_sequence SET seq=(SELECT MAX(uid) FROM protocol_messages) WHERE name='protocol_messages';
END;

CREATE TRIGGER IF NOT EXISTS protocol_revision_insert AFTER INSERT ON emails BEGIN UPDATE protocol_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS protocol_revision_update AFTER UPDATE ON emails BEGIN UPDATE protocol_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS protocol_revision_delete AFTER DELETE ON emails BEGIN UPDATE protocol_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS protocol_revision_folder_insert AFTER INSERT ON folders BEGIN UPDATE protocol_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS protocol_revision_folder_update AFTER UPDATE ON folders BEGIN UPDATE protocol_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS protocol_revision_folder_delete AFTER DELETE ON folders BEGIN UPDATE protocol_state SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS protocol_revision_flags AFTER UPDATE OF answered,deleted,draft ON protocol_messages BEGIN UPDATE protocol_state SET revision=revision+1 WHERE id=1; END;
`;

/** v5: cleanup intents are independent of email rows and survive deletion/crashes. */
export const PROTOCOL_CLEANUP_SCHEMA = String.raw`
CREATE TABLE IF NOT EXISTS protocol_object_gc (
 id TEXT PRIMARY KEY, email_id TEXT NOT NULL, keys_json TEXT NOT NULL,
 not_before TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','deleting'))
);
CREATE INDEX IF NOT EXISTS protocol_object_gc_due ON protocol_object_gc(not_before);
`;


/** v6: bounded mailbox change journal for incremental IMAP synchronization. */
export const PROTOCOL_CHANGES_SCHEMA = String.raw`
CREATE TABLE IF NOT EXISTS protocol_changes (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, email_id TEXT, folder_id TEXT
);
INSERT INTO protocol_changes(email_id,folder_id) SELECT NULL,NULL WHERE NOT EXISTS(SELECT 1 FROM protocol_changes);
CREATE TRIGGER IF NOT EXISTS protocol_changes_bound AFTER INSERT ON protocol_changes BEGIN
 DELETE FROM protocol_changes WHERE seq<NEW.seq-10000;
END;
CREATE TRIGGER IF NOT EXISTS protocol_changes_insert AFTER INSERT ON emails BEGIN
 INSERT INTO protocol_changes(email_id,folder_id) VALUES(NEW.id,NEW.folder_id);
END;
CREATE TRIGGER IF NOT EXISTS protocol_changes_update AFTER UPDATE ON emails BEGIN
 INSERT INTO protocol_changes(email_id,folder_id) VALUES(OLD.id,OLD.folder_id);
 INSERT INTO protocol_changes(email_id,folder_id) SELECT NEW.id,NEW.folder_id WHERE NEW.folder_id!=OLD.folder_id;
END;
CREATE TRIGGER IF NOT EXISTS protocol_changes_delete AFTER DELETE ON emails BEGIN
 INSERT INTO protocol_changes(email_id,folder_id) VALUES(OLD.id,OLD.folder_id);
END;
CREATE TRIGGER IF NOT EXISTS protocol_changes_flags AFTER UPDATE OF uid,answered,deleted,draft ON protocol_messages
 WHEN OLD.uid!=NEW.uid OR OLD.answered!=NEW.answered OR OLD.deleted!=NEW.deleted OR OLD.draft!=NEW.draft BEGIN
 INSERT INTO protocol_changes(email_id,folder_id) SELECT NEW.email_id,folder_id FROM emails WHERE id=NEW.email_id;
END;
CREATE TRIGGER IF NOT EXISTS protocol_changes_folder_insert AFTER INSERT ON folders BEGIN
 INSERT INTO protocol_changes(email_id,folder_id) VALUES(NULL,NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS protocol_changes_folder_update AFTER UPDATE ON folders BEGIN
 INSERT INTO protocol_changes(email_id,folder_id) VALUES(NULL,NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS protocol_changes_folder_delete AFTER DELETE ON folders BEGIN
 INSERT INTO protocol_changes(email_id,folder_id) VALUES(NULL,OLD.id);
END;
`;
