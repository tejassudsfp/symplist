-- Account deletion records (§5.6). The purge reads only this row and plaintext owner-scoped ids,
-- because the account key is already shredded. No foreign key: the row outlives the users row.
CREATE TABLE account_deletions (
  user_id TEXT PRIMARY KEY NOT NULL,
  -- Copied from users; cleared once PostHog reports the person deletion complete.
  analytics_id TEXT,
  -- 'account-tombstone' digest under OTP_DIGEST_SECRET_CURRENT, computed by the api.
  email_digest TEXT NOT NULL,
  email_digest_version INTEGER NOT NULL CHECK (email_digest_version >= 1),
  composio_user_id TEXT NOT NULL,
  r2_prefix TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  -- JSON array of finished purge step names.
  steps_done TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(steps_done) AND json_type(steps_done) = 'array'),
  analytics_deletion_requested_at INTEGER,
  analytics_deletion_completed_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  CHECK (composio_user_id = user_id),
  CHECK (r2_prefix = 'u/' || user_id || '/'),
  CHECK (status = 'pending' OR completed_at IS NOT NULL)
) STRICT;

CREATE INDEX account_deletions_status ON account_deletions (status, requested_at);
