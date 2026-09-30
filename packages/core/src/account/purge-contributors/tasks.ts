import { int, sql } from "@symplist/db";
import type { PurgeContributor } from "./types.ts";

/**
 * Tasks purge statements (§5.6). Deletes the account's tasks leaves first: each pass removes at most
 * `batchLimit` tasks that have no subtask left, so the parent foreign key's `ON DELETE CASCADE` never
 * deletes rows beyond the bound, and deeper trees take further passes until `remaining` reports none.
 * Other domains' rows that reference tasks (documents, schedules, conversations, search intents) are
 * purged by their own contributors, which run earlier. The tree version lives on the users row.
 *
 * Labels go with the tasks, and go first: both `task_labels` and `labels` would cascade from the rows
 * below, but deleting them explicitly is what keeps a pass inside `batchLimit` — a task carrying eight
 * chips would otherwise multiply the bound — and what lets a reader see that a purged account leaves no
 * label behind.
 */
export const tasksPurgeContributor: PurgeContributor = {
  domain: "tasks",
  statements: ({ userId, batchLimit }) => [
    sql(
      `DELETE FROM task_labels WHERE rowid IN (
         SELECT rowid FROM task_labels WHERE owner_id = :user LIMIT CAST(:limit AS INTEGER))`,
      { user: userId, limit: int(batchLimit) },
    ),
    sql(
      `DELETE FROM labels WHERE rowid IN (
         SELECT rowid FROM labels WHERE owner_id = :user LIMIT CAST(:limit AS INTEGER))`,
      { user: userId, limit: int(batchLimit) },
    ),
    sql(
      `DELETE FROM tasks WHERE rowid IN (
         SELECT t.rowid FROM tasks t
         WHERE t.owner_id = :user
           AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.owner_id = t.owner_id)
         LIMIT CAST(:limit AS INTEGER))`,
      { user: userId, limit: int(batchLimit) },
    ),
  ],
  remaining: ({ userId }) => [
    sql(
      `SELECT EXISTS (SELECT 1 FROM tasks WHERE owner_id = :user)
            OR EXISTS (SELECT 1 FROM labels WHERE owner_id = :user)
            OR EXISTS (SELECT 1 FROM task_labels WHERE owner_id = :user) AS remaining`,
      { user: userId },
    ),
  ],
};
