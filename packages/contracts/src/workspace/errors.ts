import { defineErrorCodes } from "../common/errors.ts";

/**
 * Stable error codes owned by the workspace feature (§2.1 and §10.3, §6), mapped to HTTP statuses.
 * `task.archived`, `task.run_active` and `not_found` (unknown and foreign tasks alike) are foundation
 * codes.
 */
export const workspaceErrorCodes = defineErrorCodes({
  /**
   * The owner's task tree kept changing while the write was prepared (another device, Simon or a
   * connected agent). Nothing was applied; `details.taskTreeVersion` is the current tree version.
   */
  "task.conflict": 409,
  /**
   * The target place is impossible: a task under itself or its own subtask, neighbours that are not
   * siblings in the target list, or a parent in another collection. `details.reason` names it.
   */
  "task.placement_invalid": 422,
  /** The move, subtask or restore would nest tasks deeper than `TASK_MAX_DEPTH`. */
  "task.depth_limit": 422,
  /**
   * A preference save was based on an older version (§10.3). `details` carries the group's current
   * version and data (`preferencesConflictDetailsSchema`).
   */
  "preferences.conflict": 409,
});

/** `task.placement_invalid` reasons. */
export const taskPlacementInvalidReasons = [
  "cycle",
  "collection_mismatch",
  "neighbour_not_sibling",
  "neighbours_not_adjacent",
] as const;
export type TaskPlacementInvalidReason = (typeof taskPlacementInvalidReasons)[number];
