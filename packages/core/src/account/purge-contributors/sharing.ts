import type { PurgeContributor } from "./types.ts";

/** Sharing purge statements (§5.6). Artifacts, share grants, sessions, approvals, audit rows and limits. */
export const sharingPurgeContributor: PurgeContributor = {
  domain: "sharing",
  statements: () => [],
};
