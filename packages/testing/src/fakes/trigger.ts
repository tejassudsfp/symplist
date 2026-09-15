import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { type Clock, FakeClock } from "./clock.ts";
import { findMarkerIn } from "./markers.ts";

/**
 * An in-memory stand-in for the Trigger.dev v4 SDK surface Symplist uses (§8.1, §8.3, §8.8,
 * research "Trigger"): `tasks.trigger`/`triggerAndWait`/`batchTrigger` with idempotency keys, delays
 * and TTLs, `runs.retrieve`/`cancel` with the SDK's status flags, imperative and declarative
 * `schedules`, and the `logger` and `metadata` APIs. Registered task handlers run in process.
 *
 * Every payload, trigger option, tag, metadata write, output, thrown error and logger call is
 * recorded, so marker-string tests can assert that no content reaches a Trigger-hosted sink.
 */

export type FakeRunStatus =
  | "PENDING_VERSION"
  | "DELAYED"
  | "QUEUED"
  | "DEQUEUED"
  | "EXECUTING"
  | "WAITING"
  | "COMPLETED"
  | "CANCELED"
  | "FAILED"
  | "CRASHED"
  | "SYSTEM_FAILURE"
  | "EXPIRED"
  | "TIMED_OUT";

/** Statuses the SDK reports as failed; a failed run releases its idempotency key. */
export const failedRunStatuses: readonly FakeRunStatus[] = [
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
];
const queuedStatuses: readonly FakeRunStatus[] = ["PENDING_VERSION", "QUEUED", "DELAYED"];
const executingStatuses: readonly FakeRunStatus[] = ["DEQUEUED", "EXECUTING"];
const terminalStatuses: readonly FakeRunStatus[] = [...failedRunStatuses, "COMPLETED", "CANCELED"];

export type FakeMachine =
  | "micro"
  | "small-1x"
  | "small-2x"
  | "medium-1x"
  | "medium-2x"
  | "large-1x"
  | "large-2x";

/** The `TriggerOptions` fields Symplist passes (research "Triggering, batching, idempotency"). */
export interface FakeTriggerOptions {
  readonly idempotencyKey?: string | readonly string[];
  /** Duration such as `30s`, `10m`, `1h`, `1d`, `1w`; defaults to 30 days. */
  readonly idempotencyKeyTTL?: string;
  /** Duration string or seconds; the run expires if it has not started in time. `0` opts out. */
  readonly ttl?: string | number;
  readonly delay?: string | Date;
  readonly tags?: string | readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly machine?: FakeMachine;
  readonly maxAttempts?: number;
  readonly queue?: string;
  readonly concurrencyKey?: string;
  readonly priority?: number;
  readonly maxDuration?: number;
}

export interface FakeRunHandle {
  readonly id: string;
  readonly publicAccessToken: string;
  readonly taskIdentifier: string;
}

export type FakeTaskRunResult<Output = unknown> =
  | {
      readonly ok: true;
      readonly id: string;
      readonly taskIdentifier: string;
      readonly output: Output;
    }
  | {
      readonly ok: false;
      readonly id: string;
      readonly taskIdentifier: string;
      readonly error: unknown;
    };

export interface FakeRunError {
  readonly name?: string;
  readonly message: string;
  readonly stackTrace?: string;
}

/** The `runs.retrieve` shape, including the SDK's boolean helpers. */
export interface FakeRetrievedRun {
  readonly id: string;
  readonly taskIdentifier: string;
  readonly status: FakeRunStatus;
  readonly payload: unknown;
  readonly output: unknown;
  readonly error: FakeRunError | undefined;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
  readonly tags: readonly string[];
  /** The caller's key material (not the scoped hash), as the SDK reports it. */
  readonly idempotencyKey: string | undefined;
  readonly idempotencyKeyScope: FakeIdempotencyKeyScope | undefined;
  readonly machine: FakeMachine | undefined;
  readonly attemptCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly startedAt: Date | undefined;
  readonly finishedAt: Date | undefined;
  readonly delayedUntil: Date | undefined;
  readonly expiredAt: Date | undefined;
  readonly ttl: string | undefined;
  readonly isTest: boolean;
  readonly isQueued: boolean;
  readonly isExecuting: boolean;
  readonly isWaiting: boolean;
  readonly isCompleted: boolean;
  readonly isSuccess: boolean;
  readonly isFailed: boolean;
  readonly isCancelled: boolean;
}

export type FakeEnvironment = "DEVELOPMENT" | "STAGING" | "PRODUCTION" | "PREVIEW";

/** The SDK 4.6 `BatchRunHandle`: no run ids. */
export interface FakeBatchRunHandle {
  readonly batchId: string;
  readonly runCount: number;
  readonly publicAccessToken: string;
}

/** The `ctx` fields a task handler receives. */
export interface FakeTaskRunContext {
  readonly run: {
    readonly id: string;
    readonly tags: readonly string[];
    /** The caller's key material, not the hash. */
    readonly idempotencyKey: string | undefined;
    readonly idempotencyKeyScope: FakeIdempotencyKeyScope | undefined;
    readonly isTest: boolean;
    readonly createdAt: Date;
  };
  readonly task: { readonly id: string };
  readonly attempt: { readonly number: number };
  readonly environment: { readonly type: FakeEnvironment };
  readonly machine: { readonly name: FakeMachine };
}

export type FakeTaskHandler = (
  payload: unknown,
  params: { readonly ctx: FakeTaskRunContext; readonly signal: AbortSignal },
) => unknown;

export interface FakeTaskDefinition {
  /** Default `retry.maxAttempts`; a trigger's `maxAttempts` overrides it. */
  readonly maxAttempts?: number;
  readonly machine?: FakeMachine;
}

export type FakeLogLevel = "debug" | "log" | "info" | "warn" | "error";

export interface FakeLogRecord {
  readonly level: FakeLogLevel;
  readonly message: string;
  readonly properties: Readonly<Record<string, unknown>> | undefined;
  readonly runId: string | null;
}

export interface FakeMetadataRecord {
  readonly runId: string | null;
  readonly operation: "set" | "del" | "append" | "remove" | "increment" | "decrement" | "replace";
  readonly key: string | null;
  readonly value: unknown;
}

export interface FakeTriggerRecord {
  readonly via: "trigger" | "triggerAndWait" | "batchTrigger" | "schedule";
  readonly taskIdentifier: string;
  readonly payload: unknown;
  readonly options: FakeTriggerOptions | undefined;
  readonly runId: string;
  /** True when an idempotency key returned an existing run instead of creating one. */
  readonly deduplicated: boolean;
  readonly parentRunId: string | null;
}

export interface FakeOutputRecord {
  readonly runId: string;
  readonly output: unknown;
  /** True when the run had already been cancelled, so the platform would discard the output. */
  readonly discarded: boolean;
}

export interface FakeErrorRecord {
  readonly runId: string;
  readonly attempt: number;
  readonly error: unknown;
}

export type FakeTriggerSink =
  | "payload"
  | "options"
  | "tags"
  | "idempotencyKey"
  | "metadata"
  | "output"
  | "error"
  | "log"
  | "schedule";

export interface FakeTriggerMarkerHit {
  readonly sink: FakeTriggerSink;
  readonly runId: string | null;
  readonly path: string;
}

export interface FakeScheduleObject {
  readonly id: string;
  readonly type: "DECLARATIVE" | "IMPERATIVE";
  readonly task: string;
  readonly active: boolean;
  readonly deduplicationKey: string | null;
  readonly externalId: string | null;
  readonly generator: {
    readonly type: "CRON";
    readonly expression: string;
    readonly description: string;
  };
  readonly timezone: string;
  readonly environments: ReadonlyArray<{ readonly id: string; readonly type: FakeEnvironment }>;
}

export interface FakeCreateScheduleOptions {
  readonly task: string;
  readonly cron: string;
  readonly timezone?: string;
  readonly externalId?: string;
  readonly deduplicationKey?: string;
}

export interface FakeDeclarativeSchedule {
  readonly task: string;
  readonly cron:
    | string
    | {
        readonly pattern: string;
        readonly timezone?: string;
        readonly environments?: readonly FakeEnvironment[];
      };
}

/** The payload a scheduled task receives. `upcoming` is left empty by the fake. */
export interface FakeScheduledTaskPayload {
  readonly type: "DECLARATIVE" | "IMPERATIVE";
  readonly timestamp: Date;
  readonly lastTimestamp: Date | undefined;
  readonly timezone: string;
  readonly scheduleId: string;
  readonly externalId: string | undefined;
  readonly upcoming: readonly Date[];
}

/** Mirrors the SDK's `ApiError` shape for 4xx responses. */
export class FakeTriggerApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface RunState {
  readonly id: string;
  readonly taskIdentifier: string;
  readonly payload: unknown;
  readonly options: FakeTriggerOptions | undefined;
  readonly tags: string[];
  readonly idempotencyKey: string | undefined;
  readonly idempotencyKeyScope: FakeIdempotencyKeyScope | undefined;
  /** `<taskIdentifier> NUL <hash>`: the entry in the deduplication map. */
  readonly idempotencyScope: string | undefined;
  readonly machine: FakeMachine | undefined;
  readonly maxAttempts: number;
  readonly ttlMs: number | undefined;
  readonly ttlLabel: string | undefined;
  readonly createdAt: number;
  readonly parentRunId: string | null;
  status: FakeRunStatus;
  metadata: Record<string, unknown> | undefined;
  output: unknown;
  error: FakeRunError | undefined;
  attemptCount: number;
  updatedAt: number;
  startedAt: number | undefined;
  finishedAt: number | undefined;
  delayedUntil: number | undefined;
  queuedAt: number;
  expiredAt: number | undefined;
  cancelRequested: boolean;
  controller: AbortController | undefined;
  execution: Promise<void> | undefined;
}

interface ScheduleState {
  object: FakeScheduleObject;
  lastTimestamp: Date | undefined;
}

const durationUnits: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parses Trigger duration strings such as `30s`, `10m`, `2h`, `1d` or `1w`. */
export function parseTriggerDuration(value: string): number {
  const match = /^(\d+)(s|m|h|d|w)$/.exec(value.trim());
  if (!match?.[1] || !match[2]) throw new FakeTriggerApiError(400, `Invalid duration "${value}"`);
  return Number(match[1]) * (durationUnits[match[2]] ?? 0);
}

const cronField = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/;

function assertCron(expression: string): void {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || !fields.every((field) => cronField.test(field))) {
    throw new FakeTriggerApiError(400, "Invalid cron expression: five fields are required");
  }
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new FakeTriggerApiError(400, "Invalid timezone");
  }
}

function toTags(tags: FakeTriggerOptions["tags"]): string[] {
  if (tags === undefined) return [];
  const list = typeof tags === "string" ? [tags] : [...tags];
  if (list.length > 10) throw new FakeTriggerApiError(400, "A run can have at most 10 tags");
  for (const tag of list) {
    if (tag.length < 1 || tag.length > 128) {
      throw new FakeTriggerApiError(400, "Tags must be 1-128 characters");
    }
  }
  return list;
}

/** `idempotencyKeys.create` scopes (`@trigger.dev/core` 4.6.0). */
export type FakeIdempotencyKeyScope = "run" | "attempt" | "global";

/**
 * The SDK's idempotency key hash: SHA-256 hex over the key material joined with `-`
 * (`@trigger.dev/core` 4.6.0 `createIdempotencyKey`). A 64-character string is treated as an
 * already-hashed key, exactly as the SDK's `isIdempotencyKey` does.
 */
export function hashTriggerIdempotencyKey(material: readonly string[]): string {
  return createHash("sha256").update(material.join("-")).digest("hex");
}

function keyParts(key: string | readonly string[]): string[] {
  const parts = typeof key === "string" ? [key] : [...key];
  const joined = parts.join("-");
  if (joined.length < 1 || joined.length > 2048) {
    throw new FakeTriggerApiError(400, "Idempotency keys must be 1-2048 characters");
  }
  return parts;
}

function dedupeEntry(taskIdentifier: string, hash: string): string {
  return `${taskIdentifier}\u0000${hash}`;
}

/** Copies a recorded value so later mutation by the caller cannot hide what was sent. */
function snapshotValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function serializeError(error: unknown): FakeRunError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stackTrace: error.stack }),
    };
  }
  return { message: typeof error === "string" ? error : "Unknown error" };
}

export interface FakeTriggerClientOptions {
  readonly clock?: Clock;
  readonly environment?: FakeEnvironment;
}

export class FakeTriggerClient {
  readonly clock: Clock;
  readonly environment: FakeEnvironment;

  /** Every call to `tasks.trigger`, `triggerAndWait`, `batchTrigger` and every fired schedule. */
  readonly triggers: FakeTriggerRecord[] = [];
  readonly outputs: FakeOutputRecord[] = [];
  readonly errors: FakeErrorRecord[] = [];
  readonly logs: FakeLogRecord[] = [];
  readonly metadataWrites: FakeMetadataRecord[] = [];
  /** Run ids passed to `runs.cancel`, in order. */
  readonly cancellations: string[] = [];

  private readonly handlers = new Map<
    string,
    { handler: FakeTaskHandler; definition: FakeTaskDefinition }
  >();
  private readonly runStates = new Map<string, RunState>();
  private readonly idempotency = new Map<string, { runId: string; expiresAt: number }>();
  /** Keys made by `idempotencyKeys.create`, mapped back to their material and scope. */
  private readonly keyCatalog = new Map<
    string,
    { readonly key: string; readonly scope: FakeIdempotencyKeyScope }
  >();
  private readonly scheduleStates = new Map<string, ScheduleState>();
  private readonly currentRun = new AsyncLocalStorage<RunState>();
  private runSequence = 0;
  private scheduleSequence = 0;
  private batchSequence = 0;
  private readonly batches = new Map<string, readonly string[]>();

  constructor(options: FakeTriggerClientOptions = {}) {
    this.clock = options.clock ?? new FakeClock();
    this.environment = options.environment ?? "PRODUCTION";
  }

  /** Registers the run function for a task id, as `task({ id, run })` would. */
  registerTask(id: string, handler: FakeTaskHandler, definition: FakeTaskDefinition = {}): void {
    this.handlers.set(id, { handler, definition });
  }

  readonly tasks = {
    trigger: async (
      taskIdentifier: string,
      payload: unknown,
      options?: FakeTriggerOptions,
    ): Promise<FakeRunHandle> => {
      const { run } = this.createRun(taskIdentifier, payload, options, "trigger");
      return this.handleFor(run);
    },

    /** Runs the child in process and resolves with its result, like awaiting a subtask. */
    triggerAndWait: async (
      taskIdentifier: string,
      payload: unknown,
      options?: FakeTriggerOptions,
    ): Promise<FakeTaskRunResult> => {
      const parent = this.currentRun.getStore();
      if (!parent) {
        // The SDK refuses waits from backend code; only a task can wait on a child.
        throw new Error("triggerAndWait can only be used from inside a task.run()");
      }
      const { run } = this.createRun(taskIdentifier, payload, options, "triggerAndWait");
      this.transition(parent, "WAITING");
      try {
        if (!terminalStatuses.includes(run.status)) {
          if (!this.handlers.has(taskIdentifier)) {
            throw new FakeTriggerApiError(
              404,
              `No handler registered for task "${taskIdentifier}"`,
            );
          }
          this.refreshTimers(run);
          if (run.status === "DELAYED") {
            throw new FakeTriggerApiError(
              400,
              "triggerAndWait does not support delayed runs in the fake",
            );
          }
          await this.execute(run.id);
        }
      } finally {
        if (parent.status === "WAITING") this.transition(parent, "EXECUTING");
      }
      return run.status === "COMPLETED"
        ? { ok: true, id: run.id, taskIdentifier, output: run.output }
        : { ok: false, id: run.id, taskIdentifier, error: run.error ?? { message: run.status } };
    },

    /**
     * `tasks.batchTrigger`: returns the SDK 4.6 `BatchRunHandle` (`batchId`, `runCount`,
     * `publicAccessToken`), which carries no run ids; tests read them with `batchRuns(batchId)`. An
     * item without its own key gets `[batchKey, index]` when the batch has a key, as in the SDK.
     */
    batchTrigger: async (
      taskIdentifier: string,
      items: ReadonlyArray<{ readonly payload: unknown; readonly options?: FakeTriggerOptions }>,
      options?: {
        readonly idempotencyKey?: string | readonly string[];
        readonly idempotencyKeyTTL?: string;
      },
    ): Promise<FakeBatchRunHandle> => {
      if (items.length > 1000)
        throw new FakeTriggerApiError(400, "A batch holds at most 1,000 items");
      const batchKey = options?.idempotencyKey;
      const runIds = items.map((item, index) => {
        const itemKey =
          item.options?.idempotencyKey ??
          (batchKey === undefined
            ? undefined
            : [...(typeof batchKey === "string" ? [batchKey] : batchKey), `${index}`]);
        const itemTtl = item.options?.idempotencyKeyTTL ?? options?.idempotencyKeyTTL;
        const itemOptions: FakeTriggerOptions | undefined =
          itemKey === undefined
            ? item.options
            : {
                ...item.options,
                idempotencyKey: itemKey,
                ...(itemTtl === undefined ? {} : { idempotencyKeyTTL: itemTtl }),
              };
        return this.createRun(taskIdentifier, item.payload, itemOptions, "batchTrigger").run.id;
      });
      this.batchSequence += 1;
      const batchId = `batch_fake${String(this.batchSequence).padStart(6, "0")}`;
      this.batches.set(batchId, runIds);
      return {
        batchId,
        runCount: runIds.length,
        publicAccessToken: `fake_public_token_${batchId}`,
      };
    },
  };

  readonly runs = {
    retrieve: async (runId: string): Promise<FakeRetrievedRun> => {
      const run = this.requireRun(runId);
      this.refreshTimers(run);
      return this.snapshot(run);
    },

    /** Cancels a run that has not finished; a no-op for finished runs (§8.1 Stop). */
    cancel: async (runId: string): Promise<{ readonly id: string }> => {
      const run = this.requireRun(runId);
      this.cancellations.push(runId);
      this.refreshTimers(run);
      if (terminalStatuses.includes(run.status)) return { id: runId };
      run.cancelRequested = true;
      this.transition(run, "CANCELED");
      run.finishedAt = this.clock.now();
      run.controller?.abort(new Error("Run cancelled"));
      return { id: runId };
    },

    reschedule: async (
      runId: string,
      body: { readonly delay: string | Date },
    ): Promise<FakeRetrievedRun> => {
      const run = this.requireRun(runId);
      this.refreshTimers(run);
      if (run.status !== "DELAYED") {
        throw new FakeTriggerApiError(400, "Only delayed runs can be rescheduled");
      }
      run.delayedUntil = this.resolveDelay(body.delay);
      run.updatedAt = this.clock.now();
      return this.snapshot(run);
    },
  };

  /**
   * `idempotencyKeys` with the SDK 4.6.0 scoping rules. A raw string or array passed to `trigger` is
   * hashed with `run` scope: inside a task the parent run id joins the key material, so the same
   * raw key triggered from two different runs (for example a Symplist retry run) creates two child
   * runs; from backend code there is no run and the key behaves as global.
   */
  readonly idempotencyKeys = {
    /** `idempotencyKeys.create(key, { scope })`: returns the 64-character hash. */
    create: async (
      key: string | readonly string[],
      options: { readonly scope?: FakeIdempotencyKeyScope } = {},
    ): Promise<string> => {
      const scope = options.scope ?? "run";
      const parts = keyParts(key);
      const hash = hashTriggerIdempotencyKey([...parts, ...this.scopeSuffix(scope)]);
      this.keyCatalog.set(hash, { key: parts.join("-"), scope });
      return hash;
    },

    /**
     * Releases a key so it can trigger a new run. Mirrors the SDK: a created (or 64-character) key is
     * used as is; a raw key is re-hashed with `options.scope` (default `run`), which outside a task
     * requires `parentRunId` and otherwise throws, as the SDK does.
     */
    reset: async (
      taskIdentifier: string,
      key: string | readonly string[],
      options: {
        readonly scope?: FakeIdempotencyKeyScope;
        readonly parentRunId?: string;
        readonly attemptNumber?: number;
      } = {},
    ): Promise<{ readonly id: string }> => {
      const is64 = typeof key === "string" && key.length === 64;
      let hash: string;
      if (is64 && (this.keyCatalog.has(key) || options.scope === undefined)) {
        hash = key;
      } else {
        const scope = options.scope ?? "run";
        const current = this.currentRun.getStore();
        let suffix: string[] = [];
        if (scope === "run" || scope === "attempt") {
          const parentRunId = options.parentRunId ?? current?.id;
          const attemptNumber = options.attemptNumber ?? current?.attemptCount;
          if (parentRunId === undefined || (scope === "attempt" && attemptNumber === undefined)) {
            if (!is64) {
              throw new Error(
                `resetIdempotencyKey: parentRunId is required for '${scope}' scope when called outside a task context`,
              );
            }
          } else {
            suffix = scope === "run" ? [parentRunId] : [parentRunId, String(attemptNumber)];
          }
        }
        const computed = hashTriggerIdempotencyKey([...keyParts(key), ...suffix]);
        hash =
          is64 && !this.idempotency.has(dedupeEntry(taskIdentifier, computed))
            ? (key as string)
            : computed;
      }
      const entryKey = dedupeEntry(taskIdentifier, hash);
      const entry = this.idempotency.get(entryKey);
      this.idempotency.delete(entryKey);
      return { id: entry?.runId ?? hash };
    },
  };

  readonly logger = {
    debug: (message: string, properties?: Record<string, unknown>) =>
      this.log("debug", message, properties),
    log: (message: string, properties?: Record<string, unknown>) =>
      this.log("log", message, properties),
    info: (message: string, properties?: Record<string, unknown>) =>
      this.log("info", message, properties),
    warn: (message: string, properties?: Record<string, unknown>) =>
      this.log("warn", message, properties),
    error: (message: string, properties?: Record<string, unknown>) =>
      this.log("error", message, properties),
  };

  /** Run metadata for the executing run. Outside a run it is a recorded no-op, like the SDK. */
  readonly metadata = {
    set: (key: string, value: unknown) => {
      this.writeMetadata("set", key, value, (bag) => {
        bag[key] = value;
      });
      return this.metadata;
    },
    del: (key: string) => {
      this.writeMetadata("del", key, undefined, (bag) => {
        delete bag[key];
      });
      return this.metadata;
    },
    append: (key: string, value: unknown) => {
      this.writeMetadata("append", key, value, (bag) => {
        const existing = bag[key];
        bag[key] = Array.isArray(existing)
          ? [...existing, value]
          : existing === undefined
            ? [value]
            : [existing, value];
      });
      return this.metadata;
    },
    remove: (key: string, value: unknown) => {
      this.writeMetadata("remove", key, value, (bag) => {
        const existing = bag[key];
        if (Array.isArray(existing)) {
          bag[key] = existing.filter((entry) => JSON.stringify(entry) !== JSON.stringify(value));
        }
      });
      return this.metadata;
    },
    increment: (key: string, value = 1) => {
      this.writeMetadata("increment", key, value, (bag) => {
        const existing = bag[key];
        bag[key] = (typeof existing === "number" ? existing : 0) + value;
      });
      return this.metadata;
    },
    decrement: (key: string, value = 1) => {
      this.writeMetadata("decrement", key, value, (bag) => {
        const existing = bag[key];
        bag[key] = (typeof existing === "number" ? existing : 0) - value;
      });
      return this.metadata;
    },
    replace: (value: Record<string, unknown>) => {
      this.writeMetadata("replace", null, value, (bag) => {
        for (const key of Object.keys(bag)) delete bag[key];
        Object.assign(bag, value);
      });
      return this.metadata;
    },
    current: (): Readonly<Record<string, unknown>> | undefined => {
      const run = this.currentRun.getStore();
      return run?.metadata === undefined ? undefined : { ...run.metadata };
    },
    get: (key: string): unknown => this.currentRun.getStore()?.metadata?.[key],
    flush: async (): Promise<void> => undefined,
  };

  readonly schedules = {
    create: async (options: FakeCreateScheduleOptions): Promise<FakeScheduleObject> => {
      assertCron(options.cron);
      if (options.timezone !== undefined) assertTimeZone(options.timezone);
      if (options.deduplicationKey !== undefined) {
        const existing = [...this.scheduleStates.values()].find(
          (state) => state.object.deduplicationKey === options.deduplicationKey,
        );
        if (existing) {
          existing.object = this.buildSchedule(
            existing.object.id,
            "IMPERATIVE",
            options,
            existing.object.active,
          );
          return existing.object;
        }
      }
      const id = this.nextScheduleId();
      const object = this.buildSchedule(id, "IMPERATIVE", options, true);
      this.scheduleStates.set(id, { object, lastTimestamp: undefined });
      return object;
    },
    retrieve: async (scheduleId: string): Promise<FakeScheduleObject> =>
      this.requireSchedule(scheduleId).object,
    list: async (
      options: { readonly page?: number; readonly perPage?: number } = {},
    ): Promise<{
      readonly data: readonly FakeScheduleObject[];
      readonly pagination: {
        readonly currentPage: number;
        readonly totalPages: number;
        readonly count: number;
      };
    }> => {
      const all = [...this.scheduleStates.values()].map((state) => state.object);
      const perPage = Math.max(1, Math.min(options.perPage ?? 10, 100));
      const page = Math.max(1, options.page ?? 1);
      return {
        data: all.slice((page - 1) * perPage, page * perPage),
        pagination: {
          currentPage: page,
          totalPages: Math.max(1, Math.ceil(all.length / perPage)),
          count: all.length,
        },
      };
    },
    update: async (
      scheduleId: string,
      options: FakeCreateScheduleOptions,
    ): Promise<FakeScheduleObject> => {
      const state = this.requireImperativeSchedule(scheduleId);
      assertCron(options.cron);
      if (options.timezone !== undefined) assertTimeZone(options.timezone);
      state.object = this.buildSchedule(scheduleId, "IMPERATIVE", options, state.object.active);
      return state.object;
    },
    activate: async (scheduleId: string): Promise<FakeScheduleObject> => {
      const state = this.requireImperativeSchedule(scheduleId);
      state.object = { ...state.object, active: true };
      return state.object;
    },
    deactivate: async (scheduleId: string): Promise<FakeScheduleObject> => {
      const state = this.requireImperativeSchedule(scheduleId);
      state.object = { ...state.object, active: false };
      return state.object;
    },
    del: async (scheduleId: string): Promise<{ readonly id: string }> => {
      this.requireImperativeSchedule(scheduleId);
      this.scheduleStates.delete(scheduleId);
      return { id: scheduleId };
    },
  };

  /**
   * Declares a `schedules.task` cron (§8.8, §12.2). Declarative schedules sync on deploy and cannot be
   * updated, deactivated or deleted through the API.
   */
  declareSchedule(declaration: FakeDeclarativeSchedule): FakeScheduleObject {
    const cron =
      typeof declaration.cron === "string" ? { pattern: declaration.cron } : declaration.cron;
    assertCron(cron.pattern);
    if (cron.timezone !== undefined) assertTimeZone(cron.timezone);
    const id = this.nextScheduleId();
    const environments = cron.environments ?? ["DEVELOPMENT", "STAGING", "PRODUCTION", "PREVIEW"];
    const object: FakeScheduleObject = {
      id,
      type: "DECLARATIVE",
      task: declaration.task,
      active: true,
      deduplicationKey: null,
      externalId: null,
      generator: { type: "CRON", expression: cron.pattern, description: cron.pattern },
      timezone: cron.timezone ?? "UTC",
      environments: environments.map((type, index) => ({ id: `env_${index + 1}`, type })),
    };
    this.scheduleStates.set(id, { object, lastTimestamp: undefined });
    return object;
  }

  /**
   * Fires a schedule at the clock's current time. Returns null when the schedule is inactive or does
   * not run in this environment (for example DEVELOPMENT for `environments: ['PRODUCTION', 'STAGING']`).
   */
  async fireSchedule(scheduleId: string): Promise<FakeRunHandle | null> {
    const state = this.requireSchedule(scheduleId);
    const { object } = state;
    if (!object.active) return null;
    if (!object.environments.some((environment) => environment.type === this.environment))
      return null;
    const timestamp = new Date(this.clock.now());
    const payload: FakeScheduledTaskPayload = {
      type: object.type,
      timestamp,
      lastTimestamp: state.lastTimestamp,
      timezone: object.timezone,
      scheduleId: object.id,
      externalId: object.externalId ?? undefined,
      upcoming: [],
    };
    state.lastTimestamp = timestamp;
    const { run } = this.createRun(object.task, payload, undefined, "schedule");
    return this.handleFor(run);
  }

  /** Executes the oldest runnable run. Returns its final snapshot, or null when nothing can run. */
  async runNext(): Promise<FakeRetrievedRun | null> {
    for (const run of this.runStates.values()) this.refreshTimers(run);
    const next = [...this.runStates.values()].find(
      (run) => run.status === "QUEUED" && run.execution === undefined,
    );
    if (!next) return null;
    await this.execute(next.id);
    return this.snapshot(next);
  }

  /** Executes queued runs until none is runnable, including runs they trigger. Returns the count. */
  async runUntilIdle(maxRuns = 1000): Promise<number> {
    let count = 0;
    while (await this.runNext()) {
      count += 1;
      if (count >= maxRuns) throw new Error(`runUntilIdle stopped after ${maxRuns} runs`);
    }
    return count;
  }

  /** Executes one queued run by id with its registered handler. */
  async execute(runId: string): Promise<FakeRetrievedRun> {
    const run = this.requireRun(runId);
    this.refreshTimers(run);
    if (run.execution) {
      await run.execution;
      return this.snapshot(run);
    }
    if (run.status !== "QUEUED") {
      throw new FakeTriggerApiError(409, `Run ${runId} is ${run.status}, not QUEUED`);
    }
    const registration = this.handlers.get(run.taskIdentifier);
    if (!registration) {
      throw new FakeTriggerApiError(404, `No handler registered for task "${run.taskIdentifier}"`);
    }
    run.execution = this.attempt(run, registration.handler);
    await run.execution;
    return this.snapshot(run);
  }

  /** Moves a queued run to EXECUTING without running a handler, for reconciler tests. */
  startRun(runId: string): void {
    const run = this.requireRun(runId);
    this.refreshTimers(run);
    if (run.status !== "QUEUED")
      throw new FakeTriggerApiError(409, `Run ${runId} is ${run.status}`);
    run.startedAt = this.clock.now();
    run.attemptCount += 1;
    this.transition(run, "EXECUTING");
  }

  /** Completes a started run with an output, for reconciler tests. */
  completeRun(runId: string, output: unknown): void {
    const run = this.requireActiveRun(runId);
    this.outputs.push({ runId, output, discarded: false });
    run.output = output;
    run.finishedAt = this.clock.now();
    this.transition(run, "COMPLETED");
  }

  /** Ends a run in a failure status (for example CRASHED after an out-of-memory kill). */
  failRun(
    runId: string,
    status: "FAILED" | "CRASHED" | "SYSTEM_FAILURE" | "TIMED_OUT",
    error: unknown = new Error(status),
  ): void {
    const run = this.requireActiveRun(runId);
    this.errors.push({ runId, attempt: Math.max(1, run.attemptCount), error });
    run.error = serializeError(error);
    run.finishedAt = this.clock.now();
    this.transition(run, status);
  }

  /** The runs a `batchTrigger` call created or deduplicated to, in item order (test helper). */
  batchRuns(batchId: string): FakeRetrievedRun[] {
    const runIds = this.batches.get(batchId);
    if (!runIds) throw new FakeTriggerApiError(404, "Batch not found");
    return runIds.map((runId) => {
      const run = this.requireRun(runId);
      this.refreshTimers(run);
      return this.snapshot(run);
    });
  }

  /** Every recorded run, newest last. */
  allRuns(): FakeRetrievedRun[] {
    return [...this.runStates.values()].map((run) => {
      this.refreshTimers(run);
      return this.snapshot(run);
    });
  }

  /**
   * Finds `marker` in every recorded Trigger sink: payloads, trigger options, tags, idempotency keys,
   * metadata (initial and written), outputs, thrown errors, logger calls and schedules.
   */
  findMarker(marker: string): FakeTriggerMarkerHit[] {
    const hits: FakeTriggerMarkerHit[] = [];
    const add = (sink: FakeTriggerSink, runId: string | null, value: unknown, root: string) => {
      for (const location of findMarkerIn(value, marker, root)) {
        hits.push({ sink, runId, path: location.path });
      }
    };
    for (const record of this.triggers) {
      add("payload", record.runId, record.payload, "payload");
      const { tags, idempotencyKey, metadata, ...rest } = record.options ?? {};
      add("options", record.runId, rest, "options");
      add("tags", record.runId, tags, "tags");
      add("idempotencyKey", record.runId, idempotencyKey, "idempotencyKey");
      add("metadata", record.runId, metadata, "metadata");
    }
    for (const run of this.runStates.values()) add("metadata", run.id, run.metadata, "metadata");
    for (const write of this.metadataWrites) {
      add("metadata", write.runId, { key: write.key, value: write.value }, "metadataWrite");
    }
    for (const record of this.outputs) add("output", record.runId, record.output, "output");
    for (const record of this.errors) add("error", record.runId, record.error, "error");
    for (const record of this.logs) {
      add("log", record.runId, { message: record.message, properties: record.properties }, "log");
    }
    for (const state of this.scheduleStates.values())
      add("schedule", null, state.object, "schedule");
    return hits;
  }

  /** The SDK's scope suffix for the current task context. */
  private scopeSuffix(scope: FakeIdempotencyKeyScope): string[] {
    const run = this.currentRun.getStore();
    if (!run || scope === "global") return [];
    return scope === "run" ? [run.id] : [run.id, String(run.attemptCount)];
  }

  /** `makeIdempotencyKey`: 64-character keys pass through; anything else is hashed with `run` scope. */
  private resolveTriggerKey(key: string | readonly string[]): {
    readonly hash: string;
    readonly key: string;
    readonly scope: FakeIdempotencyKeyScope | undefined;
  } {
    const parts = keyParts(key);
    if (typeof key === "string" && key.length === 64) {
      const created = this.keyCatalog.get(key);
      return { hash: key, key: created?.key ?? key, scope: created?.scope };
    }
    return {
      hash: hashTriggerIdempotencyKey([...parts, ...this.scopeSuffix("run")]),
      key: parts.join("-"),
      scope: "run",
    };
  }

  private nextScheduleId(): string {
    this.scheduleSequence += 1;
    return `sched_fake${String(this.scheduleSequence).padStart(6, "0")}`;
  }

  private buildSchedule(
    id: string,
    type: FakeScheduleObject["type"],
    options: FakeCreateScheduleOptions,
    active: boolean,
  ): FakeScheduleObject {
    return {
      id,
      type,
      task: options.task,
      active,
      deduplicationKey: options.deduplicationKey ?? null,
      externalId: options.externalId ?? null,
      generator: { type: "CRON", expression: options.cron, description: options.cron },
      timezone: options.timezone ?? "UTC",
      environments: [{ id: "env_1", type: this.environment }],
    };
  }

  private requireSchedule(scheduleId: string): ScheduleState {
    const state = this.scheduleStates.get(scheduleId);
    if (!state) throw new FakeTriggerApiError(404, "Schedule not found");
    return state;
  }

  private requireImperativeSchedule(scheduleId: string): ScheduleState {
    const state = this.requireSchedule(scheduleId);
    if (state.object.type === "DECLARATIVE") {
      throw new FakeTriggerApiError(400, "Declarative schedules cannot be changed through the API");
    }
    return state;
  }

  private log(level: FakeLogLevel, message: string, properties?: Record<string, unknown>): void {
    this.logs.push({
      level,
      message,
      properties: properties === undefined ? undefined : snapshotValue(properties),
      runId: this.currentRun.getStore()?.id ?? null,
    });
  }

  private writeMetadata(
    operation: FakeMetadataRecord["operation"],
    key: string | null,
    value: unknown,
    apply: (bag: Record<string, unknown>) => void,
  ): void {
    const run = this.currentRun.getStore();
    this.metadataWrites.push({
      runId: run?.id ?? null,
      operation,
      key,
      value: value === undefined ? undefined : snapshotValue(value),
    });
    if (!run) return;
    run.metadata ??= {};
    apply(run.metadata);
    const size = JSON.stringify(run.metadata).length;
    if (size > 256 * 1024) throw new FakeTriggerApiError(413, "Run metadata exceeds 256KB");
    run.updatedAt = this.clock.now();
  }

  private resolveDelay(delay: string | Date): number {
    return delay instanceof Date ? delay.getTime() : this.clock.now() + parseTriggerDuration(delay);
  }

  private createRun(
    taskIdentifier: string,
    payload: unknown,
    options: FakeTriggerOptions | undefined,
    via: FakeTriggerRecord["via"],
  ): { run: RunState; deduplicated: boolean } {
    if (taskIdentifier === "") throw new FakeTriggerApiError(400, "A task identifier is required");
    const payloadSize = JSON.stringify(payload ?? null).length;
    if (payloadSize > 3 * 1024 * 1024) throw new FakeTriggerApiError(413, "Payload exceeds 3MB");
    const tags = toTags(options?.tags);
    const resolvedKey =
      options?.idempotencyKey === undefined
        ? undefined
        : this.resolveTriggerKey(options.idempotencyKey);
    const idempotencyKey = resolvedKey?.key;
    const parent = this.currentRun.getStore();
    const recordedPayload = snapshotValue(payload);
    const recordedOptions = options === undefined ? undefined : snapshotValue(options);

    const now = this.clock.now();
    const scope =
      resolvedKey === undefined ? undefined : dedupeEntry(taskIdentifier, resolvedKey.hash);
    if (scope !== undefined) {
      const entry = this.idempotency.get(scope);
      const existing = entry === undefined ? undefined : this.runStates.get(entry.runId);
      if (entry && existing && entry.expiresAt > now) {
        this.refreshTimers(existing);
        if (!failedRunStatuses.includes(existing.status)) {
          this.triggers.push({
            via,
            taskIdentifier,
            payload: recordedPayload,
            options: recordedOptions,
            runId: existing.id,
            deduplicated: true,
            parentRunId: parent?.id ?? null,
          });
          return { run: existing, deduplicated: true };
        }
      }
    }

    this.runSequence += 1;
    const id = `run_fake${String(this.runSequence).padStart(6, "0")}`;
    const registration = this.handlers.get(taskIdentifier);
    const ttl = options?.ttl;
    const ttlMs =
      ttl === undefined || ttl === 0
        ? undefined
        : typeof ttl === "number"
          ? ttl * 1000
          : parseTriggerDuration(ttl);
    const delayedUntil =
      options?.delay === undefined ? undefined : this.resolveDelay(options.delay);
    const run: RunState = {
      id,
      taskIdentifier,
      payload: recordedPayload,
      options: recordedOptions,
      tags,
      idempotencyKey,
      idempotencyKeyScope: resolvedKey?.scope,
      idempotencyScope: scope,
      machine: options?.machine ?? registration?.definition.machine,
      maxAttempts: Math.max(1, options?.maxAttempts ?? registration?.definition.maxAttempts ?? 1),
      ttlMs,
      ttlLabel: ttl === undefined ? undefined : String(ttl),
      createdAt: now,
      parentRunId: parent?.id ?? null,
      status: delayedUntil !== undefined && delayedUntil > now ? "DELAYED" : "QUEUED",
      metadata:
        options?.metadata === undefined ? undefined : snapshotValue({ ...options.metadata }),
      output: undefined,
      error: undefined,
      attemptCount: 0,
      updatedAt: now,
      startedAt: undefined,
      finishedAt: undefined,
      delayedUntil,
      queuedAt: delayedUntil !== undefined && delayedUntil > now ? delayedUntil : now,
      expiredAt: undefined,
      cancelRequested: false,
      controller: undefined,
      execution: undefined,
    };
    this.runStates.set(id, run);
    if (scope !== undefined) {
      const ttlForKey =
        options?.idempotencyKeyTTL === undefined
          ? 30 * 86_400_000
          : parseTriggerDuration(options.idempotencyKeyTTL);
      this.idempotency.set(scope, { runId: id, expiresAt: now + ttlForKey });
    }
    this.triggers.push({
      via,
      taskIdentifier,
      payload: recordedPayload,
      options: recordedOptions,
      runId: id,
      deduplicated: false,
      parentRunId: parent?.id ?? null,
    });
    return { run, deduplicated: false };
  }

  private handleFor(run: RunState): FakeRunHandle {
    return {
      id: run.id,
      publicAccessToken: `fake_public_token_${run.id}`,
      taskIdentifier: run.taskIdentifier,
    };
  }

  private refreshTimers(run: RunState): void {
    const now = this.clock.now();
    if (run.status === "DELAYED" && run.delayedUntil !== undefined && now >= run.delayedUntil) {
      run.queuedAt = run.delayedUntil;
      this.transition(run, "QUEUED");
    }
    if (run.status === "QUEUED" && run.ttlMs !== undefined && now >= run.queuedAt + run.ttlMs) {
      run.expiredAt = run.queuedAt + run.ttlMs;
      run.finishedAt = run.expiredAt;
      this.transition(run, "EXPIRED");
    }
  }

  private transition(run: RunState, status: FakeRunStatus): void {
    run.status = status;
    run.updatedAt = this.clock.now();
  }

  private requireRun(runId: string): RunState {
    const run = this.runStates.get(runId);
    if (!run) throw new FakeTriggerApiError(404, "Run not found");
    return run;
  }

  private requireActiveRun(runId: string): RunState {
    const run = this.requireRun(runId);
    if (!executingStatuses.includes(run.status) && run.status !== "WAITING") {
      throw new FakeTriggerApiError(409, `Run ${runId} is ${run.status}, not executing`);
    }
    return run;
  }

  private async attempt(run: RunState, handler: FakeTaskHandler): Promise<void> {
    run.startedAt = this.clock.now();
    while (run.attemptCount < run.maxAttempts) {
      if (run.cancelRequested) return;
      run.attemptCount += 1;
      const attemptNumber = run.attemptCount;
      run.controller = new AbortController();
      this.transition(run, "EXECUTING");
      const ctx: FakeTaskRunContext = {
        run: {
          id: run.id,
          tags: [...run.tags],
          idempotencyKey: run.idempotencyKey,
          idempotencyKeyScope: run.idempotencyKeyScope,
          isTest: false,
          createdAt: new Date(run.createdAt),
        },
        task: { id: run.taskIdentifier },
        attempt: { number: attemptNumber },
        environment: { type: this.environment },
        machine: { name: run.machine ?? "small-1x" },
      };
      try {
        const output = await this.currentRun.run(run, async () =>
          handler(snapshotValue(run.payload), {
            ctx,
            signal: run.controller?.signal ?? new AbortController().signal,
          }),
        );
        if (run.cancelRequested) {
          this.outputs.push({ runId: run.id, output, discarded: true });
          return;
        }
        this.outputs.push({ runId: run.id, output, discarded: false });
        const outputSize = JSON.stringify(output ?? null).length;
        if (outputSize > 10 * 1024 * 1024)
          throw new FakeTriggerApiError(413, "Output exceeds 10MB");
        run.output = output;
        run.finishedAt = this.clock.now();
        this.transition(run, "COMPLETED");
        return;
      } catch (error) {
        this.errors.push({ runId: run.id, attempt: attemptNumber, error });
        run.error = serializeError(error);
        if (run.cancelRequested) return;
      }
    }
    run.finishedAt = this.clock.now();
    this.transition(run, "FAILED");
  }

  private snapshot(run: RunState): FakeRetrievedRun {
    const status = run.status;
    return {
      id: run.id,
      taskIdentifier: run.taskIdentifier,
      status,
      payload: snapshotValue(run.payload),
      output: run.output === undefined ? undefined : snapshotValue(run.output),
      error: run.error,
      metadata: run.metadata === undefined ? undefined : snapshotValue(run.metadata),
      tags: [...run.tags],
      idempotencyKey: run.idempotencyKey,
      idempotencyKeyScope: run.idempotencyKeyScope,
      machine: run.machine,
      attemptCount: run.attemptCount,
      createdAt: new Date(run.createdAt),
      updatedAt: new Date(run.updatedAt),
      startedAt: run.startedAt === undefined ? undefined : new Date(run.startedAt),
      finishedAt: run.finishedAt === undefined ? undefined : new Date(run.finishedAt),
      delayedUntil: run.delayedUntil === undefined ? undefined : new Date(run.delayedUntil),
      expiredAt: run.expiredAt === undefined ? undefined : new Date(run.expiredAt),
      ttl: run.ttlLabel,
      isTest: false,
      isQueued: queuedStatuses.includes(status),
      isExecuting: executingStatuses.includes(status),
      isWaiting: status === "WAITING",
      isCompleted: status === "COMPLETED" || failedRunStatuses.includes(status),
      isSuccess: status === "COMPLETED",
      isFailed: failedRunStatuses.includes(status),
      isCancelled: status === "CANCELED",
    };
  }
}
