import type { EventsContributor } from "./types.ts";

/** Account execution seams (§5.6): the `account_purge` kind (`account-purge`, payload `{ userId }`). */
export const accountEventsContributor: EventsContributor = {
  domain: "account",
  executionKinds: [],
};
