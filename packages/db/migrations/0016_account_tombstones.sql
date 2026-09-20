-- Tombstones for purged accounts (§5.6 step 5), with the digest copied from account_deletions.
CREATE TABLE account_tombstones (
  user_id TEXT PRIMARY KEY NOT NULL,
  email_digest TEXT NOT NULL,
  digest_version INTEGER NOT NULL CHECK (digest_version >= 1),
  deleted_at INTEGER NOT NULL
) STRICT;

CREATE INDEX account_tombstones_email ON account_tombstones (email_digest);
