-- Existing uploads retain the original 8 MiB part size.
ALTER TABLE shared_uploads ADD COLUMN part_size INTEGER NOT NULL DEFAULT 8388608
  CHECK(part_size IN (5242880,8388608,16777216,33554432));
