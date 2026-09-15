import type { PurgeContributor } from "./types.ts";

/** Tasks purge statements (§5.6). Tasks. */
export const tasksPurgeContributor: PurgeContributor = {
  domain: "tasks",
  statements: () => [],
};
