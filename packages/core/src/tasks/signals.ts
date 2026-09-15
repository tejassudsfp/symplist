import type { DbClient } from "@symplist/db";

/**
 * The internal event (§6.2) a worker announces after it changed an owner's task rows through
 * `core/tasks`, with the payload `{ taskTreeVersion, taskIds }` (at most 100 ids). The api treats the
 * payload as a hint: it re-reads the version and the owner's ids, invalidates its tree cache and
 * publishes `tasks.changed`.
 */
export const TASK_TREE_CHANGED_EVENT = "task_tree.changed";

/** A committed change to one owner's task tree. */
export interface TaskTreeCommit {
  readonly ownerId: string;
  /** The tree version the commit produced. */
  readonly taskTreeVersion: number;
  /** The tasks whose rows changed. */
  readonly taskIds: readonly string[];
}

export type TaskTreeCommitListener = (commit: TaskTreeCommit) => void;

const listeners = new WeakMap<DbClient, Set<TaskTreeCommitListener>>();

/**
 * Subscribes to task tree commits made through `db` in this process (§3.3, §7). The api subscribes
 * with its own D1 client, so every task write in the api (the workspace routes, and Simon or MCP tools
 * that call `core/tasks` with the same client) invalidates its tree cache and announces
 * `tasks.changed`. Worker writes reach the api through `/internal/v1/events` instead. Returns the
 * unsubscribe function.
 */
export function onTaskTreeCommitted(db: DbClient, listener: TaskTreeCommitListener): () => void {
  let set = listeners.get(db);
  if (!set) {
    set = new Set();
    listeners.set(db, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/**
 * Announces a commit to the subscribers of `db`. Called by `core/tasks` after every verified task
 * write, and by other domains that change task rows through its helpers (task previews). Listener
 * failures never reach the writer: the commit already happened.
 */
export function announceTaskTreeCommitted(db: DbClient, commit: TaskTreeCommit): void {
  const set = listeners.get(db);
  if (!set) return;
  for (const listener of [...set]) {
    try {
      listener(commit);
    } catch {
      // A listener's failure never undoes or fails the commit it observed.
    }
  }
}
