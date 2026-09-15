-- Versioned encrypted preferences per group (§10.3). "group" is an SQL keyword and is always quoted.
CREATE TABLE user_preferences (
  owner_id TEXT NOT NULL REFERENCES users (id),
  "group" TEXT NOT NULL CHECK ("group" IN ('appearance', 'keyboard', 'chat', 'recent', 'privacy')),
  version INTEGER NOT NULL CHECK (version >= 1),
  data_enc TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, "group")
) STRICT;
