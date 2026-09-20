-- Confirmed Composio identity mapping (§14.1). OAuth tokens remain at Composio.
-- Introduced with Simon approvals because permission must bind to an actual owner/account row.
CREATE TABLE connections (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  toolkit TEXT NOT NULL,
  connected_account_id TEXT NOT NULL UNIQUE,
  alias_enc TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'needs_attention', 'disconnected')),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  confirmed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  UNIQUE (id, owner_id)
) STRICT;
CREATE INDEX connections_owner_toolkit ON connections (owner_id, toolkit, status);
