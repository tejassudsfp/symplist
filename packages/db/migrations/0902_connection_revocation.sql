-- A reconnect is bound to the exact connection version shown to the owner.
ALTER TABLE connection_attempts ADD COLUMN replaces_generation INTEGER;

-- Provider cleanup is durable even when the API loses its response or shuts down after native
-- authority was revoked. Contains only ids, lease state and counters; never OAuth credentials.
CREATE TABLE connection_revoke_jobs (
  connected_account_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  write_id TEXT NOT NULL
) STRICT;
CREATE INDEX connection_revoke_jobs_due ON connection_revoke_jobs (lease_until, created_at);
