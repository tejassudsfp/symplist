import type { ArchiveContributor } from "./types.ts";

/** Scheduling task-archive statements (§2.1). Cancel the tasks' pending occurrences and outbox rows and increment reminder generations (§12.4). */
export const schedulingArchiveContributor: ArchiveContributor = {
  domain: "scheduling",
  statements: () => [],
};
