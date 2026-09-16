-- Workspace (§2.1, §4.4): an optional short preview of the task page, shown in task rows. A field
-- envelope under the owner's account key (purpose `task_preview`); NULL when there is none.
ALTER TABLE tasks ADD COLUMN preview_enc TEXT;

-- The archive lists completed tasks (the roots of archived groups) newest first.
CREATE INDEX tasks_archive_roots ON tasks (owner_id, archived_at, id)
  WHERE status = 'archived' AND archived_with_root_id = id;
