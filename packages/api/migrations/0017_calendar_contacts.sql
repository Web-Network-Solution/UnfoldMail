-- Additive migration: existing users, mail, attachments, and folders are untouched.
CREATE TABLE contacts (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE, phone TEXT NOT NULL DEFAULT '',
 company TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', groups_json TEXT NOT NULL DEFAULT '[]',
 revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
 UNIQUE(user_id,email)
);
CREATE INDEX contacts_owner_name ON contacts(user_id,name,id);
CREATE TABLE calendar_events (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 uid TEXT NOT NULL, organizer TEXT NOT NULL COLLATE NOCASE, title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
 start_at TEXT NOT NULL, end_at TEXT NOT NULL, series_end_at TEXT NOT NULL, timezone TEXT NOT NULL,
 all_day INTEGER NOT NULL DEFAULT 0, recurrence TEXT NOT NULL DEFAULT '',
 excluded_dates TEXT NOT NULL DEFAULT '[]', reminder_minutes INTEGER,
 next_reminder_at TEXT, revision INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','cancelled')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, mutation_id TEXT NOT NULL DEFAULT '', UNIQUE(owner_id,uid)
);
CREATE INDEX calendar_owner_range ON calendar_events(owner_id,start_at,end_at);
CREATE TRIGGER calendar_event_limit BEFORE INSERT ON calendar_events
WHEN (SELECT COUNT(*) FROM calendar_events WHERE owner_id=NEW.owner_id)>=5000
BEGIN SELECT RAISE(ABORT,'Calendar limit is 5000 events'); END;
CREATE INDEX calendar_reminders ON calendar_events(next_reminder_at) WHERE next_reminder_at IS NOT NULL AND status='confirmed';
CREATE TABLE calendar_attendees (
 event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
 email TEXT NOT NULL COLLATE NOCASE,
 response TEXT NOT NULL DEFAULT 'needs-action' CHECK(response IN ('needs-action','accepted','tentative','declined')),
 token_hash TEXT NOT NULL UNIQUE,
 PRIMARY KEY(event_id,email)
);
CREATE INDEX calendar_attendee_email ON calendar_attendees(email,event_id);
CREATE TABLE calendar_deliveries (
 id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, recipient TEXT NOT NULL,
 kind TEXT NOT NULL, payload TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed','uncertain','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
 error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sent_copy_saved INTEGER NOT NULL DEFAULT 0,
 dedupe_key TEXT NOT NULL UNIQUE
);
CREATE INDEX calendar_delivery_due ON calendar_deliveries(status,next_attempt_at);
