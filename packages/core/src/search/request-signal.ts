import type { DbClient } from "@symplist/db";

type Request = { readonly ownerId: string; readonly reason: "rebuild" | "stale" };
const listeners = new WeakMap<DbClient, Set<(request: Request) => void>>();
/** A caller asks the process's existing coordinator; it never starts a second writer. */
export function onSearchIndexRequested(db: DbClient, listener: (request: Request) => void) {
  const set = listeners.get(db) ?? new Set();
  set.add(listener);
  listeners.set(db, set);
  return () => {
    set.delete(listener);
  };
}
export function requestSearchIndex(db: DbClient, request: Request): void {
  for (const listener of listeners.get(db) ?? []) {
    try {
      listener(request);
    } catch {
      /* A maintenance hint cannot fail an already-authorized read. */
    }
  }
}
