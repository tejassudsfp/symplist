-- One private document repository per task (§9.2, note 11 "Repository boundary"), bound to the
-- immutable owner and task identity. The row is the publication authority: it names the published
-- head commit and the encrypted full bundle and head snapshot in R2, and every head change is one
-- conditional update guarded by head, generation and write id. Commit ids, generations, sizes and
-- opaque R2 keys are plaintext operational metadata (§4.4); document text, messages and authorship
-- details live only inside the encrypted bundle and snapshot.
CREATE TABLE doc_repos (
  task_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users (id),
  head_commit_id TEXT NOT NULL
    CHECK (length(head_commit_id) = 40 AND head_commit_id NOT GLOB '*[^0-9a-f]*'),
  -- Publication sequence: 1 for the first commit, + 1 for every publication.
  generation INTEGER NOT NULL CHECK (generation >= 1),
  -- Commits reachable from the head; verified against the reconstructed repository.
  commit_count INTEGER NOT NULL CHECK (commit_count >= 1),
  -- u/<ownerId>/bundles/<taskId>/<generation>-<bundle_write_id>.bundle.sym
  bundle_key TEXT NOT NULL CHECK (length(bundle_key) BETWEEN 1 AND 1024),
  bundle_write_id TEXT NOT NULL,
  bundle_bytes INTEGER NOT NULL CHECK (bundle_bytes >= 0),
  -- u/<ownerId>/docs/<taskId>/<head_commit_id>.md.sym
  snapshot_key TEXT NOT NULL CHECK (length(snapshot_key) BETWEEN 1 AND 1024),
  document_bytes INTEGER NOT NULL CHECK (document_bytes >= 0),
  head_author TEXT NOT NULL CHECK (head_author IN ('user', 'simon', 'mcp')),
  format_version INTEGER NOT NULL CHECK (format_version >= 1),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  FOREIGN KEY (task_id, owner_id) REFERENCES tasks (id, owner_id),
  -- History is linear and every publication adds exactly one commit.
  CHECK (commit_count = generation)
) STRICT;

-- The user topic snapshot reads the heads of an owner's open tasks (§7); purge deletes by owner.
CREATE INDEX doc_repos_owner ON doc_repos (owner_id, task_id);
