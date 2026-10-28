-- Existing accounts must be migrated before deploying the dedicated-only Worker.
-- New accounts are explicitly marked for idempotent provisioning; a missing
-- route for an old account must never create an empty replacement mailbox.
CREATE TABLE dedicated_rollout_guard (ready INTEGER CHECK(ready=1));
INSERT INTO dedicated_rollout_guard SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM users u LEFT JOIN mailbox_routes r ON r.user_id=u.id
  WHERE r.state IS NULL OR r.state!='active'
) THEN 1 ELSE 0 END;
DROP TABLE dedicated_rollout_guard;
ALTER TABLE mailbox_routes ADD COLUMN provision_new INTEGER NOT NULL DEFAULT 0 CHECK(provision_new IN (0,1));
CREATE TRIGGER provision_new_mailbox AFTER INSERT ON users
BEGIN
  INSERT INTO mailbox_routes(user_id,state,provision_new) VALUES(NEW.id,'copying',1);
END;
