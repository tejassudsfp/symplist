import type { PurgeContributor } from "./types.ts";

/** Documents purge statements (§5.6). Document repositories, commits, publish requests, drafts and read receipts. */
export const documentsPurgeContributor: PurgeContributor = {
  domain: "documents",
  statements: () => [],
};
