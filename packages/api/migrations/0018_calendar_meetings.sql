-- Additive: existing events remain regular events; no mail or attachment changes.
ALTER TABLE calendar_events ADD COLUMN meeting_json TEXT NOT NULL DEFAULT 'null';
