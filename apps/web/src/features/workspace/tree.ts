import type {
  TaskCollection,
  TaskId,
  TaskMoveRequest,
  TaskNode,
  TaskPlacementRecord,
} from "@symplist/contracts";

/**
 * Pure helpers over a collection tree as the api returns it: active tasks in pre-order, each with
 * its depth (§2.1, decision WS4). Every helper returns a new list and keeps `depth`, `parentId`,
 * `collection` and each parent's `childCount` consistent, so optimistic changes read exactly like a
 * fresh fetch until the server's own tree replaces them.
 */
export type TaskList = readonly TaskNode[];

export function indexOfTask(list: TaskList, id: string): number {
  return list.findIndex((task) => task.id === id);
}

export function findTask(list: TaskList, id: string): TaskNode | undefined {
  return list.find((task) => task.id === id);
}

/** The exclusive end of the subtree that starts at `index`. */
export function subtreeEnd(list: TaskList, index: number): number {
  const root = list[index];
  if (!root) return index;
  let end = index + 1;
  while (end < list.length && (list[end] as TaskNode).depth > root.depth) end += 1;
  return end;
}

/** The task and every descendant, in pre-order. */
export function subtreeOf(list: TaskList, id: string): TaskNode[] {
  const index = indexOfTask(list, id);
  if (index === -1) return [];
  return list.slice(index, subtreeEnd(list, index));
}

/** Direct children of a task (or the top-level tasks for `null`), in order. */
export function childrenOf(list: TaskList, parentId: string | null): TaskNode[] {
  return list.filter((task) => task.parentId === parentId);
}

/** The ancestors of a task, root first. */
export function ancestorsOf(list: TaskList, id: string): TaskNode[] {
  const byId = new Map(list.map((task) => [task.id as string, task]));
  const ancestors: TaskNode[] = [];
  let current = byId.get(id);
  while (current?.parentId) {
    const parent = byId.get(current.parentId);
    if (!parent) break;
    ancestors.unshift(parent);
    current = parent;
  }
  return ancestors;
}

/** Whether `candidate` is `id` itself or one of its descendants. */
export function isSelfOrDescendant(list: TaskList, id: string, candidate: string): boolean {
  return subtreeOf(list, id).some((task) => task.id === candidate);
}

function adjustChildCount(list: TaskNode[], parentId: string | null, delta: number): void {
  if (parentId === null) return;
  const index = indexOfTask(list, parentId);
  const parent = list[index];
  if (!parent) return;
  list[index] = { ...parent, childCount: Math.max(0, parent.childCount + delta) };
}

export interface RemovedSubtree {
  readonly list: TaskList;
  /** The removed task first, then its descendants in pre-order. */
  readonly removed: readonly TaskNode[];
}

/** Removes a task with its descendants and decrements its parent's child count. */
export function removeSubtree(list: TaskList, id: string): RemovedSubtree {
  const index = indexOfTask(list, id);
  if (index === -1) return { list, removed: [] };
  const end = subtreeEnd(list, index);
  const removed = list.slice(index, end);
  const next = [...list.slice(0, index), ...list.slice(end)];
  adjustChildCount(next, (removed[0] as TaskNode).parentId, -1);
  return { list: next, removed };
}

export interface InsertPlacement {
  readonly collection: TaskCollection;
  readonly parentId: string | null;
  /** Insert after this sibling (and its subtree). */
  readonly afterId?: string | null;
  /** Insert before this sibling. */
  readonly beforeId?: string | null;
}

/**
 * Inserts a removed subtree under `parentId`, after `afterId`, before `beforeId`, or at the end of
 * the parent's children. Depths are rebased onto the new parent; an unknown parent or neighbour
 * falls back to the end of the top level, as the server does for a list it cannot see.
 */
export function insertSubtree(
  list: TaskList,
  subtree: readonly TaskNode[],
  placement: InsertPlacement,
): TaskList {
  const root = subtree[0];
  if (!root) return list;
  const next = [...list];
  const parentIndex = placement.parentId === null ? -1 : indexOfTask(next, placement.parentId);
  const parent = parentIndex === -1 ? null : (next[parentIndex] as TaskNode);
  const parentId = parent ? (parent.id as string) : null;
  const baseDepth = parent ? parent.depth + 1 : 0;
  const shift = baseDepth - root.depth;
  const rebased = subtree.map((task, position) => ({
    ...task,
    collection: placement.collection,
    depth: task.depth + shift,
    ...(position === 0 ? { parentId: parentId as TaskId | null } : {}),
  }));

  let at: number;
  const afterIndex = placement.afterId ? indexOfTask(next, placement.afterId) : -1;
  const beforeIndex = placement.beforeId ? indexOfTask(next, placement.beforeId) : -1;
  if (afterIndex !== -1 && (next[afterIndex] as TaskNode).parentId === parentId) {
    at = subtreeEnd(next, afterIndex);
  } else if (beforeIndex !== -1 && (next[beforeIndex] as TaskNode).parentId === parentId) {
    at = beforeIndex;
  } else if (parent) {
    at = subtreeEnd(next, parentIndex);
  } else {
    at = next.length;
  }
  next.splice(at, 0, ...rebased);
  adjustChildCount(next, parentId, 1);
  return next;
}

/** Changes a task's title. */
export function renameInList(list: TaskList, id: string, title: string): TaskList {
  const index = indexOfTask(list, id);
  if (index === -1) return list;
  const next = [...list];
  next[index] = { ...(next[index] as TaskNode), title };
  return next;
}

/**
 * Completing only the parent (decision WS6): the task leaves the list and its direct subtasks, with
 * their own subtasks, become top-level tasks in the slot of its top-level ancestor (its own slot
 * when it was already top level), keeping their order.
 */
export function promoteChildren(list: TaskList, id: string): TaskList {
  const index = indexOfTask(list, id);
  const task = list[index];
  if (!task) return list;
  const ancestors = ancestorsOf(list, id);
  const topLevelId = (ancestors[0]?.id ?? task.id) as string;
  const children = childrenOf(list, id).map((child) => subtreeOf(list, child.id));
  const { list: withoutTask } = removeSubtree(list, id);
  let next = withoutTask;
  let anchor: string | null = task.parentId === null ? null : topLevelId;
  const firstTopLevelAfter = (() => {
    if (task.parentId !== null) return null;
    const siblings = childrenOf(list, null);
    const position = siblings.findIndex((sibling) => sibling.id === id);
    return siblings[position + 1]?.id ?? null;
  })();
  for (const subtree of children) {
    const placement: InsertPlacement =
      anchor !== null
        ? { collection: task.collection, parentId: null, afterId: anchor }
        : firstTopLevelAfter !== null
          ? { collection: task.collection, parentId: null, beforeId: firstTopLevelAfter }
          : { collection: task.collection, parentId: null };
    next = insertSubtree(next, subtree, placement);
    anchor = (subtree[0] as TaskNode).id;
  }
  return next;
}

/** Canonical text for accent- and case-insensitive matching (NFKD, marks removed, lower case). */
export function normalizeForSearch(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

export interface VisibleRow {
  readonly task: TaskNode;
  /** Whether the task has subtasks and they are shown. */
  readonly expanded: boolean;
  /** Whether the task's own title matches the query; false for an ancestor kept as context. */
  readonly matched: boolean;
  /** The row's place among the rows shown at its own level (`aria-posinset`, 1-based). */
  readonly posInSet: number;
  /** How many rows are shown at its level (`aria-setsize`). */
  readonly setSize: number;
}

/**
 * `aria-posinset` and `aria-setsize` are scoped to the siblings at a row's level, never to the flat
 * list, so each row is numbered within its own parent's shown children (WAI-ARIA tree pattern).
 */
function withSetPositions(rows: readonly Omit<VisibleRow, "posInSet" | "setSize">[]): VisibleRow[] {
  const sizes = new Map<string, number>();
  for (const row of rows) {
    const key = row.task.parentId ?? "";
    sizes.set(key, (sizes.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = row.task.parentId ?? "";
    const posInSet = (seen.get(key) ?? 0) + 1;
    seen.set(key, posInSet);
    return { ...row, posInSet, setSize: sizes.get(key) ?? 1 };
  });
}

/**
 * The rows the list shows: tasks whose ancestors are all expanded, or, while searching, every task
 * whose title matches together with its ancestors. The ancestors are kept because a tree whose levels
 * skip one (`aria-level` 1 straight to 3) is not navigable, and because a match reads better in its
 * place in the hierarchy; they are marked `matched: false` so the list can show them as context.
 */
export function visibleRows(
  list: TaskList,
  expanded: ReadonlySet<string>,
  query = "",
): VisibleRow[] {
  const needle = normalizeForSearch(query.trim());
  if (needle) {
    const byId = new Map(list.map((task) => [task.id as string, task]));
    const matched = new Set<string>();
    const shown = new Set<string>();
    for (const task of list) {
      if (!normalizeForSearch(task.title).includes(needle)) continue;
      matched.add(task.id);
      shown.add(task.id);
      let parentId: string | null = task.parentId;
      while (parentId !== null && !shown.has(parentId)) {
        shown.add(parentId);
        parentId = byId.get(parentId)?.parentId ?? null;
      }
    }
    if (shown.size === 0) return [];
    const kept = list.filter((task) => shown.has(task.id));
    const withShownChildren = new Set<string>();
    for (const task of kept) {
      if (task.parentId !== null) withShownChildren.add(task.parentId);
    }
    return withSetPositions(
      kept.map((task) => ({
        task,
        expanded: withShownChildren.has(task.id),
        matched: matched.has(task.id),
      })),
    );
  }
  const rows: Omit<VisibleRow, "posInSet" | "setSize">[] = [];
  let hiddenBelowDepth: number | null = null;
  for (const task of list) {
    if (hiddenBelowDepth !== null && task.depth > hiddenBelowDepth) continue;
    hiddenBelowDepth = null;
    const open = task.childCount > 0 && expanded.has(task.id);
    rows.push({ task, expanded: open, matched: true });
    if (task.childCount > 0 && !open) hiddenBelowDepth = task.depth;
  }
  return withSetPositions(rows);
}

export type DropEdge = "before" | "after";

export interface DropPlacement {
  /** The move request that puts the task at the drop position. */
  readonly request: TaskMoveRequest;
  /** The same position for the optimistic list. */
  readonly insert: InsertPlacement;
}

/**
 * Where dropping `sourceId` on the `edge` of `targetId` puts it: beside the target, under the
 * target's parent. Returns null for a drop into the task's own subtree or one that changes nothing.
 * The request names only the neighbour, which decides parent and collection on the server (WS5).
 */
export function dropPlacement(
  list: TaskList,
  sourceId: string,
  targetId: string,
  edge: DropEdge,
): DropPlacement | null {
  if (sourceId === targetId) return null;
  const target = findTask(list, targetId);
  const source = findTask(list, sourceId);
  if (!target || !source) return null;
  if (isSelfOrDescendant(list, sourceId, targetId)) return null;
  const current = childrenOf(list, source.parentId);
  const currentIndex = current.findIndex((task) => task.id === sourceId);
  if (source.parentId === target.parentId) {
    const neighbourBefore = current[currentIndex - 1]?.id;
    const neighbourAfter = current[currentIndex + 1]?.id;
    if (edge === "after" && neighbourBefore === targetId) return null;
    if (edge === "before" && neighbourAfter === targetId) return null;
  }
  const insert: InsertPlacement =
    edge === "after"
      ? { collection: target.collection, parentId: target.parentId, afterId: targetId }
      : { collection: target.collection, parentId: target.parentId, beforeId: targetId };
  const request: TaskMoveRequest =
    edge === "after" ? { afterId: targetId as TaskId } : { beforeId: targetId as TaskId };
  return { request, insert };
}

/**
 * The move that puts a task back where the api said it was (`previous` in a move response), using
 * the current list to name the neighbour when it was first among its siblings.
 */
export function undoMoveRequest(
  list: TaskList,
  taskId: string,
  previous: TaskPlacementRecord,
): { readonly request: TaskMoveRequest; readonly insert: InsertPlacement } {
  const siblings = list.filter(
    (task) =>
      task.parentId === previous.parentId &&
      task.collection === previous.collection &&
      task.id !== taskId,
  );
  const insert: InsertPlacement = {
    collection: previous.collection,
    parentId: previous.parentId,
    afterId: previous.afterId,
    ...(previous.afterId === null && siblings[0] ? { beforeId: siblings[0].id } : {}),
  };
  const neighbour: Pick<TaskMoveRequest, "afterId" | "beforeId"> =
    previous.afterId !== null
      ? { afterId: previous.afterId }
      : siblings[0]
        ? { beforeId: siblings[0].id }
        : {};
  const request: TaskMoveRequest =
    previous.parentId === null
      ? { collection: previous.collection, parentId: null, ...neighbour }
      : { parentId: previous.parentId, ...neighbour };
  return { request, insert };
}

/** The open tasks in display order, for next and previous open task (note 13). */
export function orderedIds(list: TaskList): string[] {
  return list.map((task) => task.id);
}
