import type { Statement } from "@symplist/db";
import type { CoreDomain } from "../../domains.ts";

export interface ArchiveInput {
  readonly ownerId: string;
  /** The task being completed. */
  readonly rootTaskId: string;
  /** Every task archived by this completion (the root and, for `mode=all`, its active descendants). */
  readonly taskIds: readonly string[];
  readonly mode: "all" | "parent_only";
  /**
   * The write id of the deciding archive statement; contributed statements are guarded by it through
   * `archiveGuard(input)` (the owner's `users.task_tree_write_id`).
   */
  readonly writeId: string;
  readonly now: number;
  /** The caller asked to stop active work on these tasks (`stopRun`, §2.1). */
  readonly stopRun: boolean;
  /**
   * A read returning the `id` of every task this batch archived, for statements over completions too
   * large for an `IN (:ids)` list under D1's 100 parameters: `task_id IN (${archivedTaskIds.sql})`
   * with `archivedTaskIds.params` spread into the statement's parameters.
   */
  readonly archivedTaskIds: ArchiveTaskIdsQuery;
}

/** A SQL read that returns one `id` column per task, with its named parameters. */
export interface ArchiveTaskIdsQuery {
  readonly sql: string;
  readonly params: Readonly<Record<string, string>>;
}

/** The input of a blocking check: the tasks the completion would archive. */
export interface ArchiveBlockInput {
  /**
   * A read returning the `id` of every task the completion would archive (evaluated before it does),
   * for conditions over long task lists; its `block_ids_*` parameters may be repeated by several
   * domains.
   */
  readonly taskIdsQuery: ArchiveTaskIdsQuery;
  readonly ownerId: string;
  readonly rootTaskId: string;
  readonly taskIds: readonly string[];
  readonly now: number;
}

/**
 * A SQL condition over named parameters. Parameter names start with the contributing domain's name
 * and an underscore (for example `simon_task_ids`), so conditions from several domains can share one
 * statement.
 */
export interface ArchiveCondition {
  readonly sql: string;
  readonly params: Readonly<Record<string, string | readonly string[]>>;
}

/**
 * A domain's part of the task complete batch (§2.1). `statements` runs in the batch after the
 * deciding statement and must carry `archiveGuard(input)`; it never writes `tasks` or `users`.
 *
 * `blockingCondition` is the injected run-state check: a condition that holds while the tasks have
 * work that completion must not silently end (Simon: a run in `queued`, `running`,
 * `awaiting_approval` or `awaiting_user`). When the caller did not ask to stop it (`stopRun: false`)
 * the deciding statement requires the condition to be false and the service returns
 * `task.run_active`; with `stopRun: true` the domain's statements stop the work in the same batch.
 */
export interface ArchiveContributor {
  readonly domain: CoreDomain;
  statements(input: ArchiveInput): readonly Statement[];
  blockingCondition?(input: ArchiveBlockInput): ArchiveCondition | null;
}
