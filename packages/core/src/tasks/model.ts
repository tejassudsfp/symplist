import {
  TASK_MAX_DEPTH,
  type TaskCollection,
  type TaskSourceKind,
  type TaskStatus,
  taskCollections,
} from "@symplist/contracts";

export type { TaskCollection, TaskStatus } from "@symplist/contracts";

/** The stored `tasks.source` (§2.1): the user, Simon, or a connected agent's grant. */
export type TaskSource = "user" | "simon" | `mcp:${string}`;

/** One decrypted `tasks` row. */
export interface TaskRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly parentId: string | null;
  readonly collection: TaskCollection;
  readonly position: string;
  readonly status: TaskStatus;
  readonly archivedAt: number | null;
  readonly archivedWithRootId: string | null;
  readonly source: TaskSource;
  readonly version: number;
  readonly title: string;
  readonly preview: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function isTaskCollection(value: unknown): value is TaskCollection {
  return typeof value === "string" && (taskCollections as readonly string[]).includes(value);
}

/** The source as the UI shows it; the MCP grant id never leaves the server. */
export function sourceKind(source: TaskSource): TaskSourceKind {
  return source === "user" || source === "simon" ? source : "mcp";
}

/** Orders siblings by position, then id, so equal keys still sort the same everywhere. */
export function compareSiblings(a: TaskRecord, b: TaskRecord): number {
  if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * An index over one owner's active tasks: children by parent, top-level tasks by collection, depths
 * and subtree heights. Built once per state and read by the planners.
 */
export class ActiveTree {
  readonly byId: ReadonlyMap<string, TaskRecord>;
  private readonly children = new Map<string, TaskRecord[]>();
  private readonly roots = new Map<TaskCollection, TaskRecord[]>();

  constructor(tasks: Iterable<TaskRecord>) {
    const byId = new Map<string, TaskRecord>();
    for (const task of tasks) if (task.status === "active") byId.set(task.id, task);
    this.byId = byId;
    for (const collection of taskCollections) this.roots.set(collection, []);
    for (const task of byId.values()) {
      if (task.parentId !== null && byId.has(task.parentId)) {
        const list = this.children.get(task.parentId) ?? [];
        list.push(task);
        this.children.set(task.parentId, list);
      } else {
        // A task whose parent is not active is shown at the top level of its collection. The service
        // never leaves such rows behind, but a list never hides a task because of one.
        this.roots.get(task.collection)?.push(task);
      }
    }
    for (const list of this.children.values()) list.sort(compareSiblings);
    for (const list of this.roots.values()) list.sort(compareSiblings);
  }

  get(id: string): TaskRecord | undefined {
    return this.byId.get(id);
  }

  /** Active direct subtasks in order. */
  childrenOf(id: string): readonly TaskRecord[] {
    return this.children.get(id) ?? [];
  }

  /** Top-level active tasks of a collection in order. */
  rootsOf(collection: TaskCollection): readonly TaskRecord[] {
    return this.roots.get(collection) ?? [];
  }

  /** The ordered list a task with this parent (or top level in this collection) belongs to. */
  siblingsIn(parentId: string | null, collection: TaskCollection): readonly TaskRecord[] {
    return parentId === null ? this.rootsOf(collection) : this.childrenOf(parentId);
  }

  /** The list the task currently sits in. */
  siblingsOf(task: TaskRecord): readonly TaskRecord[] {
    return this.siblingsIn(this.effectiveParent(task), task.collection);
  }

  /** The parent the tree uses: null when the stored parent is not active. */
  effectiveParent(task: TaskRecord): string | null {
    return task.parentId !== null && this.byId.has(task.parentId) ? task.parentId : null;
  }

  /** Depth of an active task: 0 at the top level. */
  depthOf(id: string): number {
    let depth = 0;
    let current = this.byId.get(id);
    const seen = new Set<string>();
    while (current && current.parentId !== null && this.byId.has(current.parentId)) {
      if (seen.has(current.id)) break;
      seen.add(current.id);
      depth += 1;
      current = this.byId.get(current.parentId);
    }
    return depth;
  }

  /** The top-level ancestor of a task (itself when it is top level). */
  rootOf(id: string): TaskRecord | undefined {
    let current = this.byId.get(id);
    const seen = new Set<string>();
    while (current && current.parentId !== null && this.byId.has(current.parentId)) {
      if (seen.has(current.id)) break;
      seen.add(current.id);
      current = this.byId.get(current.parentId);
    }
    return current;
  }

  /** Active descendants of a task in pre-order, not including the task. */
  descendantsOf(id: string): TaskRecord[] {
    const result: TaskRecord[] = [];
    const stack = [...this.childrenOf(id)].reverse();
    const seen = new Set<string>([id]);
    while (stack.length > 0) {
      const task = stack.pop() as TaskRecord;
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      result.push(task);
      const children = this.childrenOf(task.id);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index] as TaskRecord);
      }
    }
    return result;
  }

  /** Levels below a task: 0 for a task without subtasks. */
  heightOf(id: string): number {
    let height = 0;
    const stack: Array<{ readonly id: string; readonly level: number }> = [{ id, level: 0 }];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const entry = stack.pop() as { readonly id: string; readonly level: number };
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      if (entry.level > height) height = entry.level;
      for (const child of this.childrenOf(entry.id)) {
        stack.push({ id: child.id, level: entry.level + 1 });
      }
    }
    return height;
  }

  /** Whether `candidate` is `id` or one of its descendants. */
  isSelfOrDescendant(id: string, candidate: string): boolean {
    let current = this.byId.get(candidate);
    const seen = new Set<string>();
    while (current) {
      if (current.id === id) return true;
      if (current.parentId === null || seen.has(current.id)) return false;
      seen.add(current.id);
      current = this.byId.get(current.parentId);
    }
    return false;
  }

  /** A collection's tasks in pre-order with their depths. */
  flatten(
    collection: TaskCollection,
  ): Array<{ readonly task: TaskRecord; readonly depth: number }> {
    const result: Array<{ readonly task: TaskRecord; readonly depth: number }> = [];
    const roots = this.rootsOf(collection);
    const stack: Array<{ readonly task: TaskRecord; readonly depth: number }> = [];
    for (let index = roots.length - 1; index >= 0; index -= 1) {
      stack.push({ task: roots[index] as TaskRecord, depth: 0 });
    }
    const seen = new Set<string>();
    while (stack.length > 0) {
      const entry = stack.pop() as { readonly task: TaskRecord; readonly depth: number };
      if (seen.has(entry.task.id)) continue;
      seen.add(entry.task.id);
      result.push({ task: entry.task, depth: Math.min(entry.depth, TASK_MAX_DEPTH - 1) });
      const children = this.childrenOf(entry.task.id);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ task: children[index] as TaskRecord, depth: entry.depth + 1 });
      }
    }
    return result;
  }
}
