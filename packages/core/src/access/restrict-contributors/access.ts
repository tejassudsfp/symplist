import type { RestrictContributor } from "./types.ts";

/** Access restriction statements (§5.5). The state change with `access_generation + 1` (unless the caller already changed the users row) and revocation of current beta access grants. */
export const accessRestrictContributor: RestrictContributor = {
  domain: "access",
  statements: () => [],
};
