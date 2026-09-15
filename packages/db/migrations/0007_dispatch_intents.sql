-- Durable dispatch intents (§8.1): recorded in the batch that accepts work, picked up by the
-- dispatcher after commit, re-triggered by the reconciler only while no Trigger run id is stored.
-- Kinds include 'simon_run' (subject: run id) and 'account_purge' (subject: user id, §5.6).
-- No foreign key to users: the purge intent outlives the users row it purges.
CREATE TABLE dispatch_intents (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64 AND kind NOT GLOB '*[^a-z0-9_]*'),
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'cancelled')),
  -- Chosen at dispatch time from the current mode.
  executor TEXT CHECK (executor IS NULL OR executor IN ('local', 'trigger')),
  -- The executor generation (executor_state) the intent was recorded under.
  executor_generation INTEGER NOT NULL CHECK (executor_generation >= 1),
  trigger_run_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  cancelled_at INTEGER,
  write_id TEXT NOT NULL,
  -- One intent per subject: the Trigger idempotency key is the subject id.
  UNIQUE (kind, subject_id),
  CHECK (status <> 'dispatched' OR (executor IS NOT NULL AND dispatched_at IS NOT NULL)),
  CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL),
  CHECK (trigger_run_id IS NULL OR executor = 'trigger')
) STRICT;

-- Dispatcher and reconciler scans.
CREATE INDEX dispatch_intents_pending ON dispatch_intents (status, created_at);
-- Restriction and task archive cancel an owner's pending intents.
CREATE INDEX dispatch_intents_owner ON dispatch_intents (owner_id, status);
