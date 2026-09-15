import type { AccountKeyStore } from "@symplist/core/account";
import type { RunRelaySource } from "@symplist/core/events";
import type { KeyProvider } from "@symplist/crypto";
import type { OperationalLog, RuntimeTimers } from "../../infra/scheduler/runtime.ts";

/** What the bootstrap supplies to the internal endpoints module. */
export interface InternalDependencies {
  /** Holds `INTERNAL_EVENT_SECRET` for the request signatures (§6.2). */
  readonly keys: KeyProvider;
  /** Loads the run owner's account data key to decrypt run output (§8.2). */
  readonly accountKeys: Pick<AccountKeyStore, "load">;
  /** The `runs` reader from the core events contributors (supplied by Simon); null until one exists. */
  readonly runRelaySource: RunRelaySource | null;
  readonly timers?: RuntimeTimers;
  readonly log?: OperationalLog;
  readonly tuning?: {
    readonly replayMemoryCapacity?: number;
    readonly runStateTtlMs?: number;
  };
}

export const INTERNAL_DEPENDENCIES = "symplist:internal-dependencies";
