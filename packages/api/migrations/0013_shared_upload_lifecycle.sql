-- Existing links cannot be proven abandoned. Preserve them, including uploads
-- from older Worker versions that do not explicitly opt into staging.
ALTER TABLE shared_files ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'retained'
  CHECK(lifecycle IN ('staged', 'retained', 'deleting'));
CREATE INDEX idx_shared_files_cleanup ON shared_files(lifecycle, created_at);

CREATE TABLE email_shared_files (
  email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  share_id TEXT NOT NULL REFERENCES shared_files(id) ON DELETE CASCADE,
  PRIMARY KEY(email_id, share_id)
);
CREATE INDEX idx_email_shared_files_share ON email_shared_files(share_id);

-- Serialize draft/send references against the cleanup claim. If cleanup won,
-- the complete email transaction must roll back rather than save a broken link.
CREATE TRIGGER shared_file_reference_guard BEFORE INSERT ON email_shared_files
WHEN NOT EXISTS (SELECT 1 FROM shared_files WHERE id = NEW.share_id AND lifecycle != 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'Shared upload is unavailable; upload the file again');
END;
