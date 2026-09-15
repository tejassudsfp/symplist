import type { WorkerConfig } from "@symplist/config/worker";
import type { ManagedKeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import type { ObjectStore } from "@symplist/storage";
import { createWorkerDb, createWorkerKeyProvider, createWorkerObjectStore } from "./clients.ts";
import { loadWorkerRuntimeConfig } from "./config.ts";
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
  return {
    config,
    db: createWorkerDb(config),
    objects: createWorkerObjectStore(config),
    keys,
    logger,
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
