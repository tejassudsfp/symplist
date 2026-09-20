-- Idempotent document write requests (§9.2, note 11 step 1): a scoped request id (the save's
-- Idempotency-Key, Simon's tool call id, or an MCP request id) with a protected fingerprint of the
-- input, recorded in the publication batch. An exact retry returns the recorded publication; the same
-- id with other input is refused. The fingerprint is a field envelope of the input digest, so it
-- reveals nothing about the content without the account key.
CREATE TABLE doc_publish_requests (
  owner_id TEXT NOT NULL REFERENCES users (id),
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 160 AND scope NOT GLOB '*[^A-Za-z0-9:_-]*'),
  request_id TEXT NOT NULL
    CHECK (length(request_id) BETWEEN 1 AND 128 AND request_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
  task_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('published')),
  fingerprint_enc TEXT NOT NULL,
  base_commit_id TEXT,
  commit_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  -- JSON array of the opaque section ids the publication added or modified.
  changed_section_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changed_section_ids)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, scope, request_id),
  FOREIGN KEY (task_id, commit_id) REFERENCES doc_commits (task_id, commit_id),
  CHECK (expires_at > created_at)
) STRICT;

-- Expired requests are removed in bounded batches; purge and orphan checks read by task.
CREATE INDEX doc_publish_requests_expiry ON doc_publish_requests (expires_at);
CREATE INDEX doc_publish_requests_task ON doc_publish_requests (task_id);
