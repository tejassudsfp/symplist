import type {
  ExecutionKindDefinition,
  ExecutionSeamDependencies,
  RunRelaySource,
} from "../execution.ts";
import { accountEventsContributor } from "./account.ts";
import { simonEventsContributor } from "./simon.ts";
import type { EventsContributor } from "./types.ts";

export { ACCOUNT_PURGE_TASK_ID } from "./account.ts";
export type { EventsContributor } from "./types.ts";

/** Every domain's execution contribution (§2.3). */
export const eventsContributors: readonly EventsContributor[] = [
  simonEventsContributor,
  accountEventsContributor,
];

/**
 * The execution kinds of a contributor list, keyed by kind. Throws when two definitions claim the
 * same kind or Trigger task, so a misconfiguration fails at startup rather than dispatching twice.
 */
export function collectExecutionKinds(
  contributors: readonly EventsContributor[] = eventsContributors,
): ReadonlyMap<string, ExecutionKindDefinition> {
  const kinds = new Map<string, ExecutionKindDefinition>();
  const tasks = new Set<string>();
  for (const contributor of contributors) {
    for (const definition of contributor.executionKinds) {
      if (!/^[a-z0-9_]{1,64}$/.test(definition.kind)) {
        throw new Error(`Invalid dispatch intent kind "${definition.kind}"`);
      }
      if (kinds.has(definition.kind)) {
        throw new Error(`Dispatch intent kind "${definition.kind}" is declared twice`);
      }
      if (tasks.has(definition.triggerTaskId)) {
        throw new Error(`Trigger task "${definition.triggerTaskId}" is claimed by two kinds`);
      }
      kinds.set(definition.kind, definition);
      tasks.add(definition.triggerTaskId);
    }
  }
  return kinds;
}

/** Builds the single run relay source, or null when no domain supplies one yet. */
export function createRunRelaySource(
  dependencies: ExecutionSeamDependencies,
  contributors: readonly EventsContributor[] = eventsContributors,
): RunRelaySource | null {
  const factories = contributors.flatMap((contributor) =>
    contributor.runRelaySource ? [contributor.runRelaySource] : [],
  );
  if (factories.length > 1) throw new Error("Only one domain may supply the run relay source");
  return factories[0]?.(dependencies) ?? null;
}
