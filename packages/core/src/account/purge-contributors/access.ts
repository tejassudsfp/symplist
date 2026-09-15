import type { PurgeContributor } from "./types.ts";

/** Access purge statements (§5.6). Beta redemptions and access grants. */
export const accessPurgeContributor: PurgeContributor = {
  domain: "access",
  statements: () => [],
};
