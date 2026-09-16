-- Workspace (§2.1, §3.3, §7): the owner's task tree version. Every write to the owner's tasks rows
-- increments it in the same batch, so the tree cache, `tasks.changed` and the user topic snapshot
-- share one counter, and structural writes use it as their optimistic lock. `task_tree_write_id`
-- marks the batch that last moved the version; it is separate from `users.write_id`, which the
-- access routines own.
ALTER TABLE users ADD COLUMN task_tree_version INTEGER NOT NULL DEFAULT 0 CHECK (task_tree_version >= 0);
ALTER TABLE users ADD COLUMN task_tree_write_id TEXT;
