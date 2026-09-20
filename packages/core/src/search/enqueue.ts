import { idSchema } from "@symplist/contracts";
import { type DbClient, int, type Statement, sql } from "@symplist/db";
import { z } from "zod";

/** The Trigger task that writes indexes when `DURABLE=true` (§8.8, §10.1). */
export const SEARCH_INDEX_TASK_ID = "search-index";

/** The internal event the worker announces after publishing a generation (§6.2, §7). */
export const SEARCH_INDEX_PUBLISHED_EVENT = "search.index_published";

/** Producers delay the writer this long, so a burst of changes becomes one publication (§10.1). */
export const SEARCH_INDEX_DELAY_MS = 30_000;

/** The hourly cleanup re-enqueues owners whose intents waited longer than this (§10.1). */
export const SEARCH_STALE_INTENT_MS = 5 * 60_000;

/** The ids-only payload of `search-index` (§8.3). */
export const searchIndexPayloadSchema = z.strictObject({ ownerId: idSchema });

export type SearchIndexPayload = z.infer<typeof searchIndexPayloadSchema>;

/** The ids-and-counts payload of `search.index_published` (§6.2). */
export const searchIndexPublishedPayloadSchema = z.strictObject({
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  pending: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

/**
 * The idempotency key of an enqueue: `search:<ownerId>:<30-second window>` (§10.1). Every producer in
 * the same window enqueues the same delayed run.
 */
export function searchIndexIdempotencyKey(ownerId: string, now: number): string {
  return `search:${ownerId}:${Math.floor(now / SEARCH_INDEX_DELAY_MS)}`;
}

/** The trigger options every producer passes: the window key and `delay: '30s'`. */
export function searchIndexTriggerOptions(
  ownerId: string,
  now: number,
): { readonly idempotencyKey: string; readonly delay: string; readonly idempotencyKeyTTL: string } {
  return {
    idempotencyKey: searchIndexIdempotencyKey(ownerId, now),
    delay: `${SEARCH_INDEX_DELAY_MS / 1000}s`,
    // A window key is never reused after its window, so it need not outlive a day.
    idempotencyKeyTTL: "1d",
  };
}

/** The structural Trigger client a producer enqueues with (the api's client or the worker SDK). */
export interface SearchIndexTriggerClient {
  readonly tasks: {
    trigger(
      taskIdentifier: string,
      payload: unknown,
      options?: {
        readonly idempotencyKey?: string;
        readonly delay?: string;
        readonly idempotencyKeyTTL?: string;
      },
    ): Promise<{ readonly id: string }>;
  };
}

/** Enqueues the durable writer for an owner (§10.1). Ids-only payload; throws the client's error. */
export async function enqueueSearchIndex(
  client: SearchIndexTriggerClient,
  ownerId: string,
  now: number,
): Promise<string> {
  const payload: SearchIndexPayload = searchIndexPayloadSchema.parse({ ownerId });
  const handle = await client.tasks.trigger(
    SEARCH_INDEX_TASK_ID,
    payload,
    searchIndexTriggerOptions(ownerId, now),
  );
  return handle.id;
}

/** Owners whose oldest unapplied intent is older than `olderThanMs`, oldest first. */
export function staleSearchOwnersStatement(input: {
  readonly now: number;
  readonly olderThanMs: number;
  readonly limit: number;
}): Statement {
  return sql(
    `SELECT i.owner_id AS owner_id, MIN(i.created_at) AS oldest
     FROM search_intents i
     LEFT JOIN search_indexes s ON s.owner_id = i.owner_id
     WHERE i.created_at <= :cutoff AND i.id > COALESCE(s.applied_through, 0)
     GROUP BY i.owner_id
     ORDER BY oldest, i.owner_id
     LIMIT :limit`,
    { cutoff: int(input.now - input.olderThanMs), limit: int(input.limit) },
  );
}

/** Reads the owners {@link staleSearchOwnersStatement} selects. */
export async function staleSearchOwners(
  db: DbClient,
  input: { readonly now: number; readonly olderThanMs: number; readonly limit: number },
): Promise<string[]> {
  const rows = await db.all(staleSearchOwnersStatement(input));
  return rows.flatMap((row) => (typeof row.owner_id === "string" ? [row.owner_id] : []));
}
