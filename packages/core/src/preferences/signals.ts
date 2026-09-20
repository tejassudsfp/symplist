import type { PreferenceGroup } from "@symplist/contracts";
import type { DbClient } from "@symplist/db";

/** A committed preference change observed by services sharing one D1 client. */
export interface PreferenceCommit {
  readonly ownerId: string;
  readonly group: PreferenceGroup;
  readonly version: number;
}

type PreferenceCommitListener = (commit: PreferenceCommit) => void;

const listeners = new WeakMap<DbClient, Set<PreferenceCommitListener>>();

/** Subscribes to successful preference writes made through this process's D1 client. */
export function onPreferenceCommitted(
  db: DbClient,
  listener: PreferenceCommitListener,
): () => void {
  const set = listeners.get(db) ?? new Set<PreferenceCommitListener>();
  set.add(listener);
  listeners.set(db, set);
  return () => set.delete(listener);
}

/** Announces only a write that was verified as newly committed. */
export function announcePreferenceCommitted(db: DbClient, commit: PreferenceCommit): void {
  for (const listener of listeners.get(db) ?? []) {
    try {
      listener(commit);
    } catch {
      // A cache or scheduling hint cannot undo the committed preference.
    }
  }
}
