-- Invalidate only transient OAuth flows created by the old handoff protocol.
DELETE FROM flows;
DELETE FROM grants;
ALTER TABLE flows ADD COLUMN installation TEXT;
ALTER TABLE flows ADD COLUMN email_domain TEXT;
ALTER TABLE grants ADD COLUMN delivery_hash TEXT;
