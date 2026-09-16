import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  Optional,
} from "@nestjs/common";
import type { RealtimePublisher } from "@symplist/core/events";
import {
  enqueueSearchIndex,
  type SearchIndexCache,
  type SearchIndexTriggerClient,
  type SearchIndexWriter,
  type SearchQueryService,
  searchErrorCode,
  searchIndexIdempotencyKey,
  staleSearchOwners,
} from "@symplist/core/search";
import type { DbClient } from "@symplist/db";
import { AppLogger } from "../../common/logging/logger.ts";
import { TRIGGER_CLIENT, type TriggerClientBinding } from "../../common/seams.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";
import { DB_CLIENT } from "../../infra/db/db.providers.ts";
import { ExecutorStateService } from "../../infra/executors/executor-state.ts";
import { LocalScheduler } from "../../infra/scheduler/local-scheduler.ts";
import { RUNTIME_TIMERS, type RuntimeTimers } from "../../infra/scheduler/runtime.ts";
import { REALTIME_PUBLISHER } from "../realtime/realtime.tokens.ts";
import {
  SEARCH_API_TUNING,
  SEARCH_INDEX_CACHE,
  SEARCH_INDEX_WRITER,
  SEARCH_QUERY_SERVICE,
  type SearchApiTuning,
} from "./search.tokens.ts";

/** Why the writer is requested for an owner. */
export type SearchIndexRequestReason = "rebuild" | "stale" | "changes";

/** What one local run did, for tests and logs. */
export interface LocalSearchRunSummary {
  readonly status: "published" | "up_to_date" | "skipped" | "failed" | "busy";
  readonly generation: number | null;
  readonly pending: number;
  readonly batches: number;
}

interface OwnerSchedule {
  timer: unknown;
  readonly dueAt: number;
}

/**
 * Starts the single index writer of the api's mode (§10.1). With `DURABLE=false` the api is the writer:
 * requests schedule an in-process run after the producers' 30-second delay (at once for a rebuild), runs
 * are serialized per process and guarded by the local executor generation, a sweep picks up owners whose
 * intents waited (while the local scheduler runs), failures back off, and each publication announces
 * `search.freshness`. With `DURABLE=true` the api never writes: it enqueues the `search-index` task with
 * the window idempotency key and delay, once per owner per window.
 */
@Injectable()
export class SearchIndexCoordinator implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly schedules = new Map<string, OwnerSchedule>();
  private readonly failures = new Map<string, number>();
  private readonly again = new Set<string>();
  private readonly enqueuedWindows = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private running: string | null = null;
  private sweepTimer: unknown;
  private cacheTimer: unknown;
  private sweeping = false;
  private stopped = false;
  private readonly controller = new AbortController();

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(RUNTIME_TIMERS) private readonly timers: RuntimeTimers,
    @Inject(SEARCH_INDEX_WRITER) private readonly writer: SearchIndexWriter,
    @Inject(SEARCH_QUERY_SERVICE) private readonly queries: SearchQueryService,
    @Inject(SEARCH_INDEX_CACHE) private readonly cache: SearchIndexCache,
    @Inject(ExecutorStateService) private readonly executorState: ExecutorStateService,
    @Inject(LocalScheduler) private readonly scheduler: LocalScheduler,
    @Inject(SEARCH_API_TUNING) private readonly tuning: SearchApiTuning,
    private readonly logger: AppLogger,
    @Optional() @Inject(TRIGGER_CLIENT) private readonly trigger?: TriggerClientBinding,
    @Optional() @Inject(REALTIME_PUBLISHER) private readonly publisher?: RealtimePublisher,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.DURABLE) this.armSweep();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    if (this.sweepTimer !== undefined) this.timers.clearTimeout(this.sweepTimer);
    if (this.cacheTimer !== undefined) this.timers.clearTimeout(this.cacheTimer);
    for (const schedule of this.schedules.values()) this.timers.clearTimeout(schedule.timer);
    this.schedules.clear();
    await this.queue.catch(() => undefined);
  }

  /**
   * Keeps idle decrypted indexes expiring while any are held: a sweep timer runs only after search
   * activity and re-arms while the cache holds an owner, so an idle process schedules nothing.
   */
  noteActivity(): void {
    if (this.cacheTimer !== undefined || this.stopped) return;
    this.cacheTimer = this.timers.setTimeout(() => {
      this.cacheTimer = undefined;
      this.queries.sweep();
      if (this.cache.stats().owners > 0) this.noteActivity();
    }, this.tuning.cacheSweepIntervalMs);
  }

  /**
   * Local mode: the intent sweep re-arms only while the local scheduler runs (local mode with background
   * loops on, §8.8), so a process without background loops stops after one check.
   */
  private armSweep(): void {
    if (this.stopped) return;
    this.sweepTimer = this.timers.setTimeout(() => {
      this.sweepTimer = undefined;
      if (!this.scheduler.active) return;
      void this.sweep().finally(() => this.armSweep());
    }, this.tuning.sweepIntervalMs);
  }

  /** Asks for the owner's index to be written. Never throws; failures are logged. */
  request(ownerId: string, reason: SearchIndexRequestReason): void {
    if (this.stopped) return;
    if (this.config.DURABLE) {
      void this.enqueue(ownerId);
      return;
    }
    // A failing owner keeps its backoff: repeated searches never turn it into a tight retry loop.
    if (this.failures.has(ownerId) && this.schedules.has(ownerId)) return;
    this.schedule(ownerId, reason === "changes" ? this.tuning.localDelayMs : 0);
  }

  /** Drops the owner's scheduled work (after a restriction or deletion). */
  forget(ownerId: string): void {
    const schedule = this.schedules.get(ownerId);
    if (schedule) this.timers.clearTimeout(schedule.timer);
    this.schedules.delete(ownerId);
    this.again.delete(ownerId);
    this.failures.delete(ownerId);
  }

  /** Runs the local writer for an owner now, after any run already queued. */
  runNow(ownerId: string): Promise<LocalSearchRunSummary> {
    if (this.config.DURABLE) {
      return Promise.resolve({ status: "skipped", generation: null, pending: 0, batches: 0 });
    }
    if (this.running === ownerId) {
      this.again.add(ownerId);
      return Promise.resolve({ status: "busy", generation: null, pending: 0, batches: 0 });
    }
    const run = this.queue.then(() => this.runLocal(ownerId));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Local mode: runs the writer for owners whose intents waited longer than the sweep age. */
  async sweep(): Promise<number> {
    if (this.config.DURABLE || this.sweeping || this.stopped) return 0;
    this.sweeping = true;
    try {
      const owners = await staleSearchOwners(this.db, {
        now: this.timers.now(),
        olderThanMs: this.tuning.sweepAgeMs,
        limit: this.tuning.sweepOwners,
      });
      for (const ownerId of owners) {
        if (this.stopped) break;
        // An owner with a scheduled run (a pending delay or a failure backoff) is left to it.
        if (this.schedules.has(ownerId)) continue;
        await this.runNow(ownerId);
      }
      return owners.length;
    } catch (error) {
      this.logger.warn("search.index_sweep_failed", { code: searchErrorCode(error) });
      return 0;
    } finally {
      this.sweeping = false;
    }
  }

  /** Publishes `search.freshness` to the owner's sockets. */
  async announceFreshness(
    ownerId: string,
    freshness: { readonly generation: number; readonly pending: number },
  ) {
    if (!this.publisher) return;
    try {
      await this.publisher.publishToUser(ownerId, {
        type: "search.freshness",
        data: { generation: freshness.generation, pending: freshness.pending },
      });
    } catch (error) {
      this.logger.warn("search.freshness_publish_failed", {
        ownerId,
        code: searchErrorCode(error),
      });
    }
  }

  private schedule(ownerId: string, delayMs: number): void {
    const existing = this.schedules.get(ownerId);
    const dueAt = this.timers.now() + delayMs;
    if (existing && existing.dueAt <= dueAt) return;
    if (existing) this.timers.clearTimeout(existing.timer);
    const schedule: OwnerSchedule = { timer: undefined, dueAt };
    schedule.timer = this.timers.setTimeout(() => {
      if (this.schedules.get(ownerId) === schedule) this.schedules.delete(ownerId);
      void this.runNow(ownerId);
    }, delayMs);
    this.schedules.set(ownerId, schedule);
  }

  private async runLocal(ownerId: string): Promise<LocalSearchRunSummary> {
    if (this.stopped) return { status: "skipped", generation: null, pending: 0, batches: 0 };
    this.running = ownerId;
    let batches = 0;
    let generation: number | null = null;
    let pending = 0;
    try {
      const state = await this.executorState.readFresh();
      const readiness = this.executorState.readiness(state);
      if (!readiness.usable || readiness.mode !== "local") {
        return { status: "skipped", generation: null, pending: 0, batches: 0 };
      }
      let published = false;
      for (; batches < this.tuning.batchesPerRun; ) {
        batches += 1;
        const outcome = await this.writer.run(ownerId, {
          mode: "local",
          executorGeneration: readiness.generation,
          signal: this.controller.signal,
        });
        if (outcome.status === "conflict") continue;
        if (outcome.status === "skipped") {
          return { status: "skipped", generation, pending, batches };
        }
        if (outcome.status === "up_to_date") {
          generation = outcome.generation;
          break;
        }
        published = true;
        generation = outcome.generation;
        pending = outcome.pending;
        this.queries.invalidateState(ownerId);
        await this.announceFreshness(ownerId, { generation, pending });
        if (pending === 0) break;
      }
      this.failures.delete(ownerId);
      if (pending > 0) this.schedule(ownerId, 0);
      return { status: published ? "published" : "up_to_date", generation, pending, batches };
    } catch (error) {
      const failures = (this.failures.get(ownerId) ?? 0) + 1;
      this.failures.set(ownerId, failures);
      const delay = Math.min(
        this.tuning.maxRetryDelayMs,
        this.tuning.localDelayMs * 2 ** (failures - 1),
      );
      this.logger.warn("search.index_run_failed", {
        ownerId,
        code: searchErrorCode(error),
        failureCount: failures,
        retryMs: delay,
      });
      if (!this.stopped) this.schedule(ownerId, delay);
      return { status: "failed", generation, pending, batches };
    } finally {
      this.running = null;
      if (this.again.delete(ownerId) && !this.stopped) this.schedule(ownerId, 0);
    }
  }

  private async enqueue(ownerId: string): Promise<void> {
    const client = this.trigger as SearchIndexTriggerClient | null | undefined;
    if (!client) {
      this.logger.error("search.index_enqueue_unavailable", { ownerId });
      return;
    }
    const now = this.timers.now();
    const window = searchIndexIdempotencyKey(ownerId, now);
    if (this.enqueuedWindows.get(ownerId) === window) return;
    this.enqueuedWindows.set(ownerId, window);
    if (this.enqueuedWindows.size > 10_000) {
      const oldest = this.enqueuedWindows.keys().next().value as string;
      this.enqueuedWindows.delete(oldest);
    }
    try {
      await enqueueSearchIndex(client, ownerId, now);
    } catch (error) {
      this.enqueuedWindows.delete(ownerId);
      this.logger.warn("search.index_enqueue_failed", { ownerId, code: searchErrorCode(error) });
    }
  }
}
