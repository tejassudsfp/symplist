import type { PurgeContributor } from "./types.ts";

/** Preferences purge statements (§5.6). User preferences. */
export const preferencesPurgeContributor: PurgeContributor = {
  domain: "preferences",
  statements: () => [],
};
