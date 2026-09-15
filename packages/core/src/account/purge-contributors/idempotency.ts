import type { PurgeContributor } from "./types.ts";

/** Idempotency purge statements (§5.6). Idempotency records. */
export const idempotencyPurgeContributor: PurgeContributor = {
  domain: "idempotency",
  statements: () => [],
};
