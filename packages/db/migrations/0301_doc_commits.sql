-- The published commit index (§9.2, note 11 "D1: publication and metadata"): one row per commit
-- published to a task's main branch, inserted in the same batch as the head update that published it
-- and never changed. Rows agree with the reachable commits of the head bundle; every row has an
-- immutable encrypted head snapshot.
CREATE TABLE doc_commits (
  task_id TEXT NOT NULL REFERENCES doc_repos (task_id),
  commit_id TEXT NOT NULL CHECK (length(commit_id) = 40 AND commit_id NOT GLOB '*[^0-9a-f]*'),
  owner_id TEXT NOT NULL REFERENCES users (id),
  parent_commit_id TEXT
    CHECK (parent_commit_id IS NULL OR (length(parent_commit_id) = 40 AND parent_commit_id NOT GLOB '*[^0-9a-f]*')),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  author TEXT NOT NULL CHECK (author IN ('user', 'simon', 'mcp')),
  kind TEXT NOT NULL CHECK (kind IN ('create', 'edit', 'normalization', 'restore')),
  restored_from_commit_id TEXT
    CHECK (restored_from_commit_id IS NULL OR (length(restored_from_commit_id) = 40 AND restored_from_commit_id NOT GLOB '*[^0-9a-f]*')),
  -- The bundle published with this commit (it contains the full history up to the commit).
  bundle_key TEXT NOT NULL CHECK (length(bundle_key) BETWEEN 1 AND 1024),
  snapshot_key TEXT NOT NULL CHECK (length(snapshot_key) BETWEEN 1 AND 1024),
  document_bytes INTEGER NOT NULL CHECK (document_bytes >= 0),
  format_version INTEGER NOT NULL CHECK (format_version >= 1),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  -- The Git commit date (whole seconds, in milliseconds) and the publication time.
  committed_at INTEGER NOT NULL,
  published_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, commit_id),
  UNIQUE (task_id, generation),
  CHECK ((generation = 1) = (parent_commit_id IS NULL)),
  CHECK ((kind = 'create') = (generation = 1)),
  CHECK ((kind = 'restore') = (restored_from_commit_id IS NOT NULL))
) STRICT;

-- Purge deletes by owner; orphan collection checks whether an object is still referenced.
CREATE INDEX doc_commits_owner ON doc_commits (owner_id);
CREATE INDEX doc_commits_bundle ON doc_commits (bundle_key);
CREATE INDEX doc_commits_snapshot ON doc_commits (snapshot_key);
