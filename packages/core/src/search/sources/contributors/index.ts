import type { SearchLog } from "../../log.ts";
import { D1SearchTaskSource } from "../tasks.ts";
import type { SearchSourceContributor, SearchSourceDependencies, SearchSources } from "../types.ts";
import { documentsSearchSourceContributor } from "./documents.ts";
import { preferencesSearchSourceContributor } from "./preferences.ts";
import { schedulingSearchSourceContributor } from "./scheduling.ts";
import { simonSearchSourceContributor } from "./simon.ts";

/** Every domain's search source contribution (§2.3). */
export const searchSourceContributors: readonly SearchSourceContributor[] = [
  documentsSearchSourceContributor,
  simonSearchSourceContributor,
  preferencesSearchSourceContributor,
  schedulingSearchSourceContributor,
];

type OptionalSource = "documents" | "messages" | "chatOptIn" | "deadlines";

/**
 * Builds the sources of a runtime from the contributors. Throws when two domains supply the same
 * source, so a misconfiguration fails at startup instead of indexing from the wrong records.
 */
export function createSearchSources(
  dependencies: SearchSourceDependencies & { readonly log?: SearchLog },
  contributors: readonly SearchSourceContributor[] = searchSourceContributors,
): SearchSources {
  const pick = <Name extends OptionalSource>(name: Name) => {
    const factories = contributors.flatMap((contributor) => {
      const factory = contributor[name];
      return factory ? [factory] : [];
    });
    if (factories.length > 1)
      throw new Error(`Only one domain may supply the search ${name} source`);
    const factory = factories[0] as ((deps: SearchSourceDependencies) => unknown) | undefined;
    return factory ? factory(dependencies) : null;
  };
  return {
    tasks: new D1SearchTaskSource(dependencies.db, dependencies.log),
    documents: pick("documents") as SearchSources["documents"],
    messages: pick("messages") as SearchSources["messages"],
    chatOptIn: pick("chatOptIn") as SearchSources["chatOptIn"],
    deadlines: pick("deadlines") as SearchSources["deadlines"],
  };
}
