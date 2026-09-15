import type { RestrictContributor } from "./types.ts";

/** Simon restriction statements (§5.5). Expire pending approvals and user asks, cancel queued messages and pending dispatch intents, and stop or cancel active runs without continuation intents. */
export const simonRestrictContributor: RestrictContributor = {
  domain: "simon",
  statements: () => [],
};
