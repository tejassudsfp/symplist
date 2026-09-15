import type { EventsContributor } from "./types.ts";

/** Simon's execution seams (§8.1, §8.2): the `simon_run` kind (`simon-run`, payload `{ runId }`, a `runs` tracker) and the `runs` relay source. */
export const simonEventsContributor: EventsContributor = {
  domain: "simon",
  executionKinds: [],
};
