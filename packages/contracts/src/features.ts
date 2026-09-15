/** Canonical feature ids. Every per-feature seam (contracts, Nest modules, web features) uses these names. */
export const featureIds = [
  "access",
  "workspace",
  "documents",
  "search",
  "simon",
  "scheduling",
  "vault",
  "sharing",
  "connections",
  "analytics",
] as const;

export type FeatureId = (typeof featureIds)[number];
