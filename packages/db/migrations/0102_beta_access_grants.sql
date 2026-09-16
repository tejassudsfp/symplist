-- Beta access grants (note 04, §5.4, §5.5): what admitted an account. Invite grants name their
-- redemption and campaign; admin grants (direct unlock, restore access, bootstrap) name the audit
-- event that recorded them. One current grant per account. Restrictions revoke current grants in the
-- restriction batch (a campaign revocation only that campaign's); nothing ever revives a grant. The
-- admin reason is encrypted under the account's key. Deleted with the account by the purge (§5.6).
CREATE TABLE beta_access_grants (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  source TEXT NOT NULL CHECK (source IN ('invite', 'admin')),
  -- The redemption id of an invite grant, or the admin event id of an admin grant.
  source_id TEXT NOT NULL,
  campaign_id TEXT,
  access_epoch INTEGER NOT NULL CHECK (access_epoch >= 0),
  granted_at INTEGER NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'admin', 'system')),
  actor_id TEXT,
  reason_enc TEXT,
  revoked_at INTEGER,
  revoked_reason TEXT CHECK (
    revoked_reason IS NULL OR revoked_reason IN ('relocked', 'suspended', 'deleted', 'campaign_revoked')
  ),
  write_id TEXT NOT NULL,
  UNIQUE (source, source_id),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CHECK (source = 'admin' OR campaign_id IS NOT NULL),
  CHECK (actor_kind = 'system' OR actor_id IS NOT NULL)
) STRICT;

-- One current grant per account (note 04).
CREATE UNIQUE INDEX beta_access_grants_current ON beta_access_grants (user_id) WHERE revoked_at IS NULL;
-- Admission history per account.
CREATE INDEX beta_access_grants_user ON beta_access_grants (user_id, granted_at);
-- Campaign revocation previews read a campaign's current grants.
CREATE INDEX beta_access_grants_campaign ON beta_access_grants (campaign_id, revoked_at)
  WHERE campaign_id IS NOT NULL;
