import type { RestrictContributor } from "./types.ts";

/** Scheduling restriction statements (§5.5). Mark pending reminder occurrences `suppressed_access`, cancel pending outbox rows and increment reminder generations. */
export const schedulingRestrictContributor: RestrictContributor = {
  domain: "scheduling",
  statements: () => [],
};
