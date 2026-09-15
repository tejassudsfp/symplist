import type { Statement } from "@symplist/db";
import type { CoreDomain } from "../../domains.ts";

export interface ArchiveInput {
  readonly ownerId: string;
  /** The task being completed. */
  readonly rootTaskId: string;
  /** Every task archived by this completion (the root and, for `mode=all`, its active descendants). */
  readonly taskIds: readonly string[];
  readonly mode: "all" | "parent_only";
  /** The write id of the deciding archive statement; contributed statements are guarded by it. */
  readonly writeId: string;
  readonly now: number;
}

/** A domain's statements appended to the task complete batch (§2.1). */
export interface ArchiveContributor {
  readonly domain: CoreDomain;
  statements(input: ArchiveInput): readonly Statement[];
}
