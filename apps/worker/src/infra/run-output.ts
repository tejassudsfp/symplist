import { runOutputPath, type UiMessageChunk, uiMessageChunkSchema } from "@symplist/core/events";
import {
  type AccountDataKey,
  encryptFieldText,
  type KeyProvider,
  runChunkContext,
} from "@symplist/crypto";
import { toWorkerError } from "./errors.ts";
import type { WorkerLogger } from "./logger.ts";
import { deliver, signedApiRequest, type WorkerFetch } from "./signed-request.ts";
import { sleep, systemWorkerTimers, type WorkerTimers } from "./timers.ts";

/** Where a run's UI message chunks go (§8.2); the local executor writes to the api buffer instead. */
export interface RunOutputSink {
  write(chunk: UiMessageChunk): void;
  flush(): Promise<void>;
  close(): Promise<RunOutputStats>;
}

export interface RunOutputStats {
  readonly batchesSent: number;
  readonly batchesDropped: number;
  readonly chunksSent: number;
  readonly chunksDropped: number;
}

export interface RunOutputPushOptions {
  readonly runId: string;
  readonly ownerId: string;
  /** The Trigger attempt number. */
  readonly attempt: number;
  /** The owner's account data key; chunks are sealed as `run_chunk` field envelopes under it. */
  readonly accountKey: AccountDataKey;
  /** Holds `INTERNAL_EVENT_SECRET` for the request signature. */
  readonly keys: KeyProvider;
  readonly apiOrigin: string;
  readonly logger: WorkerLogger;
  readonly fetch?: WorkerFetch;
  readonly timers?: WorkerTimers;
  /** Flush when this much serialized output is buffered (§8.2: 2 KB). */
  readonly flushBytes?: number;
  /** Flush buffered output at most this long after the first chunk (§8.2: 100 ms). */
  readonly flushIntervalMs?: number;
  /** Delivery attempts per batch (§8.2: 3). */
  readonly maxAttempts?: number;
  /** All attempts of a batch fit in this window (§8.2: 5 seconds). */
  readonly retryWindowMs?: number;
  /** Chunks buffered while batches are in flight; beyond this new chunks are dropped. */
  readonly maxBufferedBytes?: number;
  /** Batches waiting behind one in flight; beyond this a new batch is dropped. */
  readonly maxPendingBatches?: number;
}

/** One chunk may be at most this large, so an envelope stays within the api's 2 MiB body limit. */
export const MAX_RUN_CHUNK_BYTES = 768 * 1024;

const encoder = new TextEncoder();

/**
 * The worker's `RunSink` for durable runs (§8.2): buffers UI chunks, flushes ordered batches at most
 * every 100 ms or at 2 KB as encrypted `run_chunk` envelopes with a monotonic `seq`, signs each POST
 * (§6.2), retries a batch up to 3 times within 5 seconds and then drops it and carries on. Chunk
 * contents never reach a log, a thrown error or any Trigger sink.
 */
export class RunOutputPushClient implements RunOutputSink {
  private readonly timers: WorkerTimers;
  private readonly fetchImpl: WorkerFetch;
  private buffer: UiMessageChunk[] = [];
  private bufferedBytes = 0;
  private timer: unknown;
  private chain: Promise<void> = Promise.resolve();
  private nextSeq = 0;
  private pendingBatches = 0;
  private closed = false;
  private stats = { batchesSent: 0, batchesDropped: 0, chunksSent: 0, chunksDropped: 0 };

  constructor(private readonly options: RunOutputPushOptions) {
    this.timers = options.timers ?? systemWorkerTimers;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  }

  write(chunk: UiMessageChunk): void {
    if (this.closed || !uiMessageChunkSchema.safeParse(chunk).success) {
      this.drop(1, "run_output.chunk_refused");
      return;
    }
    let size: number;
    try {
      size = encoder.encode(JSON.stringify(chunk)).byteLength;
    } catch {
      this.drop(1, "run_output.chunk_refused");
      return;
    }
    if (size > MAX_RUN_CHUNK_BYTES) {
      this.drop(1, "run_output.chunk_oversize");
      return;
    }
    const limit = this.options.maxBufferedBytes ?? 4 * 1024 * 1024;
    if (this.bufferedBytes + size > limit) {
      this.drop(1, "run_output.buffer_full");
      return;
    }
    this.buffer.push(chunk);
    this.bufferedBytes += size;
    if (this.bufferedBytes >= (this.options.flushBytes ?? 2048)) {
      void this.flush();
    } else if (this.timer === undefined) {
      this.timer = this.timers.setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.options.flushIntervalMs ?? 100);
    }
  }

  /** Sends everything buffered now, after any batch already in flight. */
  flush(): Promise<void> {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buffer.length > 0) {
      const batch = this.buffer;
      this.buffer = [];
      this.bufferedBytes = 0;
      const seq = this.nextSeq;
      this.nextSeq += 1;
      if (this.pendingBatches >= (this.options.maxPendingBatches ?? 64)) {
        this.stats.batchesDropped += 1;
        this.stats.chunksDropped += batch.length;
        this.options.logger.warn("run_output.batch_dropped", {
          runId: this.options.runId,
          seq,
          code: "run_output.backlog_full",
          count: batch.length,
        });
        return this.chain;
      }
      this.pendingBatches += 1;
      this.chain = this.chain
        .then(() => this.send(seq, batch))
        .finally(() => {
          this.pendingBatches -= 1;
        });
    }
    return this.chain;
  }

  async close(): Promise<RunOutputStats> {
    await this.flush();
    this.closed = true;
    this.options.logger.info("run_output.closed", {
      runId: this.options.runId,
      batchesSentCount: this.stats.batchesSent,
      batchesDroppedCount: this.stats.batchesDropped,
      chunksSentCount: this.stats.chunksSent,
      chunksDroppedCount: this.stats.chunksDropped,
    });
    return { ...this.stats };
  }

  private async send(seq: number, batch: readonly UiMessageChunk[]): Promise<void> {
    const { runId, ownerId, attempt, accountKey, keys, apiOrigin, logger } = this.options;
    let body: Uint8Array;
    try {
      const envelope = encryptFieldText(
        accountKey,
        runChunkContext(ownerId, runId, seq),
        JSON.stringify(batch),
      );
      body = encoder.encode(JSON.stringify({ runId, attempt, seq, envelope }));
    } catch (error) {
      this.dropBatch(seq, batch.length, toWorkerError(error).code, 0);
      return;
    }

    const maxAttempts = this.options.maxAttempts ?? 3;
    const deadline = this.timers.now() + (this.options.retryWindowMs ?? 5_000);
    let lastStatus: number | null = null;
    for (let tryNumber = 1; tryNumber <= maxAttempts; tryNumber += 1) {
      const remaining = deadline - this.timers.now();
      if (remaining <= 0) break;
      const request = signedApiRequest({
        apiOrigin,
        path: runOutputPath(runId),
        body,
        keys,
        timers: this.timers,
      });
      const result = await deliver(
        this.fetchImpl,
        request,
        this.timers,
        Math.min(remaining, 2_000),
      );
      lastStatus = result.status;
      if (result.outcome === "delivered" || result.outcome === "duplicate") {
        this.stats.batchesSent += 1;
        this.stats.chunksSent += batch.length;
        return;
      }
      if (result.outcome === "rejected") {
        this.dropBatch(seq, batch.length, "run_output.rejected", tryNumber, lastStatus);
        return;
      }
      if (tryNumber < maxAttempts) {
        const wait = Math.min(250 * 3 ** (tryNumber - 1), deadline - this.timers.now());
        if (wait > 0) await sleep(this.timers, wait);
      }
    }
    logger.warn("run_output.retries_exhausted", { runId, seq, attempt });
    this.dropBatch(seq, batch.length, "run_output.unreachable", maxAttempts, lastStatus);
  }

  private dropBatch(
    seq: number,
    chunks: number,
    code: string,
    tries: number,
    status: number | null = null,
  ): void {
    this.stats.batchesDropped += 1;
    this.stats.chunksDropped += chunks;
    this.options.logger.warn("run_output.batch_dropped", {
      runId: this.options.runId,
      seq,
      code,
      count: chunks,
      tryCount: tries,
      httpStatus: status,
    });
  }

  private drop(chunks: number, code: string): void {
    this.stats.chunksDropped += chunks;
    this.options.logger.warn("run_output.chunk_dropped", {
      runId: this.options.runId,
      code,
      count: chunks,
    });
  }
}
