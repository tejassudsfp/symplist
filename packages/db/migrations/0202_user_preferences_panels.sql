-- Workspace (§10.3): adds the `panels` preference group (inbox and chat collapse and widths). SQLite
-- cannot alter a CHECK constraint, so the table is copied into an identical table whose group list
-- also allows `panels`, then swapped in. Columns, keys and every stored row are unchanged, and code
-- from the previous deploy reads and writes the new table exactly as before.
CREATE TABLE user_preferences_next (
  owner_id TEXT NOT NULL REFERENCES users (id),
  "group" TEXT NOT NULL CHECK ("group" IN ('appearance', 'keyboard', 'chat', 'recent', 'panels', 'privacy')),
  version INTEGER NOT NULL CHECK (version >= 1),
  data_enc TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, "group")
) STRICT;

INSERT INTO user_preferences_next (owner_id, "group", version, data_enc, updated_at, write_id)
  SELECT owner_id, "group", version, data_enc, updated_at, write_id FROM user_preferences;

DROP TABLE user_preferences;

ALTER TABLE user_preferences_next RENAME TO user_preferences;
