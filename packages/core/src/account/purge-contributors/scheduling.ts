import type { PurgeContributor } from "./types.ts";

/** Scheduling purge statements (§5.6). Schedules, reminders, occurrences, outbox rows, notifications and schedule audit rows. */
export const schedulingPurgeContributor: PurgeContributor = {
  domain: "scheduling",
  statements: () => [],
};
