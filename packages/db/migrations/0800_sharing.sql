CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('document', 'handoff')),
  title_enc TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  selection_json TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  request_id TEXT NOT NULL,
  fingerprint_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  write_id TEXT NOT NULL,
  UNIQUE (id, owner_id),
  UNIQUE (owner_id, request_id),
  FOREIGN KEY (task_id, owner_id) REFERENCES tasks(id, owner_id)
) STRICT;
CREATE INDEX artifacts_task ON artifacts(owner_id, task_id, created_at, id);

CREATE TABLE share_grants (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  artifact_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('link', 'password', 'public')),
  token_digest TEXT,
  token_version INTEGER,
  publication_id TEXT UNIQUE,
  password_hash TEXT,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'disabled')),
  disabled_reason TEXT,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  created_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  UNIQUE (id, owner_id),
  UNIQUE (token_digest, token_version),
  FOREIGN KEY (artifact_id, owner_id) REFERENCES artifacts(id, owner_id),
  CHECK ((mode = 'public' AND publication_id IS NOT NULL AND token_digest IS NULL AND token_version IS NULL AND password_hash IS NULL)
    OR (mode = 'link' AND publication_id IS NULL AND token_digest IS NOT NULL AND token_version IS NOT NULL AND password_hash IS NULL AND expires_at IS NOT NULL)
    OR (mode = 'password' AND publication_id IS NULL AND token_digest IS NOT NULL AND token_version IS NOT NULL AND password_hash IS NOT NULL AND expires_at IS NOT NULL))
) STRICT;
CREATE INDEX share_grants_artifact ON share_grants(owner_id, artifact_id, created_at, id);

CREATE TABLE share_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  grant_generation INTEGER NOT NULL,
  digest TEXT NOT NULL,
  digest_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  UNIQUE (digest, digest_version),
  FOREIGN KEY (grant_id, owner_id) REFERENCES share_grants(id, owner_id)
) STRICT;
CREATE INDEX share_sessions_grant ON share_sessions(grant_id, expires_at);

CREATE TABLE share_approvals (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  artifact_id TEXT NOT NULL,
  expected_head TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('link', 'password', 'public')),
  grant_expires_at INTEGER,
  password_required INTEGER NOT NULL CHECK (password_required IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'released', 'expired', 'dismissed')),
  request_id TEXT NOT NULL,
  fingerprint_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  UNIQUE(owner_id, request_id),
  FOREIGN KEY (artifact_id, owner_id) REFERENCES artifacts(id, owner_id)
) STRICT;

CREATE TABLE share_audit (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  artifact_id TEXT NOT NULL,
  grant_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('snapshot', 'release', 'revoke', 'password_changed', 'handoff')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (artifact_id, owner_id) REFERENCES artifacts(id, owner_id)
) STRICT;

CREATE TABLE share_limits (
  grant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  write_id TEXT NOT NULL,
  PRIMARY KEY (grant_id, bucket, window_start),
  FOREIGN KEY (grant_id, owner_id) REFERENCES share_grants(id, owner_id)
) STRICT;
