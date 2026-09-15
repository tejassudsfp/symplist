import type { PurgeContributor } from "./types.ts";

/** Simon purge statements (§5.6). Messages, message parts, runs, approvals, user asks and tool invocations. */
export const simonPurgeContributor: PurgeContributor = {
  domain: "simon",
  statements: () => [],
};
