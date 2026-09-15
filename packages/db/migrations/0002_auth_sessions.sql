-- Login sessions (§5.1): token digest and version, user, created, last seen (written at most every
-- 5 minutes), expiry and revocation.
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  token_digest TEXT NOT NULL UNIQUE,
  digest_version INTEGER NOT NULL CHECK (digest_version >= 1),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  write_id TEXT NOT NULL,
  CHECK (expires_at > created_at),
  CHECK (last_seen_at >= created_at)
) STRICT;

-- Revoke-all for a user and the gateway's periodic revocation check.
CREATE INDEX auth_sessions_user ON auth_sessions (user_id, revoked_at);
CREATE INDEX auth_sessions_expiry ON auth_sessions (expires_at);
