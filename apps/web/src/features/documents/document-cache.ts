"use client";

import type { DocumentHeadResponse } from "@symplist/contracts";
import { registerSignOutCleanup } from "@/features/access/sign-out";

/**
 * The last head each task was seen with, so returning to a task renders it immediately instead of
 * blanking to a loading state and waiting for the network.
 *
 * Why this and not a query library: the pane already owns a state machine for loading, the unsaved
 * buffer, drafts, save status and conflicts, and that machine — not a cache — decides what the
 * reader sees. A cache that also owned fetching would make two sources of truth for the same
 * document. This holds one thing, the last response, and the machine keeps deciding.
 *
 * The api's D1 lane is 2 requests a second for the whole process, so a switch back to a task read a
 * minute ago is not merely a slow request, it is a request queued behind everyone else's. The one
 * reliably fast request is the one not made.
 *
 * Cached content is account-scoped and must not outlive a session: `clearDocumentCache` runs on
 * sign-out and on an account switch. Nothing here is written to disk.
 */

/** Tasks kept before the least recently used is dropped. */
export const DOCUMENT_CACHE_LIMIT = 24;

/** How long a cached head may be shown before it is only a placeholder for a fresh read. */
export const DOCUMENT_CACHE_MAX_AGE_MS = 5 * 60_000;

interface CacheEntry {
  readonly response: DocumentHeadResponse;
  readonly at: number;
}

const entries = new Map<string, CacheEntry>();

/**
 * The cached head for a task, or undefined when there is none or it is too old to show.
 *
 * Reading refreshes the entry's position, so the cache keeps what is actually being used rather
 * than what happened to be loaded first.
 */
export function cachedHead(
  taskId: string,
  now: number = Date.now(),
): DocumentHeadResponse | undefined {
  const entry = entries.get(taskId);
  if (!entry) return undefined;
  if (now - entry.at > DOCUMENT_CACHE_MAX_AGE_MS) {
    entries.delete(taskId);
    return undefined;
  }
  entries.delete(taskId);
  entries.set(taskId, entry);
  return entry.response;
}

/** Records the head a task was last seen with, dropping the least recently used past the limit. */
export function cacheHead(
  taskId: string,
  response: DocumentHeadResponse,
  now: number = Date.now(),
): void {
  entries.delete(taskId);
  entries.set(taskId, { response, at: now });
  while (entries.size > DOCUMENT_CACHE_LIMIT) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

/** Drops one task, for a delete or an unrecoverable read. */
export function forgetDocument(taskId: string): void {
  entries.delete(taskId);
}

/** Drops everything. Runs on sign-out and on an account switch; content must not cross accounts. */
export function clearDocumentCache(): void {
  entries.clear();
}

/** The number of tasks held, for tests. */
export function documentCacheSize(): number {
  return entries.size;
}

/**
 * Document text is account-scoped, so it leaves with the session (§5.1). Sign-out navigates the
 * whole document and would discard this anyway; registering says so rather than relying on it, and
 * covers the account-deletion exit that leaves by the same door.
 */
registerSignOutCleanup(clearDocumentCache);
