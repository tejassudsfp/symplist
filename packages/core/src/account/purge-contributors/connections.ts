import type { PurgeContributor } from "./types.ts";

/** Connections purge statements (§5.6). Connections, connection attempts and the Composio session record. */
export const connectionsPurgeContributor: PurgeContributor = {
  domain: "connections",
  statements: () => [],
};
