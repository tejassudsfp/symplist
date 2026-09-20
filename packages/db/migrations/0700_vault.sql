CREATE TABLE vaults (
  owner_id TEXT PRIMARY KEY REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1,
  parameters TEXT NOT NULL,
  pass_wrap_enc TEXT NOT NULL,
  recovery_wrap_enc TEXT NOT NULL,
  recovery_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL
) STRICT;
CREATE TABLE vault_items (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES vaults(owner_id),
  version INTEGER NOT NULL DEFAULT 1,
  data_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  write_id TEXT NOT NULL,
  UNIQUE(id, owner_id)
) STRICT;
CREATE INDEX vault_items_owner ON vault_items(owner_id, deleted_at, id);
CREATE TABLE vault_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES vaults(owner_id),
  auth_session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  token_digest TEXT NOT NULL UNIQUE,
  digest_version INTEGER NOT NULL,
  key_wrap_enc TEXT NOT NULL,
  vault_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  write_id TEXT NOT NULL
) STRICT;
CREATE INDEX vault_sessions_owner ON vault_sessions(owner_id, auth_session_id);
CREATE TABLE vault_reset_authorizations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  auth_session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  challenge_id TEXT NOT NULL UNIQUE REFERENCES otp_challenges(id),
  vault_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  write_id TEXT NOT NULL
) STRICT;
CREATE TABLE vault_unlock_limits (
  owner_id TEXT PRIMARY KEY REFERENCES users(id),
  window_start INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  day_start INTEGER NOT NULL,
  day_failures INTEGER NOT NULL,
  locked_until INTEGER NOT NULL,
  write_id TEXT NOT NULL
) STRICT;
CREATE TABLE vault_grants (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES vaults(owner_id),
  item_id TEXT NOT NULL,
  item_version INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  tool_slug TEXT NOT NULL,
  argument_path TEXT NOT NULL,
  label_enc TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked','expired')),
  value_enc TEXT,
  created_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  FOREIGN KEY(item_id, owner_id) REFERENCES vault_items(id, owner_id),
  FOREIGN KEY(task_id, owner_id) REFERENCES tasks(id, owner_id)
) STRICT;
CREATE INDEX vault_grants_owner ON vault_grants(owner_id, item_id, status);
CREATE INDEX vault_grants_task ON vault_grants(task_id, status);
CREATE INDEX vault_grants_expiry ON vault_grants(status, expires_at);
CREATE TABLE vault_audit (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK(action = 'key_reset'),
  vault_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  notification_sent_at INTEGER
) STRICT;
