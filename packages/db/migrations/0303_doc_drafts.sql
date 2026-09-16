-- The editor's unsaved buffer per user and task (§9.3): an encrypted field envelope written on a
-- throttle and kept when a save conflicts, so typed text is never lost. A draft never creates a
-- commit; `client_seq` orders writes from one editor so an older write never replaces a newer one.
CREATE TABLE doc_drafts (
  owner_id TEXT NOT NULL REFERENCES users (id),
  task_id TEXT NOT NULL,
  -- The published revision the draft was typed against; NULL for a document with no commits yet.
  base_commit_id TEXT
    CHECK (base_commit_id IS NULL OR (length(base_commit_id) = 40 AND base_commit_id NOT GLOB '*[^0-9a-f]*')),
  client_seq INTEGER NOT NULL CHECK (client_seq >= 0),
  draft_enc TEXT NOT NULL,
  draft_bytes INTEGER NOT NULL CHECK (draft_bytes >= 0),
  -- 'editor' for autosaved drafts, 'conflict' for a candidate preserved by a conflicting save.
  origin TEXT NOT NULL CHECK (origin IN ('editor', 'conflict')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, task_id),
  FOREIGN KEY (task_id, owner_id) REFERENCES tasks (id, owner_id)
) STRICT;
