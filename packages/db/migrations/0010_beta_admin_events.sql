-- Append-only admin and access audit events (notes 04, architecture §5.4, §5.6, §5.7). Rows store
-- account ids, never emails; reason_enc is encrypted under reason_owner_id's account key and becomes
-- unreadable after that account is deleted. No foreign keys: events outlive the accounts they name.
CREATE TABLE beta_admin_events (
  id TEXT PRIMARY KEY NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'admin', 'system')),
  actor_id TEXT,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64 AND action NOT GLOB '*[^a-z0-9_]*'),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('user', 'invite', 'campaign', 'system')),
  target_id TEXT,
  reason_enc TEXT,
  reason_owner_id TEXT,
  -- Plaintext operational before/after values (for example beta_state or a redemption cap).
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  -- Unique per request, so appends are idempotent and verifiable by request id (§3.2).
  request_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  CHECK (actor_kind = 'system' OR actor_id IS NOT NULL),
  CHECK ((reason_enc IS NULL) = (reason_owner_id IS NULL))
) STRICT;

-- Admin bootstrap runs once (§5.7).
CREATE UNIQUE INDEX beta_admin_events_bootstrap_once ON beta_admin_events (action)
  WHERE action = 'admin_bootstrap';
CREATE INDEX beta_admin_events_target ON beta_admin_events (target_kind, target_id, created_at);
CREATE INDEX beta_admin_events_created ON beta_admin_events (created_at);

-- Append-only: the DbClient also rejects UPDATE, DELETE and REPLACE statements on this table.
CREATE TRIGGER beta_admin_events_no_update BEFORE UPDATE ON beta_admin_events
BEGIN
  SELECT RAISE(ABORT, 'append_only: beta_admin_events');
END;

CREATE TRIGGER beta_admin_events_no_delete BEFORE DELETE ON beta_admin_events
BEGIN
  SELECT RAISE(ABORT, 'append_only: beta_admin_events');
END;
