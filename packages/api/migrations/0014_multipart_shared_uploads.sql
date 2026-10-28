-- Incomplete uploads are not downloadable or eligible for saving/sending.
-- Deleting abandoned shared_files cascades to these temporary records.
CREATE TABLE shared_uploads (
  share_id TEXT PRIMARY KEY REFERENCES shared_files(id) ON DELETE CASCADE,
  upload_id TEXT,
  status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','completing'))
);
CREATE TABLE shared_upload_parts (
  share_id TEXT NOT NULL REFERENCES shared_uploads(share_id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  PRIMARY KEY(share_id, part_number)
);
CREATE TRIGGER shared_upload_incomplete_guard BEFORE INSERT ON email_shared_files
WHEN EXISTS (SELECT 1 FROM shared_uploads WHERE share_id = NEW.share_id)
BEGIN
  SELECT RAISE(ABORT, 'Shared upload is unavailable; wait for the upload to finish');
END;
