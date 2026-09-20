import type { CoreDomain } from "../../domains.ts";
import type {
  ExecutionKindDefinition,
  ExecutionSeamDependencies,
  RunRelaySource,
} from "../execution.ts";

/**
 * A domain's contribution to dispatch, reconciliation and the run output relay (§2.3, §8.1, §8.2).
 * Contributors are plain values, so the executor switch command can use them without booting Nest.
 */
export interface EventsContributor {
  readonly domain: CoreDomain;
  /** Dispatch intent kinds the domain records in `dispatch_intents`. */
  readonly executionKinds: readonly ExecutionKindDefinition[];
  /** The `runs` reader for relayed run output; only the domain that owns `runs` supplies it. */
  readonly runRelaySource?: (dependencies: ExecutionSeamDependencies) => RunRelaySource;
}
