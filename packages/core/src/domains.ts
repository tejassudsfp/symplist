/** Core domain folders; each owns its services and SQL under `core/src/<domain>/` (§2.3). */
export const coreDomains = [
  "access",
  "account",
  "tasks",
  "preferences",
  "idempotency",
  "events",
  "documents",
  "search",
  "scheduling",
  "vault",
  "sharing",
  "mcp",
  "analytics",
] as const;

export type CoreDomain = (typeof coreDomains)[number];
