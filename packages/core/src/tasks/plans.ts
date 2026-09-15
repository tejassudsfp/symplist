import {
  TASK_MAX_DEPTH,
  type TaskCompleteResponse,
  type TaskCreateResponse,
  type TaskMoveResponse,
  type TaskNode,
  type TaskPlacement,
  type TaskRenameResponse,
  type TaskRestoreFallback,
  type TaskRestoreResponse,
} from "@symplist/contracts";
import type { AccountDataKey, RandomOptions } from "@symplist/crypto";
import type { SqlParams, Statement } from "@symplist/db";
import { int, sql } from "@symplist/db";
import type { ArchiveContributor } from "./archive-contributors/types.ts";
import { archiveBlockingCondition, archiveContributionStatements } from "./archive-runner.ts";
import { TaskOperationError } from "./errors.ts";
import { FractionalIndexError, isValidPositionKey, keysBetween } from "./fractional-index.ts";
import {
  ActiveTree,
  compareSiblings,
  isTaskCollection,
  sourceKind,
  type TaskCollection,
  type TaskRecord,
  type TaskSource,
} from "./model.ts";
import { encryptTaskTitle } from "./sql.ts";
import type { OwnerTreeState } from "./state.ts";

/** Keys longer than this trigger renumbering the whole list instead of growing further. */
export const POSITION_REBALANCE_LENGTH = 64;

/** Ids per `IN (…)` list, keeping every statement under D1's 100 parameters (§3.2). */
const ID_CHUNK = 80;
/** Ids per `CASE id WHEN … THEN …` renumbering statement (three parameters per id). */
const CASE_CHUNK = 28;

/** What every planned statement shares. */
export interface PlanContext {
  readonly ownerId: string;
  readonly now: number;
  /** The batch's write id: set on every changed task row and on the owner's tree version. */
  readonly writeId: string;
  readonly key: AccountDataKey;
  readonly random?: RandomOptions;
  /**
   * `EXISTS (…)` that holds only once the batch's deciding statement moved the tree version with this
   * write id; every effect statement carries it.
   */
  readonly guard: string;
  readonly guardParams: Readonly<Record<string, string>>;
}

/** An analytics event a successful plan reports (the api captures it after commit). */
export type PlannedAnalytics =
  | {
      readonly event: "task_created";
      readonly properties: {
        readonly source: "user" | "simon" | "mcp";
        readonly collection: TaskCollection;
        readonly is_subtask: boolean;
      };
    }
  | {
      readonly event: "task_completed";
      readonly properties: {
        readonly collection: TaskCollection;
        readonly mode: "single" | "all" | "parent_only";
      };
    }
  | {
      readonly event: "task_moved";
      readonly properties: {
        readonly from_collection: TaskCollection;
        readonly to_collection: TaskCollection;
        readonly source: "user" | "simon" | "mcp";
      };
    };

/** A deciding condition beyond the tree version lock, with its diagnostic read. */
export interface PlanCondition {
  /** Added to the deciding statement as `AND NOT (<sql>)`. */
  readonly sql: string;
  readonly params: SqlParams;
  /** The error returned when the condition is what refused the write. */
  readonly error: TaskOperationError;
}

export interface WritePlan<Body> {
  /**
   * `tree`: the deciding statement moves the tree version only while it is still `state.version`.
   * `row`: the deciding statement is `deciding`, guarded by the row's version, and the tree version
   * moves after it. `none`: nothing to change (the idempotency record is still written).
   */
  readonly lock: "tree" | "row" | "none";
  /**
   * For `row` locks: the columns the deciding `UPDATE tasks` sets on one active task at
   * `expectedVersion` (the service adds the version, `updated_at`, `write_id`, access and idempotency
   * conditions).
   */
  readonly row?: {
    readonly taskId: string;
    readonly expectedVersion: number;
    readonly set: string;
    readonly params: SqlParams;
  };
  /** Extra conditions the tree lock requires to be false (blocking work). */
  readonly blocking?: PlanCondition;
  /** Extra conditions the tree lock requires to hold, such as a free task id. */
  readonly requires?: { readonly sql: string; readonly params: SqlParams };
  readonly effects: readonly Statement[];
  readonly status: number;
  readonly body: Body;
  readonly changedTaskIds: readonly string[];
  readonly analytics: PlannedAnalytics | null;
  /** The owner's state after the batch, when it applied at `state.version + 1`. */
  apply(state: OwnerTreeState, version: number): OwnerTreeState;
}

/* ------------------------------------------------------------------------------------------------
 * Shared helpers
 * --------------------------------------------------------------------------------------------- */

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

/** `not_found` or `task.archived` for a task id that is not active in the state. */
export function missingTaskError(state: OwnerTreeState, taskId: string): TaskOperationError {
  return new TaskOperationError(state.archived.has(taskId) ? "task.archived" : "not_found");
}

function activeTask(state: OwnerTreeState, taskId: string): TaskRecord {
  const task = state.tree.get(taskId);
  if (!task) throw missingTaskError(state, taskId);
  return task;
}

export function toTaskNode(tree: ActiveTree, task: TaskRecord, depth: number): TaskNode {
  return {
    id: task.id,
    parentId: tree.effectiveParent(task),
    collection: task.collection,
    position: task.position,
    depth: Math.min(depth, TASK_MAX_DEPTH - 1),
    title: task.title,
    preview: task.preview,
    source: sourceKind(task.source),
    version: task.version,
    childCount: tree.childrenOf(task.id).length,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  } as TaskNode;
}

interface Placement {
  readonly position: string;
  /** New positions of existing siblings when the list had to be renumbered. */
  readonly renumbered: ReadonlyMap<string, string>;
}

/**
 * The keys for `count` new entries inserted at `index` of an ordered sibling list. Normally the new
 * keys sit between the neighbours and nothing else changes; when neighbours share a key (a race
 * elsewhere) or the new keys grow past {@link POSITION_REBALANCE_LENGTH}, the whole list is
 * renumbered with short, evenly spaced keys.
 */
export function placeInList(
  siblings: readonly TaskRecord[],
  index: number,
  count = 1,
): { readonly positions: readonly string[]; readonly renumbered: ReadonlyMap<string, string> } {
  const before = siblings[index - 1]?.position ?? null;
  const after = siblings[index]?.position ?? null;
  try {
    const valid =
      (before === null || isValidPositionKey(before)) &&
      (after === null || isValidPositionKey(after));
    if (valid) {
      const positions = keysBetween(before, after, count);
      if (positions.every((position) => position.length <= POSITION_REBALANCE_LENGTH)) {
        return { positions, renumbered: new Map() };
      }
    }
  } catch (error) {
    if (!(error instanceof FractionalIndexError)) throw error;
  }
  const keys = keysBetween(null, null, siblings.length + count);
  const renumbered = new Map<string, string>();
  const positions: string[] = [];
  let cursor = 0;
  for (let slot = 0; slot < siblings.length + count; slot += 1) {
    const key = keys[slot] as string;
    if (slot >= index && slot < index + count) {
      positions.push(key);
    } else {
      const sibling = siblings[cursor] as TaskRecord;
      cursor += 1;
      if (sibling.position !== key) renumbered.set(sibling.id, key);
    }
  }
  return { positions, renumbered };
}

function placeOne(siblings: readonly TaskRecord[], index: number): Placement {
  const { positions, renumbered } = placeInList(siblings, index, 1);
  return { position: positions[0] as string, renumbered };
}

/** `UPDATE … SET position = CASE id …` statements for renumbered or placed tasks. */
function positionStatements(
  ctx: PlanContext,
  positions: ReadonlyMap<string, string>,
  extra: { readonly clearParent?: boolean } = {},
): Statement[] {
  return chunks([...positions.entries()], CASE_CHUNK).map((chunk) => {
    const params: Record<string, string | readonly string[]> = {
      ...ctx.guardParams,
      owner: ctx.ownerId,
      now: int(ctx.now),
      w: ctx.writeId,
      ids: chunk.map(([id]) => id),
    };
    const cases = chunk
      .map(([id, position], index) => {
        params[`case_id_${index}`] = id;
        params[`case_position_${index}`] = position;
        return `WHEN :case_id_${index} THEN :case_position_${index}`;
      })
      .join(" ");
    return sql(
      `UPDATE tasks SET position = CASE id ${cases} END,${extra.clearParent ? " parent_id = NULL," : ""}
         version = version + 1, updated_at = :now, write_id = :w
       WHERE owner_id = :owner AND status = 'active' AND id IN (:ids) AND ${ctx.guard}`,
      params,
    );
  });
}

/** Search intents (§10.1) for changed task rows, at their new versions. */
function searchIntentStatements(ctx: PlanContext, taskIds: readonly string[]): Statement[] {
  return chunks([...new Set(taskIds)], ID_CHUNK).map((chunk) =>
    sql(
      `INSERT INTO search_intents (owner_id, entity, entity_id, revision_or_seq, op, created_at)
       SELECT owner_id, 'task', id, version, 'upsert', :now FROM tasks
       WHERE owner_id = :owner AND write_id = :w AND id IN (:ids)`,
      { owner: ctx.ownerId, now: int(ctx.now), w: ctx.writeId, ids: chunk },
    ),
  );
}

function bump(task: TaskRecord, now: number, changes: Partial<TaskRecord>): TaskRecord {
  return Object.freeze({ ...task, ...changes, version: task.version + 1, updatedAt: now });
}

/** The state after replacing and removing active records and archived records. */
function nextState(
  state: OwnerTreeState,
  version: number,
  changes: {
    readonly active?: readonly TaskRecord[];
    readonly removeActive?: readonly string[];
    readonly archived?: readonly TaskRecord[];
    readonly removeArchived?: readonly string[];
  },
): OwnerTreeState {
  const active = new Map(state.tree.byId);
  for (const id of changes.removeActive ?? []) active.delete(id);
  for (const record of changes.active ?? []) active.set(record.id, record);
  const archived = new Map(state.archived);
  for (const id of changes.removeArchived ?? []) archived.delete(id);
  for (const record of changes.archived ?? []) archived.set(record.id, record);
  return Object.freeze({
    ownerId: state.ownerId,
    version,
    keyRow: state.keyRow,
    tree: new ActiveTree(active.values()),
    archived,
  });
}

function renumberedRecords(
  state: OwnerTreeState,
  renumbered: ReadonlyMap<string, string>,
  now: number,
): TaskRecord[] {
  return [...renumbered.entries()].map(([id, position]) =>
    bump(state.tree.get(id) as TaskRecord, now, { position }),
  );
}

function checkDepth(depth: number): void {
  if (depth > TASK_MAX_DEPTH - 1) throw new TaskOperationError("task.depth_limit");
}

/* ------------------------------------------------------------------------------------------------
 * Create
 * --------------------------------------------------------------------------------------------- */

export interface CreatePlanInput {
  readonly taskId: string;
  readonly title: string;
  readonly source: TaskSource;
  readonly collection?: TaskCollection;
  readonly parentId?: string;
  readonly afterId?: string;
  readonly placement?: TaskPlacement;
}

export function planCreate(
  state: OwnerTreeState,
  ctx: PlanContext,
  input: CreatePlanInput,
): WritePlan<TaskCreateResponse> {
  const { tree } = state;
  let collection: TaskCollection;
  let parentId: string | null = null;
  let depth = 0;
  if (input.parentId !== undefined) {
    const parent = activeTask(state, input.parentId);
    if (input.collection !== undefined && input.collection !== parent.collection) {
      throw new TaskOperationError("task.placement_invalid", { reason: "collection_mismatch" });
    }
    collection = parent.collection;
    parentId = parent.id;
    depth = tree.depthOf(parent.id) + 1;
    checkDepth(depth);
  } else if (input.collection !== undefined) {
    collection = input.collection;
  } else {
    throw new TaskOperationError("task.placement_invalid", { reason: "collection_mismatch" });
  }
  const siblings = tree.siblingsIn(parentId, collection);
  let index = siblings.length;
  if (input.afterId !== undefined) {
    const found = siblings.findIndex((sibling) => sibling.id === input.afterId);
    if (found === -1) {
      throw new TaskOperationError("task.placement_invalid", { reason: "neighbour_not_sibling" });
    }
    index = found + 1;
  } else if (input.placement === "start") {
    index = 0;
  }
  const { position, renumbered } = placeOne(siblings, index);
  const record: TaskRecord = Object.freeze({
    id: input.taskId,
    ownerId: ctx.ownerId,
    parentId,
    collection,
    position,
    status: "active",
    archivedAt: null,
    archivedWithRootId: null,
    source: input.source,
    version: 1,
    title: input.title,
    preview: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  const effects: Statement[] = [
    sql(
      `INSERT INTO tasks (id, owner_id, parent_id, collection, position, status, archived_at,
         archived_with_root_id, source, version, write_id, title_enc, preview_enc, created_at, updated_at)
       SELECT :id, :owner, :parent, :collection, :position, 'active', NULL, NULL, :source, 1, :w,
         :title, NULL, :now, :now
       WHERE ${ctx.guard}`,
      {
        ...ctx.guardParams,
        id: record.id,
        owner: ctx.ownerId,
        parent: parentId,
        collection,
        position,
        source: input.source,
        w: ctx.writeId,
        title: encryptTaskTitle(ctx.key, ctx.ownerId, record.id, input.title, ctx.random),
        now: int(ctx.now),
      },
    ),
    ...positionStatements(ctx, renumbered),
    ...searchIntentStatements(ctx, [record.id]),
  ];
  return {
    lock: "tree",
    requires: {
      sql: "NOT EXISTS (SELECT 1 FROM tasks WHERE id = :new_task_id)",
      params: { new_task_id: record.id },
    },
    effects,
    status: 201,
    body: {
      task: {
        ...toTaskNode(tree, record, depth),
        parentId,
        childCount: 0,
      } as TaskNode,
    },
    changedTaskIds: [record.id, ...renumbered.keys()],
    analytics: {
      event: "task_created",
      properties: {
        source: sourceKind(input.source),
        collection,
        is_subtask: parentId !== null,
      },
    },
    apply: (current, version) =>
      nextState(current, version, {
        active: [record, ...renumberedRecords(current, renumbered, ctx.now)],
      }),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Rename
 * --------------------------------------------------------------------------------------------- */

export function planRename(
  state: OwnerTreeState,
  ctx: PlanContext,
  input: { readonly taskId: string; readonly title: string },
): WritePlan<TaskRenameResponse> {
  const task = activeTask(state, input.taskId);
  const renamed = bump(task, ctx.now, { title: input.title });
  return {
    lock: "row",
    row: {
      taskId: task.id,
      expectedVersion: task.version,
      set: "title_enc = :rename_title",
      params: {
        rename_title: encryptTaskTitle(ctx.key, ctx.ownerId, task.id, input.title, ctx.random),
      },
    },
    effects: searchIntentStatements(ctx, [task.id]),
    status: 200,
    body: { taskId: task.id, title: input.title, version: renamed.version } as TaskRenameResponse,
    changedTaskIds: [task.id],
    analytics: null,
    apply: (current, version) => nextState(current, version, { active: [renamed] }),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Move and reorder
 * --------------------------------------------------------------------------------------------- */

export interface MovePlanInput {
  readonly taskId: string;
  readonly collection?: TaskCollection;
  readonly parentId?: string | null;
  readonly afterId?: string;
  readonly beforeId?: string;
  readonly actor: "user" | "simon" | "mcp";
}

export function planMove(
  state: OwnerTreeState,
  ctx: PlanContext,
  input: MovePlanInput,
): WritePlan<TaskMoveResponse> {
  const { tree } = state;
  const task = activeTask(state, input.taskId);
  const neighbourIds = [input.afterId, input.beforeId].filter(
    (id): id is string => id !== undefined,
  );
  for (const id of neighbourIds) {
    if (id === task.id || !tree.get(id)) {
      throw new TaskOperationError("task.placement_invalid", { reason: "neighbour_not_sibling" });
    }
  }
  const neighbour =
    neighbourIds.length > 0 ? (tree.get(neighbourIds[0] as string) as TaskRecord) : null;

  let targetParentId: string | null;
  if (input.parentId !== undefined) {
    targetParentId = input.parentId;
  } else if (neighbour !== null) {
    targetParentId = tree.effectiveParent(neighbour);
  } else if (input.collection !== undefined && input.collection !== task.collection) {
    // Decision P3: a subtask moved to another collection becomes top level there.
    targetParentId = null;
  } else {
    targetParentId = tree.effectiveParent(task);
  }

  let parentDepth = -1;
  let targetCollection: TaskCollection;
  if (targetParentId !== null) {
    const parent = activeTask(state, targetParentId);
    if (tree.isSelfOrDescendant(task.id, parent.id)) {
      throw new TaskOperationError("task.placement_invalid", { reason: "cycle" });
    }
    targetCollection = parent.collection;
    parentDepth = tree.depthOf(parent.id);
  } else {
    targetCollection = neighbour?.collection ?? input.collection ?? task.collection;
  }
  if (input.collection !== undefined && input.collection !== targetCollection) {
    throw new TaskOperationError("task.placement_invalid", { reason: "collection_mismatch" });
  }
  checkDepth(parentDepth + 1 + tree.heightOf(task.id));

  const siblings = tree
    .siblingsIn(targetParentId, targetCollection)
    .filter((sibling) => sibling.id !== task.id);
  const afterIndex =
    input.afterId === undefined
      ? -1
      : siblings.findIndex((sibling) => sibling.id === input.afterId);
  const beforeIndex =
    input.beforeId === undefined
      ? -1
      : siblings.findIndex((sibling) => sibling.id === input.beforeId);
  if (
    (input.afterId !== undefined && afterIndex === -1) ||
    (input.beforeId !== undefined && beforeIndex === -1)
  ) {
    throw new TaskOperationError("task.placement_invalid", { reason: "neighbour_not_sibling" });
  }
  if (
    input.afterId !== undefined &&
    input.beforeId !== undefined &&
    beforeIndex !== afterIndex + 1
  ) {
    throw new TaskOperationError("task.placement_invalid", { reason: "neighbours_not_adjacent" });
  }
  const index =
    input.afterId !== undefined
      ? afterIndex + 1
      : input.beforeId !== undefined
        ? beforeIndex
        : siblings.length;
  const { position, renumbered } = placeOne(siblings, index);

  const currentList = tree.siblingsOf(task);
  const currentIndex = currentList.findIndex((sibling) => sibling.id === task.id);
  const previous = {
    collection: task.collection,
    parentId: tree.effectiveParent(task),
    afterId: currentIndex > 0 ? (currentList[currentIndex - 1] as TaskRecord).id : null,
  };

  const descendants = tree.descendantsOf(task.id);
  const collectionChanged = targetCollection !== task.collection;
  const params = {
    ...ctx.guardParams,
    parent: targetParentId,
    collection: targetCollection,
    position,
    now: int(ctx.now),
    w: ctx.writeId,
    task: task.id,
    owner: ctx.ownerId,
  };
  const effects: Statement[] = [
    sql(
      `UPDATE tasks SET parent_id = :parent, collection = :collection, position = :position,
         version = version + 1, updated_at = :now, write_id = :w
       WHERE id = :task AND owner_id = :owner AND status = 'active' AND ${ctx.guard}`,
      params,
    ),
  ];
  if (collectionChanged) {
    for (const chunk of chunks(descendants, ID_CHUNK)) {
      effects.push(
        sql(
          `UPDATE tasks SET collection = :collection, version = version + 1, updated_at = :now, write_id = :w
           WHERE owner_id = :owner AND status = 'active' AND id IN (:ids) AND ${ctx.guard}`,
          {
            ...ctx.guardParams,
            collection: targetCollection,
            now: int(ctx.now),
            w: ctx.writeId,
            owner: ctx.ownerId,
            ids: chunk.map((descendant) => descendant.id),
          },
        ),
      );
    }
  }
  effects.push(...positionStatements(ctx, renumbered));
  const rowsChanged = [task.id, ...(collectionChanged ? descendants.map((row) => row.id) : [])];
  effects.push(...searchIntentStatements(ctx, rowsChanged));

  const moved = bump(task, ctx.now, {
    parentId: targetParentId,
    collection: targetCollection,
    position,
  });
  return {
    lock: "tree",
    effects,
    status: 200,
    body: {
      taskId: task.id,
      collection: targetCollection,
      parentId: targetParentId,
      position,
      movedTaskIds: [task.id, ...descendants.map((descendant) => descendant.id)],
      previous,
    } as TaskMoveResponse,
    changedTaskIds: [...rowsChanged, ...renumbered.keys()],
    analytics: collectionChanged
      ? {
          event: "task_moved",
          properties: {
            from_collection: task.collection,
            to_collection: targetCollection,
            source: input.actor,
          },
        }
      : null,
    apply: (current, version) =>
      nextState(current, version, {
        active: [
          moved,
          ...(collectionChanged
            ? descendants.map((descendant) =>
                bump(descendant, ctx.now, { collection: targetCollection }),
              )
            : []),
          ...renumberedRecords(current, renumbered, ctx.now),
        ],
      }),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Complete
 * --------------------------------------------------------------------------------------------- */

export interface CompletePlanInput {
  readonly taskId: string;
  readonly mode: "all" | "parent_only";
  readonly stopRun: boolean;
  readonly contributors: readonly ArchiveContributor[];
}

export function planComplete(
  state: OwnerTreeState,
  ctx: PlanContext,
  input: CompletePlanInput,
): WritePlan<TaskCompleteResponse> {
  const { tree } = state;
  const task = activeTask(state, input.taskId);
  const descendants = tree.descendantsOf(task.id);
  const effectiveMode = descendants.length === 0 ? "single" : input.mode;
  const archivedRecords = effectiveMode === "all" ? [task, ...descendants] : [task];
  const archivedIds = archivedRecords.map((record) => record.id);
  const promoted = effectiveMode === "parent_only" ? [...tree.childrenOf(task.id)] : [];

  // Promoted subtasks take the completed task's place at the top level of its collection, in their
  // order: after its top-level ancestor, or where it was when it was top level itself.
  const top = tree.rootOf(task.id) ?? task;
  const roots = tree.rootsOf(task.collection).filter((root) => root.id !== task.id);
  const topIndex = tree.rootsOf(task.collection).findIndex((root) => root.id === top.id);
  const insertAt =
    top.id === task.id ? Math.max(0, topIndex) : roots.findIndex((root) => root.id === top.id) + 1;
  const placement =
    promoted.length > 0
      ? placeInList(roots, insertAt, promoted.length)
      : { positions: [], renumbered: new Map<string, string>() };
  const promotedPositions = new Map<string, string>();
  promoted.forEach((child, index) => {
    promotedPositions.set(child.id, placement.positions[index] as string);
  });

  const effects: Statement[] = [];
  for (const chunk of chunks(archivedIds, ID_CHUNK)) {
    effects.push(
      sql(
        `UPDATE tasks SET status = 'archived', archived_at = :now, archived_with_root_id = :root,
           version = version + 1, updated_at = :now, write_id = :w
         WHERE owner_id = :owner AND status = 'active' AND id IN (:ids) AND ${ctx.guard}`,
        {
          ...ctx.guardParams,
          now: int(ctx.now),
          root: task.id,
          w: ctx.writeId,
          owner: ctx.ownerId,
          ids: chunk,
        },
      ),
    );
  }
  effects.push(...positionStatements(ctx, promotedPositions, { clearParent: true }));
  effects.push(...positionStatements(ctx, placement.renumbered));
  // §10.1 lists archive among the changes that insert a search intent in the same batch: the index
  // keeps archived items, flagged, so the opt-in archive scope can find them.
  effects.push(
    ...searchIntentStatements(ctx, [...archivedIds, ...promoted.map((child) => child.id)]),
  );
  effects.push(
    ...archiveContributionStatements(input.contributors, {
      ownerId: ctx.ownerId,
      rootTaskId: task.id,
      taskIds: archivedIds,
      mode: input.mode,
      writeId: ctx.writeId,
      now: ctx.now,
      stopRun: input.stopRun,
      archivedTaskIds: {
        sql: "SELECT id FROM tasks WHERE owner_id = :archive_ids_owner AND archived_with_root_id = :archive_ids_root AND write_id = :archive_ids_write",
        params: {
          archive_ids_owner: ctx.ownerId,
          archive_ids_root: task.id,
          archive_ids_write: ctx.writeId,
        },
      },
    }),
  );
  const blockIdsParams = { block_ids_owner: ctx.ownerId, block_ids_root: task.id };
  const blocking = input.stopRun
    ? null
    : archiveBlockingCondition(input.contributors, {
        ownerId: ctx.ownerId,
        rootTaskId: task.id,
        taskIds: archivedIds,
        now: ctx.now,
        taskIdsQuery:
          effectiveMode === "all"
            ? {
                sql: `WITH RECURSIVE block_subtree (id) AS (
                  SELECT id FROM tasks
                  WHERE id = :block_ids_root AND owner_id = :block_ids_owner AND status = 'active'
                  UNION
                  SELECT t.id FROM tasks t JOIN block_subtree s ON t.parent_id = s.id
                  WHERE t.owner_id = :block_ids_owner AND t.status = 'active'
                ) SELECT id FROM block_subtree`,
                params: blockIdsParams,
              }
            : {
                sql: "SELECT id FROM tasks WHERE id = :block_ids_root AND owner_id = :block_ids_owner AND status = 'active'",
                params: blockIdsParams,
              },
      });

  const archivedAfter = archivedRecords.map((record) =>
    bump(record, ctx.now, { status: "archived", archivedAt: ctx.now, archivedWithRootId: task.id }),
  );
  const promotedAfter = promoted.map((child) =>
    bump(child, ctx.now, { parentId: null, position: promotedPositions.get(child.id) as string }),
  );
  return {
    lock: "tree",
    ...(blocking
      ? {
          blocking: {
            sql: blocking.sql,
            params: blocking.params as SqlParams,
            error: new TaskOperationError("task.run_active"),
          },
        }
      : {}),
    effects,
    status: 200,
    body: {
      taskId: task.id,
      mode: effectiveMode,
      archivedTaskIds: archivedIds,
      promotedTaskIds: promoted.map((child) => child.id),
      archivedAt: ctx.now,
    } as TaskCompleteResponse,
    changedTaskIds: [
      ...archivedIds,
      ...promoted.map((child) => child.id),
      ...placement.renumbered.keys(),
    ],
    analytics: {
      event: "task_completed",
      properties: { collection: task.collection, mode: effectiveMode },
    },
    apply: (current, version) =>
      nextState(current, version, {
        removeActive: archivedIds,
        archived: archivedAfter,
        active: [...promotedAfter, ...renumberedRecords(current, placement.renumbered, ctx.now)],
      }),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Restore
 * --------------------------------------------------------------------------------------------- */

/** The collection a restored task returns to: its own, or Now when that collection is gone (P2). */
export function restorableCollection(value: string): {
  readonly collection: TaskCollection;
  readonly unavailable: boolean;
} {
  return isTaskCollection(value)
    ? { collection: value, unavailable: false }
    : { collection: "now", unavailable: true };
}

export function planRestore(
  state: OwnerTreeState,
  ctx: PlanContext,
  input: { readonly taskId: string },
): WritePlan<TaskRestoreResponse> {
  const { tree } = state;
  const activeRecord = tree.get(input.taskId);
  if (activeRecord) {
    return {
      lock: "none",
      effects: [],
      status: 200,
      body: {
        taskId: activeRecord.id,
        restoredTaskIds: [] as string[],
        collection: activeRecord.collection,
        parentId: tree.effectiveParent(activeRecord),
        position: activeRecord.position,
        fallback: "none",
      } as unknown as TaskRestoreResponse,
      changedTaskIds: [],
      analytics: null,
      apply: (current) => current,
    };
  }
  const task = state.archived.get(input.taskId);
  if (!task) throw new TaskOperationError("not_found");

  // The task and its subtasks archived with it, walked through parent links within the group.
  const group = [...state.archived.values()].filter(
    (record) =>
      record.archivedWithRootId !== null && record.archivedWithRootId === task.archivedWithRootId,
  );
  const childrenByParent = new Map<string, TaskRecord[]>();
  for (const record of group) {
    if (record.parentId === null || record.id === task.id) continue;
    const list = childrenByParent.get(record.parentId) ?? [];
    list.push(record);
    childrenByParent.set(record.parentId, list);
  }
  for (const list of childrenByParent.values()) list.sort(compareSiblings);
  const subtree: TaskRecord[] = [];
  let height = 0;
  const stack: Array<{ readonly record: TaskRecord; readonly level: number }> = [
    { record: task, level: 0 },
  ];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const entry = stack.pop() as { readonly record: TaskRecord; readonly level: number };
    if (seen.has(entry.record.id)) continue;
    seen.add(entry.record.id);
    subtree.push(entry.record);
    height = Math.max(height, entry.level);
    const children = childrenByParent.get(entry.record.id) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ record: children[index] as TaskRecord, level: entry.level + 1 });
    }
  }
  const descendants = subtree.slice(1);

  let fallback: TaskRestoreFallback = "none";
  let parentId: string | null = null;
  let collection: TaskCollection;
  const parent = task.parentId === null ? undefined : tree.get(task.parentId);
  if (parent && tree.depthOf(parent.id) + 1 + height <= TASK_MAX_DEPTH - 1) {
    parentId = parent.id;
    collection = parent.collection;
  } else {
    if (task.parentId !== null) fallback = "parent_unavailable";
    const restorable = restorableCollection(task.collection);
    collection = restorable.collection;
    if (restorable.unavailable) fallback = "collection_unavailable";
  }
  checkDepth(height);

  const siblings = tree.siblingsIn(parentId, collection);
  let position = task.position;
  let renumbered: ReadonlyMap<string, string> = new Map();
  if (!isValidPositionKey(position) || siblings.some((sibling) => sibling.position === position)) {
    const index = siblings.filter((sibling) => sibling.position <= task.position).length;
    const placed = placeOne(siblings, index);
    position = placed.position;
    renumbered = placed.renumbered;
  }

  const effects: Statement[] = [
    sql(
      `UPDATE tasks SET status = 'active', archived_at = NULL, archived_with_root_id = NULL,
         parent_id = :parent, collection = :collection, position = :position,
         version = version + 1, updated_at = :now, write_id = :w
       WHERE id = :task AND owner_id = :owner AND status = 'archived' AND ${ctx.guard}`,
      {
        ...ctx.guardParams,
        parent: parentId,
        collection,
        position,
        now: int(ctx.now),
        w: ctx.writeId,
        task: task.id,
        owner: ctx.ownerId,
      },
    ),
  ];
  for (const chunk of chunks(descendants, ID_CHUNK)) {
    effects.push(
      sql(
        `UPDATE tasks SET status = 'active', archived_at = NULL, archived_with_root_id = NULL,
           collection = :collection, version = version + 1, updated_at = :now, write_id = :w
         WHERE owner_id = :owner AND status = 'archived' AND id IN (:ids) AND ${ctx.guard}`,
        {
          ...ctx.guardParams,
          collection,
          now: int(ctx.now),
          w: ctx.writeId,
          owner: ctx.ownerId,
          ids: chunk.map((record) => record.id),
        },
      ),
    );
  }
  effects.push(...positionStatements(ctx, renumbered));
  const restoredIds = subtree.map((record) => record.id);
  effects.push(...searchIntentStatements(ctx, restoredIds));

  const restoredRecords = [
    bump(task, ctx.now, {
      status: "active",
      archivedAt: null,
      archivedWithRootId: null,
      parentId,
      collection,
      position,
    }),
    ...descendants.map((record) =>
      bump(record, ctx.now, {
        status: "active",
        archivedAt: null,
        archivedWithRootId: null,
        collection,
      }),
    ),
  ];
  return {
    lock: "tree",
    effects,
    status: 200,
    body: {
      taskId: task.id,
      restoredTaskIds: restoredIds,
      collection,
      parentId,
      position,
      fallback,
    } as TaskRestoreResponse,
    changedTaskIds: [...restoredIds, ...renumbered.keys()],
    analytics: null,
    apply: (current, version) =>
      nextState(current, version, {
        removeArchived: restoredIds,
        active: [...restoredRecords, ...renumberedRecords(current, renumbered, ctx.now)],
      }),
  };
}
