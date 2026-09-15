-- Durable OTP abuse limits (§5.1), keyed by HMAC(email) ('otp-limit-email' digest) and purpose:
-- challenges per hour and per 24 hours, failed verifications per 24 hours counted across all
-- challenges, and a lockout. Replacing a challenge never resets the failure count.
CREATE TABLE otp_limits (
  email_digest TEXT NOT NULL,
  digest_version INTEGER NOT NULL CHECK (digest_version >= 1),
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'signup', 'vault_reset', 'account_delete')),
  hour_window_start INTEGER NOT NULL,
  hour_challenges INTEGER NOT NULL DEFAULT 0 CHECK (hour_challenges >= 0),
  day_window_start INTEGER NOT NULL,
  day_challenges INTEGER NOT NULL DEFAULT 0 CHECK (day_challenges >= 0),
  failure_window_start INTEGER,
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  locked_until INTEGER,
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  PRIMARY KEY (email_digest, purpose),
  CHECK (failures = 0 OR failure_window_start IS NOT NULL)
) STRICT;

CREATE INDEX otp_limits_updated ON otp_limits (updated_at);
