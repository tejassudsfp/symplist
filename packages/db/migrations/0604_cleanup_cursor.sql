-- One bounded artifact object page per hourly pass; retained across task-process restarts.
CREATE TABLE cleanup_cursors (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  object_cursor TEXT,
  lease_token TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  write_id TEXT NOT NULL
) STRICT;
