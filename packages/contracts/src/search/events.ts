import { z } from "zod";
import { counterSchema } from "../common/primitives.ts";
import { defineEvents } from "../common/ws.ts";

/**
 * `search.freshness` on the `user` topic (§7): the owner's published index generation and the number
 * of committed changes not yet in it. Announced after the index writer publishes a generation.
 */
export const searchFreshnessEventSchema = z.strictObject({
  generation: counterSchema,
  pending: counterSchema,
});

export type SearchFreshnessEvent = z.infer<typeof searchFreshnessEventSchema>;

/** WebSocket events owned by the search feature (§10.1 and §10.2, §7), keyed by event type. */
export const searchEvents = defineEvents({
  "search.freshness": searchFreshnessEventSchema,
});
