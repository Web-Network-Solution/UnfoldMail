-- Transaction-local assertion rows. A failed draft compare-and-swap aborts the
-- entire D1 batch, including attachments, search and shared-file references.
CREATE TABLE mailbox_write_guard (valid INTEGER NOT NULL CHECK(valid=1));

-- No user foreign key: recovery must outlive deletion of the account.
CREATE TABLE mailbox_deletions (
  user_id TEXT PRIMARY KEY,
  prefix_index INTEGER NOT NULL DEFAULT -1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
