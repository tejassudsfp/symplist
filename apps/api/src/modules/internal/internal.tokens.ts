import type { RunRelaySource } from "@symplist/core/events";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import type { OperationalLog, RuntimeTimers } from "../../infra/scheduler/runtime.ts";

/** What the bootstrap supplies to the internal endpoints module. */
export interface InternalDependencies {
  readonly db: DbClient;
  /** Holds `INTERNAL_EVENT_SECRET` and `CONTENT_KEK`. */
  readonly keys: KeyProvider;
  /** Defaults to the `runs` reader from the core events contributors (supplied by Simon). */
  readonly runRelaySource?: RunRelaySource | null;
  readonly timers?: RuntimeTimers;
  readonly log?: OperationalLog;
  readonly tuning?: {
    readonly replayMemoryCapacity?: number;
    readonly runStateTtlMs?: number;
  };
}

export const INTERNAL_DEPENDENCIES = "symplist:internal-dependencies";
