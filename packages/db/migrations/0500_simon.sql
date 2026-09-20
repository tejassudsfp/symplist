-- Simon's persisted history and execution state (§8). Content is encrypted with the account key.
-- active_run_id deliberately has no FK: a conversation claims an id before inserting its run in
-- the same guarded batch. All history relationships bind owner as well as resource identity.
CREATE TABLE conversations (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('task', 'quick')),
  task_id TEXT,
  active_run_id TEXT,
  next_message_seq INTEGER NOT NULL DEFAULT 0 CHECK (next_message_seq >= 0),
  context_epoch INTEGER NOT NULL DEFAULT 0 CHECK (context_epoch >= 0),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  UNIQUE (id, owner_id),
  UNIQUE (task_id),
  FOREIGN KEY (task_id, owner_id) REFERENCES tasks(id, owner_id),
  CHECK ((kind = 'task' AND task_id IS NOT NULL AND expires_at IS NULL)
    OR (kind = 'quick' AND task_id IS NULL AND expires_at IS NOT NULL))
) STRICT;
CREATE INDEX conversations_owner ON conversations (owner_id, updated_at);
CREATE INDEX conversations_expiry ON conversations (expires_at) WHERE kind = 'quick';

CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('turn', 'continuation', 'retry')),
  continues_run_id TEXT REFERENCES runs(id),
  approval_id TEXT,
  ask_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
    ('queued', 'running', 'awaiting_approval', 'awaiting_user', 'completed', 'stopped', 'interrupted', 'failed')),
  executor TEXT NOT NULL CHECK (executor IN ('local', 'trigger')),
  executor_generation INTEGER NOT NULL CHECK (executor_generation >= 1),
  tier TEXT NOT NULL CHECK (tier IN ('fast', 'smart')),
  provider TEXT,
  model TEXT,
  rules_version TEXT,
  trigger_run_id TEXT,
  cancel_requested_at INTEGER,
  heartbeat_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  steps INTEGER NOT NULL DEFAULT 0 CHECK (steps >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  est_cost_micros INTEGER NOT NULL DEFAULT 0 CHECK (est_cost_micros >= 0),
  retrieved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (retrieved_bytes >= 0),
  outcome_code TEXT,
  created_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  UNIQUE (id, owner_id),
  FOREIGN KEY (conversation_id, owner_id) REFERENCES conversations(id, owner_id),
  FOREIGN KEY (task_id, owner_id) REFERENCES tasks(id, owner_id),
  CHECK (trigger_run_id IS NULL OR executor = 'trigger')
) STRICT;
CREATE INDEX runs_active ON runs (executor, status, id);
CREATE INDEX runs_owner ON runs (owner_id, status, id);
CREATE INDEX runs_conversation ON runs (conversation_id, created_at);
CREATE INDEX runs_task ON runs (task_id, status);
CREATE UNIQUE INDEX runs_one_active ON runs (conversation_id)
  WHERE status IN ('queued', 'running', 'awaiting_approval', 'awaiting_user');

CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  run_id TEXT,
  request_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'accepted', 'completed', 'cancelled')),
  tier TEXT NOT NULL CHECK (tier IN ('fast', 'smart')),
  content_enc TEXT NOT NULL,
  request_fingerprint_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  UNIQUE (id, owner_id),
  UNIQUE (conversation_id, request_id),
  UNIQUE (conversation_id, seq),
  FOREIGN KEY (conversation_id, owner_id) REFERENCES conversations(id, owner_id),
  FOREIGN KEY (run_id, owner_id) REFERENCES runs(id, owner_id)
) STRICT;
CREATE INDEX messages_queue ON messages (conversation_id, status, seq);

CREATE TABLE message_parts (
  id TEXT PRIMARY KEY NOT NULL,
  message_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  content_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  UNIQUE (message_id, seq),
  FOREIGN KEY (message_id, owner_id) REFERENCES messages(id, owner_id)
) STRICT;

CREATE TABLE approvals (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_slug TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connected_account_id TEXT NOT NULL,
  arguments_enc TEXT NOT NULL,
  arg_digest TEXT NOT NULL,
  preview_enc TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending', 'approved', 'denied', 'dismissed', 'expired', 'superseded')),
  expires_at INTEGER NOT NULL,
  supersedes_id TEXT REFERENCES approvals(id),
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  FOREIGN KEY (conversation_id, owner_id) REFERENCES conversations(id, owner_id),
  FOREIGN KEY (run_id, owner_id) REFERENCES runs(id, owner_id),
  FOREIGN KEY (task_id, owner_id) REFERENCES tasks(id, owner_id)
) STRICT;
CREATE UNIQUE INDEX approvals_one_pending ON approvals (run_id) WHERE status = 'pending';
CREATE INDEX approvals_expiry ON approvals (status, expires_at);
CREATE INDEX approvals_connection ON approvals (connection_id, status);

CREATE TABLE user_asks (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  question_enc TEXT NOT NULL,
  answer_enc TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'dismissed', 'expired')),
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  UNIQUE (run_id, tool_call_id),
  FOREIGN KEY (conversation_id, owner_id) REFERENCES conversations(id, owner_id),
  FOREIGN KEY (run_id, owner_id) REFERENCES runs(id, owner_id),
  FOREIGN KEY (task_id, owner_id) REFERENCES tasks(id, owner_id)
) STRICT;
CREATE UNIQUE INDEX user_asks_one_pending ON user_asks (run_id) WHERE status = 'pending';
CREATE INDEX user_asks_expiry ON user_asks (status, expires_at);

CREATE TABLE tool_invocations (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_slug TEXT NOT NULL,
  connected_account_id TEXT,
  approval_id TEXT REFERENCES approvals(id),
  idempotency_key TEXT NOT NULL,
  arguments_enc TEXT NOT NULL,
  result_enc TEXT,
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'uncertain')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  write_id TEXT NOT NULL,
  UNIQUE (owner_id, idempotency_key),
  UNIQUE (run_id, tool_call_id),
  FOREIGN KEY (run_id, owner_id) REFERENCES runs(id, owner_id)
) STRICT;
