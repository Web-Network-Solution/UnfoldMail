-- 0005 rebuilt sessions without idx_sessions_expires and 0011 restored only
-- idx_sessions_user, so the 15-minute expired-session purge scanned the table.
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
