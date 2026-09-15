import { int, type Statement, sql } from "@symplist/db";
import type { ArchiveContributor } from "./types.ts";

/**
 * Search task-archive statements (§2.1, §10.1): one `search_intents` upsert per task this completion
 * archived, guarded by the deciding archive statement's write id on the root task, so the index learns
 * of the archive exactly when it committed. The writer re-reads each task, so the intent carries only
 * the task's version. Subtasks that `parent_only` turns into top-level tasks are re-read when results
 * render, and their own move intents come from the move statements.
 */
export const searchArchiveContributor: ArchiveContributor = {
  domain: "search",
  statements: ({ ownerId, rootTaskId, taskIds, writeId, now }) => {
    if (taskIds.length === 0) return [];
    const statements: Statement[] = [];
    // D1 caps a statement at 100 parameters (§3.2).
    for (let start = 0; start < taskIds.length; start += 90) {
      statements.push(
        sql(
          `INSERT INTO search_intents (owner_id, entity, entity_id, revision_or_seq, op, created_at)
           SELECT t.owner_id, 'task', t.id, t.version, 'upsert', :now
           FROM tasks t
           WHERE t.owner_id = :owner AND t.id IN (:ids)
             AND EXISTS (SELECT 1 FROM tasks WHERE id = :root AND owner_id = :root_owner AND write_id = :w)`,
          {
            now: int(now),
            owner: ownerId,
            ids: taskIds.slice(start, start + 90),
            root: rootTaskId,
            root_owner: ownerId,
            w: writeId,
          },
        ),
      );
    }
    return statements;
  },
};
