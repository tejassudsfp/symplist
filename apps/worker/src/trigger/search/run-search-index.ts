import {
  createSearchSources,
  SEARCH_INDEX_PUBLISHED_EVENT,
  SearchIndexWriter,
  type SearchLog,
  type SearchLogFields,
  type SearchSources,
  searchIndexPayloadSchema,
} from "@symplist/core/search";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import type { ObjectStore } from "@symplist/storage";
import { WorkerError, withMappedErrors } from "../../infra/errors.ts";
import type { AnnounceOutcome } from "../../infra/internal-events.ts";
import type { WorkerLogger } from "../../infra/logger.ts";
import { systemWorkerTimers, type WorkerTimers } from "../../infra/timers.ts";

/** The task output: enums and counts only (§8.3). */
export interface SearchIndexTaskOutput {
  /**
   * `published`: the owner's index is current. `up_to_date`: nothing was pending. `skipped`: durable
   * mode ended, the account is being deleted, or its key is gone, so nothing was written.
   * `incomplete`: the time or batch budget ended with changes pending, and the next window was enqueued.
   */
  readonly status: "published" | "up_to_date" | "skipped" | "incomplete";
  readonly generation: number | null;
  readonly batchCount: number;
  readonly pendingCount: number;
}

export interface SearchIndexTaskDependencies {
  readonly db: DbClient;
  readonly objects: ObjectStore;
  readonly keys: KeyProvider;
  readonly logger: WorkerLogger;
  /** Announces `search.index_published` to the api (§6.2). */
  readonly announce: (input: {
    readonly type: string;
    readonly ownerId: string;
    readonly payload: { readonly generation: number; readonly pending: number };
  }) => Promise<AnnounceOutcome>;
  /** Enqueues this task again for the owner's next window (§10.1). */
  readonly enqueue: (ownerId: string) => Promise<void>;
  /** Defaults to the sources built from the core search source contributors. */
  readonly sources?: SearchSources;
  readonly timers?: WorkerTimers;
  /** How long one run keeps publishing batches; defaults to 4 minutes, within `maxDuration`. */
  readonly budgetMs?: number;
  /** Writer batches per run; defaults to 20. */
  readonly maxBatches?: number;
  /** Intents per batch; defaults to the writer's 200. */
  readonly batchLimit?: number;
}

/** The worker's redacting logger as the search log: field shapes outside its allowlist are dropped. */
function searchLog(logger: WorkerLogger): SearchLog {
  const fields = (input?: SearchLogFields) => (input ? { ...input } : undefined);
  return {
    info: (event, input) => logger.info(event, fields(input)),
    warn: (event, input) => logger.warn(event, fields(input)),
    error: (event, input) => logger.error(event, fields(input)),
  };
}

/**
 * The durable index writer (§8.8, §10.1): runs `SearchIndexWriter` in durable mode for the owner named by
 * the ids-only payload, publishing bounded batches until nothing is pending or the budget ends, and
 * announcing each publication so the api refreshes its cache and relays `search.freshness`. The writer
 * guards every publication with the durable executor generation, so a run after an executor switch writes
 * nothing. Failures are mapped to stable codes; storage and D1 outages are retried by Trigger.
 */
export async function runSearchIndexTask(
  payload: unknown,
  dependencies: SearchIndexTaskDependencies,
  signal?: AbortSignal,
): Promise<SearchIndexTaskOutput> {
  const parsed = searchIndexPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new WorkerError("search_index.payload_invalid");
  const { ownerId } = parsed.data;
  const { db, objects, keys, logger } = dependencies;
  const timers = dependencies.timers ?? systemWorkerTimers;
  const log = searchLog(logger);
  const writer = new SearchIndexWriter({
    db,
    objects,
    keys,
    sources: dependencies.sources ?? createSearchSources({ db, objects, keys, log }),
    now: () => timers.now(),
    log,
    ...(dependencies.batchLimit === undefined ? {} : { batchLimit: dependencies.batchLimit }),
  });
  const deadline = timers.now() + (dependencies.budgetMs ?? 4 * 60_000);
  const maxBatches = dependencies.maxBatches ?? 20;

  return withMappedErrors(async () => {
    let batchCount = 0;
    let generation: number | null = null;
    let pendingCount = 0;
    let published = false;
    while (batchCount < maxBatches) {
      if (signal?.aborted) throw new WorkerError("run.aborted");
      batchCount += 1;
      const outcome = await writer.run(ownerId, { mode: "durable", ...(signal ? { signal } : {}) });
      if (outcome.status === "conflict") continue;
      if (outcome.status === "skipped") {
        logger.warn("search_index.skipped", { ownerId, reason: outcome.reason, count: batchCount });
        return { status: "skipped", generation, pendingCount, batchCount };
      }
      if (outcome.status === "up_to_date") {
        return {
          status: published ? "published" : "up_to_date",
          generation: outcome.generation,
          pendingCount: 0,
          batchCount,
        };
      }
      published = true;
      generation = outcome.generation;
      pendingCount = outcome.pending;
      const announced = await dependencies.announce({
        type: SEARCH_INDEX_PUBLISHED_EVENT,
        ownerId,
        payload: { generation: outcome.generation, pending: outcome.pending },
      });
      if (announced !== "delivered") {
        // The api also reloads when it next reads the generation from D1 (§10.1).
        logger.warn("search_index.announce_unconfirmed", { ownerId, state: announced, generation });
      }
      if (outcome.pending === 0) {
        return { status: "published", generation, pendingCount: 0, batchCount };
      }
      if (timers.now() >= deadline) break;
    }
    await dependencies.enqueue(ownerId);
    logger.info("search_index.incomplete", { ownerId, pendingCount, count: batchCount });
    return { status: "incomplete", generation, pendingCount, batchCount };
  });
}
