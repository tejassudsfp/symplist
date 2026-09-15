-- The task tree (§2.1). Archived tasks keep collection and parent_id. A composite foreign key keeps
-- every parent in the same owner's tree.
CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users (id),
  parent_id TEXT,
  collection TEXT NOT NULL CHECK (collection IN ('now', 'later', 'unclassified')),
  -- Fractional index string; list order never uses timestamps (§3.4).
  position TEXT NOT NULL CHECK (length(position) BETWEEN 1 AND 512),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  archived_at INTEGER,
  archived_with_root_id TEXT,
  source TEXT NOT NULL CHECK (
    source IN ('user', 'simon') OR (source GLOB 'mcp:?*' AND length(source) <= 128)
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  write_id TEXT NOT NULL,
  title_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (id, owner_id),
  FOREIGN KEY (parent_id, owner_id) REFERENCES tasks (id, owner_id) ON DELETE CASCADE,
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CHECK (status = 'archived' OR archived_with_root_id IS NULL)
) STRICT;

-- The owner's tree by collection and order.
CREATE INDEX tasks_owner_tree ON tasks (owner_id, status, collection, position);
-- Children of a task (descendant moves, archive and the parent foreign key).
CREATE INDEX tasks_parent ON tasks (parent_id, owner_id);
-- Restore finds tasks archived with the same root.
CREATE INDEX tasks_archived_root ON tasks (owner_id, archived_with_root_id)
  WHERE archived_with_root_id IS NOT NULL;
