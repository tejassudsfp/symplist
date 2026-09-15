import type { PurgeContributor } from "./types.ts";

/** Search purge statements (§5.6). Search indexes and search intents. */
export const searchPurgeContributor: PurgeContributor = {
  domain: "search",
  statements: () => [],
};
