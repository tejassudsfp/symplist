import type { ArchiveContributor } from "./types.ts";

/** Search task-archive statements (§2.1). Insert `search_intents` for the archived tasks (§10.1). */
export const searchArchiveContributor: ArchiveContributor = {
  domain: "search",
  statements: () => [],
};
