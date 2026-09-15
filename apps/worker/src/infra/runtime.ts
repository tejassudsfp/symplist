import type { WorkerConfig } from "@symplist/config/worker";
import type { ManagedKeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import type { ObjectStore } from "@symplist/storage";
import { createWorkerDb, createWorkerKeyProvider, createWorkerObjectStore } from "./clients.ts";
import { loadWorkerRuntimeConfig } from "./config.ts";
import { createWorkerD1Counters, WorkerD1CounterReporter } from "./d1-counters.ts";
import { InternalEventClient } from "./internal-events.ts";
import { createWorkerLogger, type WorkerLogger } from "./logger.ts";
import { RunOutputPushClient, type RunOutputPushOptions } from "./run-output.ts";

/** Process-wide worker dependencies, created once per task process. */
export interface WorkerRuntime {
  readonly config: WorkerConfig;
  readonly db: DbClient;
  readonly objects: ObjectStore;
  readonly keys: ManagedKeyProvider;
  readonly logger: WorkerLogger;
  /** Reports the process's `d1.requests` counters every minute and at the end of each task run. */
  readonly d1Counters: WorkerD1CounterReporter;
  readonly events: InternalEventClient;
  runOutput(
    options: Pick<RunOutputPushOptions, "runId" | "ownerId" | "attempt" | "accountKey">,
  ): RunOutputPushClient;
}

let runtime: WorkerRuntime | undefined;

/** Builds the worker runtime from an environment (tests pass their own). */
export function createWorkerRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkerRuntime {
  const config = loadWorkerRuntimeConfig(env);
  const keys = createWorkerKeyProvider(config);
  const logger = createWorkerLogger();
  const counters = createWorkerD1Counters();
  const d1Counters = new WorkerD1CounterReporter({ counters, logger });
  d1Counters.start();
  return {
    config,
    db: createWorkerDb(config, { counters }),
    objects: createWorkerObjectStore(config),
    keys,
    logger,
    d1Counters,
    events: new InternalEventClient({ keys, apiOrigin: config.API_ORIGIN, logger }),
    runOutput: (options) =>
      new RunOutputPushClient({ ...options, keys, apiOrigin: config.API_ORIGIN, logger }),
  };
}

/** The runtime of this task process, created on first use. */
export function workerRuntime(): WorkerRuntime {
  runtime ??= createWorkerRuntime();
  return runtime;
}
