-- Accounts and their independent access fields (architecture §5.4), deletion state (§5.6) and
-- analytics consent (§15). Emails are plaintext operational metadata (§4.4); display names are
-- encrypted field envelopes.
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 320 AND instr(email, '@') > 1),
  display_name_enc TEXT,
  email_verified_at INTEGER,
  beta_state TEXT NOT NULL DEFAULT 'locked' CHECK (beta_state IN ('locked', 'unlocked', 'relocked')),
  suspended_at INTEGER,
  onboarding_step TEXT NOT NULL DEFAULT 'name' CHECK (onboarding_step IN ('name', 'connections', 'done')),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  -- Incremented by every restriction and restore; carried by access caches (§3.3).
  access_generation INTEGER NOT NULL DEFAULT 0 CHECK (access_generation >= 0),
  -- Incremented by Restore eligibility so a new invite can be redeemed (§5.4).
  access_epoch INTEGER NOT NULL DEFAULT 0 CHECK (access_epoch >= 0),
  deletion_state TEXT NOT NULL DEFAULT 'none' CHECK (deletion_state IN ('none', 'deleting')),
  deletion_requested_at INTEGER,
  analytics_consent TEXT NOT NULL DEFAULT 'unset' CHECK (analytics_consent IN ('unset', 'granted', 'denied')),
  analytics_consent_at INTEGER,
  -- Random, never derived from identity and never reused (decision R9).
  analytics_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  CHECK (deletion_state = 'none' OR deletion_requested_at IS NOT NULL),
  CHECK (analytics_consent = 'unset' OR analytics_consent_at IS NOT NULL)
) STRICT;

-- Admin bootstrap checks that no admin exists (§5.7).
CREATE INDEX users_admins ON users (role) WHERE role = 'admin';
-- Admin account lists by access state.
CREATE INDEX users_beta_state ON users (beta_state, created_at);
