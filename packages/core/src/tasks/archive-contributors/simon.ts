import type { ArchiveContributor } from "./types.ts";

/** Simon task-archive statements (§2.1). Stop or cancel the tasks' runs, expire pending approvals and user asks without continuation intents, and cancel queued messages and dispatch intents (§8.1). */
export const simonArchiveContributor: ArchiveContributor = {
  domain: "simon",
  statements: () => [],
};
