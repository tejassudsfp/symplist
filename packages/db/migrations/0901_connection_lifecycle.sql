-- Provider tokens and connector catalogues never enter Symplist storage.
CREATE TABLE connection_state (
  owner_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1)
) STRICT;
INSERT INTO connection_state (owner_id, generation) SELECT DISTINCT owner_id, 1 FROM connections;

CREATE TRIGGER connections_insert_generation AFTER INSERT ON connections BEGIN
  INSERT INTO connection_state (owner_id, generation) VALUES (NEW.owner_id, 1)
  ON CONFLICT (owner_id) DO UPDATE SET generation = generation + 1;
END;
CREATE TRIGGER connections_update_generation AFTER UPDATE OF status, connected_account_id, generation ON connections BEGIN
  INSERT INTO connection_state (owner_id, generation) VALUES (NEW.owner_id, 1)
  ON CONFLICT (owner_id) DO UPDATE SET generation = generation + 1;
END;
CREATE TRIGGER connections_delete_generation AFTER DELETE ON connections BEGIN
  UPDATE connection_state SET generation = generation + 1 WHERE owner_id = OLD.owner_id;
END;

CREATE TABLE composio_sessions (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  session_id TEXT,
  pinned_generation INTEGER NOT NULL DEFAULT 0 CHECK (pinned_generation >= 0),
  lease_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL
) STRICT;

CREATE TABLE connection_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  auth_session_id TEXT NOT NULL REFERENCES auth_sessions(id),
  toolkit TEXT NOT NULL,
  alias_enc TEXT,
  nonce_digest TEXT NOT NULL,
  connected_account_id TEXT,
  replaces_connection_id TEXT,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting', 'pending', 'completing', 'confirmed', 'failed', 'expired')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  UNIQUE (connected_account_id)
) STRICT;
CREATE INDEX connection_attempts_owner ON connection_attempts (user_id, status, expires_at);
CREATE INDEX connection_attempts_expiry ON connection_attempts (status, expires_at);

CREATE TABLE composio_auth_configs (
  toolkit TEXT PRIMARY KEY NOT NULL,
  auth_config_id TEXT,
  auth_kind TEXT NOT NULL CHECK (auth_kind IN ('managed', 'api_key', 'none')),
  lease_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL
) STRICT;
