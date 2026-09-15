-- Workspace (§10.3): the `panels` preference group (task list and chat collapse and widths).
--
-- The foundation `user_preferences."group"` CHECK lists only the five §10.3 groups, and SQLite cannot
-- widen a CHECK without rewriting the table. Copying the rows into a replacement table and swapping
-- it in would be a DROP and a RENAME, which the expand-only rule (§3.4) forbids: the migration runs
-- before the new code deploys, while the previous release is still serving writes, and a swap would
-- lose any preference written between the copy and the drop (and, if the request is not atomic,
-- could leave no `user_preferences` table at all). So the new group gets its own additive table with
-- the same columns, keys and semantics. Nothing is copied, renamed or dropped, and the previous
-- release keeps reading and writing `user_preferences` unchanged.
--
-- `core/preferences` reads both tables in one statement (`UNION ALL`) and writes each group to the
-- table that owns it, so the group set stays one uniform API.
CREATE TABLE user_preferences_panels (
  owner_id TEXT NOT NULL REFERENCES users (id),
  "group" TEXT NOT NULL CHECK ("group" = 'panels'),
  version INTEGER NOT NULL CHECK (version >= 1),
  data_enc TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  write_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, "group")
) STRICT;
