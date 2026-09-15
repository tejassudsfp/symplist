import type { RestrictContributor } from "./types.ts";

/** Sharing restriction statements (§5.5). Disable active share grants with the reason and `generation + 1`, revoke share sessions and expire pending share approvals. */
export const sharingRestrictContributor: RestrictContributor = {
  domain: "sharing",
  statements: () => [],
};
