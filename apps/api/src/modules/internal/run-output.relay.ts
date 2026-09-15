import type { AccountKeyStore } from "@symplist/core/account";
import {
  executingRunStatuses,
  RUN_CHUNK_EVENT_TYPE,
  type RunChunkEventData,
  type RunOutputBody,
  type RunRelayOwnership,
  type RunRelaySource,
  type RunRelayState,
  runChunkBatchSchema,
  type UiMessageChunk,
} from "@symplist/core/events";
import {
  type AccountDataKey,
  decryptFieldText,
  INTERNAL_SIGNATURE_WINDOW_SECONDS,
  runChunkContext,
  zeroize,
} from "@symplist/crypto";
import type { ExecutorStateReader } from "../../infra/executors/executor-state.ts";
import {
  errorCode,
  errorName,
  type OperationalLog,
  type RuntimeTimers,
} from "../../infra/scheduler/runtime.ts";
import type { TopicHub } from "../realtime/topic-hub.ts";

export type RelayRejection =
  | "run_mismatch"
  | "unknown_run"
  | "inactive_run"
  | "stale_generation"
  | "undecryptable"
  | "invalid_plaintext"
  | "unavailable"
  | "capacity"
  | "shutting_down";

export type RelayResult =
  | { readonly status: "accepted"; readonly relayed: number }
  | { readonly status: "duplicate" }
  | { readonly status: "rejected"; readonly reason: RelayRejection };

interface RunEntry {
  ownership: RunRelayOwnership | null;
  /** When a lookup last found no such run; answered from memory for the state TTL. */
  missingAt: number | null;
  ownershipPromise: Promise<RunRelayOwnership | null> | undefined;
  state: { readonly value: RunRelayState | null; readonly readAt: number } | undefined;
  statePromise: Promise<RunRelayState | null> | undefined;
  readonly seen: Set<number>;
  maxSeq: number;
  lastUsedAt: number;
}

interface KeyEntry {
  readonly key: AccountDataKey | null;
  readonly readAt: number;
}

export interface RunOutputRelayOptions {
  readonly source: RunRelaySource | null;
  readonly accountKeys: Pick<AccountKeyStore, "load">;
  readonly executorState: ExecutorStateReader;
  readonly hub: TopicHub;
  readonly timers: RuntimeTimers;
  readonly log: OperationalLog;
  /** Status, executor generation and account keys are re-read at most this often (§6.2). */
  readonly stateTtlMs?: number;
  /**
   * A run with no output for this long is forgotten, with its ownership and dedupe state. Never
   * shorter than {@link RUN_OUTPUT_REPLAY_WINDOW_MS}, because the dedupe is the replay protection.
   */
  readonly idleRunMs?: number;
  /** Sequence numbers remembered per run for deduplication. */
  readonly dedupeWindow?: number;
  readonly maxRuns?: number;
}

const executing = new Set<string>(executingRunStatuses);

/**
 * How long a signed request can be replayed after the api first accepts it: a signature is fresh
 * within ±300 seconds of its timestamp, so one signed by a worker clock 300 seconds ahead stays
 * fresh for 601 seconds of api time. A run's dedupe state is kept at least this long after its last
 * request, so a replay always meets the `seq` it repeats.
 */
export const RUN_OUTPUT_REPLAY_WINDOW_MS = (2 * INTERNAL_SIGNATURE_WINDOW_SECONDS + 1) * 1000;

function copyKey(key: AccountDataKey | null): AccountDataKey | null {
  return key ? { ...key, key: Uint8Array.from(key.key) } : null;
}

/**
 * The api side of the run output path (§8.2): deduplicates on `(runId, seq)`, checks run ownership
 * (cached for the run's life) and status and executor generation (re-read at most every 10 seconds),
 * decrypts the `run_chunk` envelope under the owner's account key, and relays each UI chunk on
 * `conversation:<id>` through the topic hub, which buffers it for replay. Chunks are never persisted
 * and never logged.
 *
 * The dedupe is also the endpoint's replay protection (the event id replay memory is left to
 * internal events), so a run's state is never dropped while a request for it could still be
 * replayed: idle runs are forgotten only after the replay window, a full relay refuses new runs with
 * `capacity` instead of evicting a live one, and a run found missing or inactive keeps its entry, so
 * replaying a rejected request costs no D1 read either.
 */
export class RunOutputRelay {
  private readonly runs = new Map<string, RunEntry>();
  private readonly keys = new Map<string, KeyEntry>();
  private readonly stateTtlMs: number;
  private readonly idleRunMs: number;
  private readonly dedupeWindow: number;
  private readonly maxRuns: number;

  constructor(private readonly options: RunOutputRelayOptions) {
    this.stateTtlMs = options.stateTtlMs ?? 10_000;
    this.idleRunMs = Math.max(options.idleRunMs ?? 15 * 60_000, RUN_OUTPUT_REPLAY_WINDOW_MS);
    this.dedupeWindow = options.dedupeWindow ?? 4_096;
    this.maxRuns = options.maxRuns ?? 10_000;
  }

  get trackedRuns(): number {
    return this.runs.size;
  }

  async accept(pathRunId: string, body: RunOutputBody): Promise<RelayResult> {
    const { hub, log } = this.options;
    if (hub.isShuttingDown) return this.reject(body, "shutting_down");
    if (body.runId !== pathRunId) return this.reject(body, "run_mismatch");
    this.evictIdle();
    if (!this.options.source) return this.reject(body, "unknown_run");

    const entry = this.entry(body.runId);
    if (!entry) return this.reject(body, "capacity");
    if (this.isDuplicate(entry, body.seq)) return { status: "duplicate" };
    if (entry.missingAt !== null && this.options.timers.now() - entry.missingAt < this.stateTtlMs) {
      return this.reject(body, "unknown_run");
    }

    let ownership: RunRelayOwnership | null;
    let state: RunRelayState | null;
    let currentGeneration: number;
    try {
      ownership = await this.ownership(entry, body.runId);
      if (!ownership) return this.reject(body, "unknown_run", entry);
      state = await this.state(entry, body.runId);
      if (!state) return this.reject(body, "unknown_run", entry);
      entry.missingAt = null;
      currentGeneration = (await this.options.executorState.readCached(this.stateTtlMs)).generation;
    } catch (error) {
      log.warn("internal.run_output_lookup_failed", { runId: body.runId, code: errorCode(error) });
      return this.reject(body, "unavailable");
    }
    if (!executing.has(state.status)) return this.reject(body, "inactive_run");
    if (state.executorGeneration !== currentGeneration)
      return this.reject(body, "stale_generation");

    let key: AccountDataKey | null;
    try {
      key = await this.accountKey(ownership.ownerId);
    } catch (error) {
      // A D1 timeout or network failure says nothing about the envelope: the worker must retry it,
      // exactly like a failed ownership or status lookup.
      log.warn("internal.run_output_key_failed", { runId: body.runId, code: errorCode(error) });
      return this.reject(body, "unavailable");
    }
    // No key row at all: the account was crypto-shredded (§5.6), so the envelope can never decrypt.
    if (!key) return this.reject(body, "undecryptable");

    let chunks: UiMessageChunk[];
    try {
      const plaintext = decryptFieldText(
        key,
        runChunkContext(ownership.ownerId, body.runId, body.seq),
        body.envelope,
      );
      zeroize(key.key);
      let parsed: unknown;
      try {
        parsed = JSON.parse(plaintext);
      } catch {
        return this.reject(body, "invalid_plaintext");
      }
      const result = runChunkBatchSchema.safeParse(parsed);
      if (!result.success) return this.reject(body, "invalid_plaintext");
      chunks = result.data;
    } catch (error) {
      zeroize(key.key);
      log.warn("internal.run_output_decrypt_failed", {
        runId: body.runId,
        seq: body.seq,
        error: errorName(error),
        code: errorCode(error),
      });
      return this.reject(body, "undecryptable");
    }

    // No await between this check and the publication, so concurrent duplicates relay once.
    if (this.isDuplicate(entry, body.seq)) return { status: "duplicate" };
    this.remember(entry, body.seq);
    const audience = { ownerId: ownership.ownerId, conversationId: ownership.conversationId };
    let relayed = 0;
    for (const chunk of chunks) {
      const data: RunChunkEventData = { runId: body.runId, chunk };
      try {
        await hub.publishToConversation(audience, { type: RUN_CHUNK_EVENT_TYPE, data });
        relayed += 1;
      } catch (error) {
        log.warn("internal.run_output_publish_failed", {
          runId: body.runId,
          seq: body.seq,
          code: errorCode(error),
        });
      }
    }
    return { status: "accepted", relayed };
  }

  /** Forgets every cached key and run, zeroising key material (shutdown and tests). */
  clear(): void {
    for (const entry of this.keys.values()) if (entry.key) zeroize(entry.key.key);
    this.keys.clear();
    this.runs.clear();
  }

  private reject(body: RunOutputBody, reason: RelayRejection, entry?: RunEntry): RelayResult {
    if (entry && reason === "unknown_run") {
      // The run is gone (or never existed): drop what was cached about it, but keep its dedupe
      // state and remember the miss, so neither a replay nor a retry storm reaches D1 again at once.
      entry.ownership = null;
      entry.state = undefined;
      entry.missingAt = this.options.timers.now();
    }
    this.options.log.warn("internal.run_output_rejected", {
      runId: body.runId,
      seq: body.seq,
      attempt: body.attempt,
      reason,
    });
    return { status: "rejected", reason };
  }

  /** The run's entry, or null when the relay is full of runs still inside their replay window. */
  private entry(runId: string): RunEntry | null {
    const now = this.options.timers.now();
    let entry = this.runs.get(runId);
    if (!entry) {
      if (this.runs.size >= this.maxRuns && !this.evictOutsideReplayWindow(now)) return null;
      entry = {
        ownership: null,
        missingAt: null,
        ownershipPromise: undefined,
        state: undefined,
        statePromise: undefined,
        seen: new Set(),
        maxSeq: -1,
        lastUsedAt: now,
      };
      this.runs.set(runId, entry);
    }
    entry.lastUsedAt = now;
    return entry;
  }

  private isDuplicate(entry: RunEntry, seq: number): boolean {
    return entry.seen.has(seq) || seq <= entry.maxSeq - this.dedupeWindow;
  }

  private remember(entry: RunEntry, seq: number): void {
    entry.seen.add(seq);
    if (seq > entry.maxSeq) entry.maxSeq = seq;
    const floor = entry.maxSeq - this.dedupeWindow;
    if (entry.seen.size > this.dedupeWindow) {
      for (const known of entry.seen) if (known <= floor) entry.seen.delete(known);
    }
  }

  private async ownership(entry: RunEntry, runId: string): Promise<RunRelayOwnership | null> {
    if (entry.ownership) return entry.ownership;
    const source = this.options.source as RunRelaySource;
    entry.ownershipPromise ??= source.ownership(runId).finally(() => {
      entry.ownershipPromise = undefined;
    });
    const ownership = await entry.ownershipPromise;
    if (ownership && ownership.runId === runId) entry.ownership = ownership;
    return ownership && ownership.runId === runId ? ownership : null;
  }

  private async state(entry: RunEntry, runId: string): Promise<RunRelayState | null> {
    const now = this.options.timers.now();
    if (entry.state && now - entry.state.readAt < this.stateTtlMs) return entry.state.value;
    const source = this.options.source as RunRelaySource;
    entry.statePromise ??= source.state(runId).finally(() => {
      entry.statePromise = undefined;
    });
    const value = await entry.statePromise;
    entry.state = { value, readAt: this.options.timers.now() };
    return value;
  }

  /**
   * The owner's account key, re-read at most every 10 seconds. Callers get a private copy and zeroise
   * it after use, so a concurrent refresh or eviction that zeroises the cached key between this
   * lookup and the decryption can never hand a zeroed key to a request in flight.
   */
  private async accountKey(ownerId: string): Promise<AccountDataKey | null> {
    const now = this.options.timers.now();
    const cached = this.keys.get(ownerId);
    if (cached && now - cached.readAt < this.stateTtlMs) return copyKey(cached.key);
    const key = await this.options.accountKeys.load(ownerId);
    const previous = this.keys.get(ownerId);
    if (previous?.key && previous.key !== key) zeroize(previous.key.key);
    this.keys.set(ownerId, { key, readAt: this.options.timers.now() });
    return copyKey(key);
  }

  /** Forgets one run whose last request left the replay window; false when there is none. */
  private evictOutsideReplayWindow(now: number): boolean {
    for (const [runId, entry] of this.runs) {
      if (now - entry.lastUsedAt >= RUN_OUTPUT_REPLAY_WINDOW_MS) {
        this.runs.delete(runId);
        return true;
      }
    }
    return false;
  }

  private evictIdle(): void {
    const now = this.options.timers.now();
    for (const [runId, entry] of this.runs) {
      if (now - entry.lastUsedAt >= this.idleRunMs) this.runs.delete(runId);
    }
    for (const [ownerId, entry] of this.keys) {
      if (now - entry.readAt >= this.stateTtlMs) {
        if (entry.key) zeroize(entry.key.key);
        this.keys.delete(ownerId);
      }
    }
  }
}
