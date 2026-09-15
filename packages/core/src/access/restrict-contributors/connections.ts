import type { RestrictContributor } from "./types.ts";

/** Connections restriction statements (§5.5). Expire pending connection attempts. */
export const connectionsRestrictContributor: RestrictContributor = {
  domain: "connections",
  statements: () => [],
};
