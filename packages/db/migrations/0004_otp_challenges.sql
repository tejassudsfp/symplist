-- OTP challenges (§5.1): a code digest bound to challenge id and purpose, 10-minute expiry, bounded
-- attempts, consumption by one conditional update, and a resend that supersedes the live challenge.
CREATE TABLE otp_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'signup', 'vault_reset', 'account_delete')),
  -- vault_reset and account_delete challenges are bound to the auth session that requested them.
  auth_session_id TEXT REFERENCES auth_sessions (id),
  code_digest TEXT NOT NULL,
  digest_version INTEGER NOT NULL CHECK (digest_version >= 1),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  superseded_at INTEGER,
  write_id TEXT NOT NULL,
  CHECK (expires_at > created_at),
  CHECK (purpose IN ('login', 'signup') OR auth_session_id IS NOT NULL),
  CHECK (consumed_at IS NULL OR superseded_at IS NULL)
) STRICT;

-- At most one live challenge per user and purpose: a resend supersedes the previous challenge in
-- the same batch that inserts the new one.
CREATE UNIQUE INDEX otp_challenges_live ON otp_challenges (user_id, purpose)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;
-- Resend cooldown: the latest challenge per user and purpose.
CREATE INDEX otp_challenges_recent ON otp_challenges (user_id, purpose, created_at);
CREATE INDEX otp_challenges_expiry ON otp_challenges (expires_at);
