/** Canonical feature ids. Every per-feature seam (contracts, Nest modules, web features) uses these names. */
export const featureIds = [
  "access",
  "workspace",
  "documents",
  "search",
  "scheduling",
  "vault",
  "sharing",
  "mcp",
  "analytics",
] as const;

export type FeatureId = (typeof featureIds)[number];
