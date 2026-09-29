import type { KeyProvider } from "@symplist/crypto";
import type { OperationalLog, RuntimeTimers } from "../../infra/scheduler/runtime.ts";

/** What the bootstrap supplies to the internal endpoints module. */
export interface InternalDependencies {
  /** Holds `INTERNAL_EVENT_SECRET` for the request signatures (§6.2). */
  readonly keys: KeyProvider;
  readonly timers?: RuntimeTimers;
  readonly log?: OperationalLog;
  readonly tuning?: {
    readonly replayMemoryCapacity?: number;
  };
}

export const INTERNAL_DEPENDENCIES = "symplist:internal-dependencies";
