-- Table rebuilds in the historical role migration removed these indexes.
CREATE INDEX IF NOT EXISTS idx_emails_user_folder ON emails(user_id, folder_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id, received_at ASC);
CREATE INDEX IF NOT EXISTS idx_emails_user_unread ON emails(user_id, is_read, folder_id);
CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
CREATE INDEX IF NOT EXISTS idx_emails_archived ON emails(user_id, is_archived);
CREATE INDEX IF NOT EXISTS idx_emails_trashed_at ON emails(trashed_at);
CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id);
CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments(email_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
