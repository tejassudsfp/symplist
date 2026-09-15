import { localDataPaths } from "@symplist/config";
import type { WorkerConfig } from "@symplist/config/worker";
import { createKeyProvider, type ManagedKeyProvider } from "@symplist/crypto";
import {
  type Clock,
  createD1RestClient,
  createLocalSqliteClient,
  createWorkerLane,
  type D1CircuitBreaker,
  type D1Counters,
  type DbClient,
  type FetchLike,
  processLane,
  type RateLane,
} from "@symplist/db";
import { createLocalObjectStore, createR2ObjectStore, type ObjectStore } from "@symplist/storage";
import { d1QueueFamilyConcurrency } from "../queues.ts";
import { WorkerError } from "./errors.ts";

/**
 * The per-process worker lane (§3.1): `1 req/s ÷ N` sustained with a burst of 4, where N is the D1
 * queue family's total concurrency, so every D1-using task process together stays at or below 1 req/s.
 */
export function workerProcessLane(options: { readonly clock?: Clock } = {}): RateLane {
  return options.clock
    ? createWorkerLane({ clock: options.clock, familyConcurrency: d1QueueFamilyConcurrency })
    : processLane("worker");
}

/**
 * The worker D1 client on its own token and lane (§3.1), counting its requests in `counters` (the
 * process's `d1.requests` counters) when given. Only tasks that declare a D1 family queue may import
 * this module; `queues.test.ts` enforces it.
 */
export function createWorkerDb(
  config: WorkerConfig,
  options: {
    readonly fetch?: FetchLike;
    readonly lane?: RateLane;
    readonly counters?: D1Counters;
    readonly circuit?: D1CircuitBreaker;
    readonly clock?: Clock;
  } = {},
): DbClient {
  if (config.DATA_DRIVER === "local") {
    // The same file the api uses under LOCAL_DATA_DIR, so `trigger dev` and the api share state.
    return createLocalSqliteClient({
      path: localDataPaths(config.LOCAL_DATA_DIR).database,
      env: { NODE_ENV: config.NODE_ENV },
    });
  }
  const { CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, CLOUDFLARE_D1_WORKER_API_TOKEN } = config;
  if (!CLOUDFLARE_ACCOUNT_ID || !D1_DATABASE_ID || !CLOUDFLARE_D1_WORKER_API_TOKEN) {
    throw new WorkerError("config.invalid");
  }
  return createD1RestClient({
    accountId: CLOUDFLARE_ACCOUNT_ID,
    databaseId: D1_DATABASE_ID,
    apiToken: CLOUDFLARE_D1_WORKER_API_TOKEN,
    lane: options.lane ?? workerProcessLane(),
    runtime: "worker",
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.counters ? { counters: options.counters } : {}),
    ...(options.circuit ? { circuit: options.circuit } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
}

/** R2 for `DATA_DRIVER=d1`, the local filesystem store under `LOCAL_DATA_DIR` otherwise (§1, A7). */
export function createWorkerObjectStore(config: WorkerConfig): ObjectStore {
  if (config.DATA_DRIVER === "local") {
    return createLocalObjectStore({
      root: localDataPaths(config.LOCAL_DATA_DIR).objects,
      env: { NODE_ENV: config.NODE_ENV },
    });
  }
  const { CLOUDFLARE_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = config;
  if (!CLOUDFLARE_ACCOUNT_ID || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new WorkerError("config.invalid");
  }
  return createR2ObjectStore({
    accountId: CLOUDFLARE_ACCOUNT_ID,
    bucket: R2_BUCKET,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  });
}

/** The worker's key provider: `CONTENT_KEK`, `INTERNAL_EVENT_SECRET` and `REMINDER_UNSUBSCRIBE_SECRET` (§4.5). */
export function createWorkerKeyProvider(config: WorkerConfig): ManagedKeyProvider {
  return createKeyProvider(
    {
      CONTENT_KEK: config.CONTENT_KEK,
      INTERNAL_EVENT_SECRET: config.INTERNAL_EVENT_SECRET,
      REMINDER_UNSUBSCRIBE_SECRET: config.REMINDER_UNSUBSCRIBE_SECRET,
    },
    { required: ["CONTENT_KEK", "INTERNAL_EVENT_SECRET", "REMINDER_UNSUBSCRIBE_SECRET"] },
  );
}
