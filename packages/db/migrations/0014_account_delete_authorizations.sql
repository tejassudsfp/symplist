-- Single-use account deletion authorizations (§5.1, §5.6): issued by a verified account_delete OTP,
-- valid for 10 minutes, bound to the user and auth session.
CREATE TABLE account_delete_authorizations (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  auth_session_id TEXT NOT NULL REFERENCES auth_sessions (id),
  -- One authorization per verified challenge.
  challenge_id TEXT NOT NULL UNIQUE REFERENCES otp_challenges (id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  write_id TEXT NOT NULL,
  CHECK (expires_at > created_at)
) STRICT;

CREATE INDEX account_delete_authorizations_user ON account_delete_authorizations (user_id, auth_session_id);
