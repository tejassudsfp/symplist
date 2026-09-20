import { schedulingArchiveContributor } from "./scheduling.ts";
import { searchArchiveContributor } from "./search.ts";
import { simonArchiveContributor } from "./simon.ts";
import type { ArchiveContributor } from "./types.ts";
import { vaultArchiveContributor } from "./vault.ts";

export type {
  ArchiveBlockInput,
  ArchiveCondition,
  ArchiveContributor,
  ArchiveInput,
  ArchiveTaskIdsQuery,
} from "./types.ts";

/** Every domain's task-archive contribution, in batch order (§2.1). */
export const archiveContributors: readonly ArchiveContributor[] = [
  simonArchiveContributor,
  schedulingArchiveContributor,
  vaultArchiveContributor,
  searchArchiveContributor,
];
