CREATE TABLE mcp_grants (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('api_key', 'oauth')),
  client_id TEXT,
  client_name_enc TEXT NOT NULL,
  key_digest TEXT,
  digest_version INTEGER,
  scopes TEXT NOT NULL CHECK (json_valid(scopes)),
  task_ids TEXT CHECK (task_ids IS NULL OR json_valid(task_ids)),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  write_id TEXT NOT NULL,
  CHECK ((kind = 'api_key' AND key_digest IS NOT NULL AND digest_version IS NOT NULL AND client_id IS NULL)
    OR (kind = 'oauth' AND key_digest IS NULL AND digest_version IS NULL AND client_id IS NOT NULL))
) STRICT;
CREATE INDEX mcp_grants_owner ON mcp_grants (owner_id, revoked_at, expires_at);

CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY NOT NULL,
  metadata TEXT NOT NULL CHECK (json_valid(metadata)),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  write_id TEXT NOT NULL
) STRICT;
CREATE INDEX oauth_clients_unused ON oauth_clients (last_used_at, created_at);

CREATE TABLE oauth_requests (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  auth_session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  client_id TEXT NOT NULL,
  client_name_enc TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK (json_valid(scopes)),
  resource TEXT NOT NULL,
  challenge TEXT NOT NULL,
  state_enc TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  grant_id TEXT REFERENCES mcp_grants(id),
  write_id TEXT NOT NULL
) STRICT;
CREATE INDEX oauth_requests_owner ON oauth_requests (owner_id, auth_session_id, expires_at);

CREATE TABLE oauth_codes (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  grant_id TEXT NOT NULL REFERENCES mcp_grants(id),
  request_id TEXT NOT NULL UNIQUE REFERENCES oauth_requests(id),
  code_digest TEXT NOT NULL,
  digest_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  write_id TEXT NOT NULL,
  UNIQUE (digest_version, code_digest)
) STRICT;
CREATE INDEX oauth_codes_owner ON oauth_codes (owner_id, expires_at);

CREATE TABLE oauth_refresh_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  grant_id TEXT NOT NULL REFERENCES mcp_grants(id),
  client_id TEXT NOT NULL,
  token_digest TEXT NOT NULL,
  digest_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  write_id TEXT NOT NULL,
  UNIQUE (digest_version, token_digest)
) STRICT;
CREATE INDEX oauth_refresh_grant ON oauth_refresh_tokens (grant_id, consumed_at);
CREATE INDEX oauth_refresh_owner ON oauth_refresh_tokens (owner_id, expires_at);
