import {
  type LabelCreate,
  type LabelUpdate,
  type LabelView,
  type TaskCollection,
  type TaskCompleteRequest,
  type TaskCompleteResponse,
  type TaskCreateRequest,
  type TaskCreateResponse,
  type TaskDetailResponse,
  type TaskMoveRequest,
  type TaskMoveResponse,
  type TaskNode,
  type TaskRenameResponse,
  type TaskRestoreResponse,
  taskCollections,
} from "@symplist/contracts";
import type { WorkspaceApi } from "./api.ts";
import { classifyFailure, type Failure } from "./errors.ts";
import {
  findTask,
  type InsertPlacement,
  insertSubtree,
  promoteChildren,
  removeSubtree,
  renameInList,
  setLabelsInList,
  subtreeOf,
  type TaskList,
} from "./tree.ts";

export type LoadStatus = "idle" | "loading" | "ready" | "error";

export interface CollectionSnapshot {
  readonly collection: TaskCollection;
  readonly status: LoadStatus;
  /** The server's tree with every pending local change applied, in pre-order. */
  readonly tasks: TaskList;
  /** The version of the server tree the snapshot starts from. */
  readonly taskTreeVersion: number;
  /** The owner's labels with their task counts, as this tree response carried them. */
  readonly labels: readonly LabelView[];
  /** The failure of the last load, when the list could not be shown. */
  readonly failure: Failure | null;
}

export interface DetailSnapshot {
  readonly status: LoadStatus;
  readonly detail: TaskDetailResponse | null;
  readonly failure: Failure | null;
}

/**
 * A local change shown before the server's tree includes it. `apply` must be idempotent: once a fresh
 * tree already holds the change, applying it again leaves the tree as it is.
 */
interface LocalChange {
  readonly id: number;
  readonly collections: readonly TaskCollection[];
  readonly apply: (collection: TaskCollection, list: TaskList) => TaskList;
  readonly applyDetail?: (detail: TaskDetailResponse) => TaskDetailResponse;
  /** Labels ride in the tree response, so a label write shows through the same mechanism. */
  readonly applyLabels?: (labels: readonly LabelView[]) => readonly LabelView[];
  /** Set when the server confirmed the change; the change is dropped after a later fetch. */
  confirmedSeq: number | null;
  /** The lists and details refetched after confirmation, which must include the change. */
  watch: { readonly collections: readonly TaskCollection[]; readonly taskIds: readonly string[] };
}

interface CollectionEntry {
  status: LoadStatus;
  base: TaskList;
  baseLabels: readonly LabelView[];
  version: number;
  failure: Failure | null;
  /** The sequence at which the request that produced `base` started. */
  loadedSeq: number;
  inFlight: boolean;
  again: boolean;
  snapshot: CollectionSnapshot | null;
}

interface DetailEntry {
  status: LoadStatus;
  detail: TaskDetailResponse | null;
  failure: Failure | null;
  loadedSeq: number;
  inFlight: boolean;
  again: boolean;
  snapshot: DetailSnapshot | null;
}

const idleDetail: DetailSnapshot = Object.freeze({ status: "idle", detail: null, failure: null });

/**
 * Task details kept before the least recently loaded one is dropped. Without a bound the map grows
 * with every task opened in a session, and a reconnect refetches all of them at once — a request per
 * task the person has long since moved on from (§3 D1 budget). A detail a pane is still showing is
 * loaded again by that pane, so dropping one costs at most one request.
 */
const MAX_DETAILS = 20;

/**
 * The owner's task trees and open task details for the web client (§2.1, §3.3). Writes show at once
 * as local changes; a confirmed change stays applied until a tree fetched after the confirmation
 * replaces it, and a refused one is removed so the list reverts. `tasks.changed` events and every
 * confirmed write refetch the affected lists, so all devices converge on the server's order.
 */
export class TaskStore {
  private readonly collections = new Map<TaskCollection, CollectionEntry>();
  private readonly details = new Map<string, DetailEntry>();
  private changes: LocalChange[] = [];
  private readonly listeners = new Set<() => void>();
  private seq = 0;
  private changeIds = 0;
  private disposed = false;

  constructor(private readonly api: WorkspaceApi) {
    for (const collection of taskCollections) {
      this.collections.set(collection, {
        status: "idle",
        base: [],
        baseLabels: [],
        version: 0,
        failure: null,
        loadedSeq: 0,
        inFlight: false,
        again: false,
        snapshot: null,
      });
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  /**
   * Undoes a `dispose()` for a store that is mounted again rather than replaced.
   *
   * React's development Strict Mode mounts, unmounts and remounts, while the provider keeps this
   * instance in a `useMemo` whose dependencies did not change. Without this the store came back
   * permanently dead: every read resolved into a `disposed` guard, so a list that was already
   * fetched stayed `loading` and `ensureCollection()` (which only acts on `idle`) never asked
   * again. The API returned the tasks and the store dropped them — an empty workspace with a
   * perfectly healthy `GET /v1/tasks` behind it.
   *
   * An entry left `loading` with no request in flight is reset so the next read starts a real one.
   */
  reopen(): void {
    this.disposed = false;
    for (const entry of this.collections.values()) {
      if (entry.status === "loading" && !entry.inFlight) {
        entry.status = "idle";
        entry.snapshot = null;
      }
    }
    for (const entry of this.details.values()) {
      if (entry.status === "loading" && !entry.inFlight) {
        entry.status = "idle";
        entry.snapshot = null;
      }
    }
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Reads                                                                                        */
  /* ------------------------------------------------------------------------------------------ */

  collection(collection: TaskCollection): CollectionSnapshot {
    const entry = this.entry(collection);
    if (!entry.snapshot) {
      entry.snapshot = {
        collection,
        status: entry.status,
        tasks: this.view(collection, entry.base),
        taskTreeVersion: entry.version,
        labels: this.labelView(entry.baseLabels),
        failure: entry.failure,
      };
    }
    return entry.snapshot;
  }

  detail(taskId: string): DetailSnapshot {
    const entry = this.details.get(taskId);
    if (!entry) return idleDetail;
    if (!entry.snapshot) {
      entry.snapshot = {
        status: entry.status,
        detail: entry.detail ? this.detailView(entry.detail) : null,
        failure: entry.failure,
      };
    }
    return entry.snapshot;
  }

  /** The task as shown in any loaded list, with local changes applied. */
  findLoaded(taskId: string): TaskNode | undefined {
    for (const collection of taskCollections) {
      const found = findTask(this.collection(collection).tasks, taskId);
      if (found) return found;
    }
    return undefined;
  }

  /** The highest tree version any loaded list or detail started from. */
  get loadedVersion(): number {
    let version = 0;
    for (const entry of this.collections.values()) version = Math.max(version, entry.version);
    return version;
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Loading                                                                                      */
  /* ------------------------------------------------------------------------------------------ */

  /** Loads a list unless it is loaded or loading. */
  ensureCollection(collection: TaskCollection): void {
    const entry = this.entry(collection);
    if (entry.status === "idle") void this.refresh(collection);
  }

  /** Fetches a list again; a request already running is followed by one more. */
  /**
   * A whole collection, following the pages `GET /v1/tasks` returns (§3 D1 budget). The list is one
   * tree, not a feed, so the workspace holds all of it; the window only bounds each response.
   *
   * A page whose `taskTreeVersion` differs from the first has been read against a tree that moved,
   * so the walk starts again from the beginning rather than stitching two different trees together.
   * A realtime `tasks.changed` will schedule another refresh anyway; the attempt bound is there so a
   * tree under constant writes cannot hold the loop open.
   */
  private async loadWholeCollection(collection: TaskCollection): Promise<{
    readonly tasks: readonly TaskNode[];
    readonly taskTreeVersion: number;
    readonly labels: readonly LabelView[];
  }> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const first = await this.api.listTasks(collection);
      const tasks = [...first.tasks];
      let cursor = first.nextCursor;
      let restart = false;
      while (cursor !== null) {
        const page = await this.api.listTasks(collection, { cursor });
        if (page.taskTreeVersion !== first.taskTreeVersion) {
          restart = true;
          break;
        }
        tasks.push(...page.tasks);
        cursor = page.nextCursor;
      }
      if (!restart) {
        return { tasks, taskTreeVersion: first.taskTreeVersion, labels: first.labels };
      }
    }
    // Every attempt was overtaken. Take the first page's tree, which is internally consistent, and
    // let the version it reports bring the next refresh.
    const last = await this.api.listTasks(collection);
    return { tasks: last.tasks, taskTreeVersion: last.taskTreeVersion, labels: last.labels };
  }

  async refresh(collection: TaskCollection): Promise<void> {
    const entry = this.entry(collection);
    if (entry.inFlight) {
      entry.again = true;
      return;
    }
    entry.inFlight = true;
    if (entry.status !== "ready") {
      entry.status = "loading";
      entry.failure = null;
      this.touchCollection(collection);
    }
    const startSeq = this.nextSeq();
    try {
      const response = await this.loadWholeCollection(collection);
      if (this.disposed) return;
      entry.base = response.tasks;
      entry.baseLabels = response.labels;
      entry.version = response.taskTreeVersion;
      entry.loadedSeq = startSeq;
      entry.status = "ready";
      entry.failure = null;
    } catch (error) {
      if (this.disposed) return;
      const failure = classifyFailure(error);
      entry.failure = failure;
      // A refresh over a list already shown keeps it; only a list that never loaded shows the error.
      if (entry.status !== "ready") entry.status = "error";
    } finally {
      entry.inFlight = false;
    }
    this.pruneChanges();
    this.touchCollection(collection);
    if (entry.again) {
      entry.again = false;
      await this.refresh(collection);
    }
  }

  ensureDetail(taskId: string): void {
    const entry = this.details.get(taskId);
    if (!entry || entry.status === "idle") void this.refreshDetail(taskId);
  }

  async refreshDetail(taskId: string): Promise<void> {
    let entry = this.details.get(taskId);
    if (!entry) {
      entry = {
        status: "idle",
        detail: null,
        failure: null,
        loadedSeq: 0,
        inFlight: false,
        again: false,
        snapshot: null,
      };
    }
    // Re-inserted, so the map stays in least-recently-loaded order for `trimDetails`.
    this.details.delete(taskId);
    this.details.set(taskId, entry);
    this.trimDetails();
    if (entry.inFlight) {
      entry.again = true;
      return;
    }
    entry.inFlight = true;
    if (entry.status !== "ready") {
      entry.status = "loading";
      entry.snapshot = null;
      this.emit();
    }
    const startSeq = this.nextSeq();
    try {
      const detail = await this.api.getTask(taskId);
      if (this.disposed) return;
      entry.detail = detail;
      entry.loadedSeq = startSeq;
      entry.status = "ready";
      entry.failure = null;
    } catch (error) {
      if (this.disposed) return;
      const failure = classifyFailure(error);
      entry.failure = failure;
      if (entry.status !== "ready" || failure.kind === "not_found") {
        entry.status = "error";
        if (failure.kind === "not_found") entry.detail = null;
      }
    } finally {
      entry.inFlight = false;
    }
    entry.snapshot = null;
    this.pruneChanges();
    this.emit();
    if (entry.again) {
      entry.again = false;
      await this.refreshDetail(taskId);
    }
  }

  /**
   * A `tasks.changed` event or user snapshot (§7): lists loaded from an older version refetch, and
   * open details named by the event (or all of them, when the event names none) refetch.
   */
  noteTreeVersion(taskTreeVersion: number, taskIds: readonly string[] = []): void {
    for (const collection of taskCollections) {
      const entry = this.entry(collection);
      if (entry.status !== "idle" && entry.version < taskTreeVersion) void this.refresh(collection);
    }
    // Over a copy: `refreshDetail` re-inserts its entry to keep the map in recency order, and a Map
    // visits an entry added during iteration again, which would never end.
    for (const [taskId, entry] of [...this.details]) {
      if (entry.status === "idle") continue;
      if (taskIds.length === 0 || taskIds.includes(taskId)) void this.refreshDetail(taskId);
    }
  }

  /** Refetches every loaded list and detail (for example after reconnecting). */
  refreshAll(): void {
    for (const collection of taskCollections) {
      if (this.entry(collection).status !== "idle") void this.refresh(collection);
    }
    for (const [taskId, entry] of [...this.details]) {
      if (entry.status !== "idle") void this.refreshDetail(taskId);
    }
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Writes                                                                                       */
  /* ------------------------------------------------------------------------------------------ */

  /** Creates a task; it appears once the server confirms it. */
  async create(body: TaskCreateRequest, idempotencyKey: string): Promise<TaskCreateResponse> {
    const response = await this.api.createTask(body, idempotencyKey);
    const node = response.task;
    const change = this.addChange({
      collections: [node.collection],
      apply: (collection, list) => {
        if (collection !== node.collection || findTask(list, node.id)) return list;
        return insertSubtree(list, [{ ...node, depth: 0 }], {
          collection: node.collection,
          parentId: node.parentId,
        });
      },
      applyDetail: (detail) =>
        detail.task.id === node.parentId
          ? { ...detail, task: { ...detail.task, childCount: detail.task.childCount + 1 } }
          : detail,
    });
    this.confirm(change, [node.collection], node.parentId ? [node.parentId] : []);
    return response;
  }

  async rename(taskId: string, title: string, idempotencyKey: string): Promise<TaskRenameResponse> {
    const change = this.addChange({
      collections: taskCollections,
      apply: (_collection, list) => renameInList(list, taskId, title),
      applyDetail: (detail) =>
        detail.task.id === taskId ? { ...detail, task: { ...detail.task, title } } : detail,
    });
    try {
      const response = await this.api.renameTask(taskId, title, idempotencyKey);
      this.confirm(change, this.collectionsHolding(taskId), [taskId]);
      return response;
    } catch (error) {
      this.reject(change);
      throw error;
    }
  }

  /**
   * Moves a task with its subtasks. `target` is where the optimistic list shows it; the request is
   * what the server decides from (neighbours, parent or collection).
   */
  async move(
    taskId: string,
    request: TaskMoveRequest,
    target: InsertPlacement,
    idempotencyKey: string,
  ): Promise<TaskMoveResponse> {
    const source = this.collectionsHolding(taskId);
    const sourceCollection = source[0] ?? null;
    const subtree = sourceCollection
      ? subtreeOf(this.collection(sourceCollection).tasks, taskId)
      : [];
    const affected = Array.from(new Set([...source, target.collection]));
    const change = this.addChange({
      collections: affected,
      apply: (collection, list) => {
        const { list: without } = removeSubtree(list, taskId);
        if (collection !== target.collection || subtree.length === 0) return without;
        return insertSubtree(without, subtree, target);
      },
      applyDetail: (detail) =>
        detail.task.id === taskId
          ? {
              ...detail,
              task: {
                ...detail.task,
                collection: target.collection,
                parentId: target.parentId as TaskNode["parentId"],
              },
            }
          : detail,
    });
    try {
      const response = await this.api.moveTask(taskId, request, idempotencyKey);
      this.confirm(change, affected, [taskId]);
      return response;
    } catch (error) {
      this.reject(change);
      throw error;
    }
  }

  /** Completes a task (§2.1). The list hides it at once and shows it again if the server refuses. */
  async complete(
    taskId: string,
    request: TaskCompleteRequest,
    idempotencyKey: string,
  ): Promise<TaskCompleteResponse> {
    const affected = this.collectionsHolding(taskId);
    const change = this.addChange({
      collections: affected,
      apply: (_collection, list) =>
        request.mode === "parent_only"
          ? promoteChildren(list, taskId)
          : removeSubtree(list, taskId).list,
      applyDetail: (detail) =>
        detail.task.id === taskId
          ? { ...detail, task: { ...detail.task, status: "archived" } }
          : detail,
    });
    try {
      const response = await this.api.completeTask(taskId, request, idempotencyKey);
      this.confirm(change, affected, [taskId, ...response.archivedTaskIds]);
      return response;
    } catch (error) {
      this.reject(change);
      throw error;
    }
  }

  /**
   * Restores an archived task (P2). `shown`, when known (an Undo right after completing), puts its
   * subtree back at once where it was; otherwise it appears after the refetch.
   */
  async restore(
    taskId: string,
    idempotencyKey: string,
    shown?: { readonly subtree: readonly TaskNode[]; readonly placement: InsertPlacement },
  ): Promise<TaskRestoreResponse> {
    const change = shown
      ? this.addChange({
          collections: [shown.placement.collection],
          apply: (collection, list) => {
            if (collection !== shown.placement.collection || findTask(list, taskId)) return list;
            return insertSubtree(list, shown.subtree, shown.placement);
          },
          applyDetail: (detail) =>
            detail.task.id === taskId
              ? { ...detail, task: { ...detail.task, status: "active" } }
              : detail,
        })
      : null;
    try {
      const response = await this.api.restoreTask(taskId, idempotencyKey);
      const affected = Array.from(
        new Set([response.collection, ...(shown ? [shown.placement.collection] : [])]),
      );
      if (change) this.confirm(change, affected, [taskId, ...response.restoredTaskIds]);
      else this.refetch(affected, [taskId, ...response.restoredTaskIds]);
      return response;
    } catch (error) {
      if (change) this.reject(change);
      throw error;
    }
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Labels                                                                                       */
  /* ------------------------------------------------------------------------------------------ */

  /*
   * Labels ride in the tree response, so a label write is a tree change: it shows at once as a local
   * change and the refetch of every loaded list brings the server's own version of it. There is no
   * separate list to fetch and nothing to keep in step.
   */

  /** Replaces the labels a task carries. The chips change at once and revert if the write fails. */
  async setTaskLabels(taskId: string, labelIds: readonly string[]): Promise<void> {
    const affected = this.collectionsHolding(taskId);
    const previous = this.findLoaded(taskId)?.labelIds ?? [];
    const change = this.addChange({
      collections: affected.length > 0 ? affected : taskCollections,
      apply: (_collection, list) => setLabelsInList(list, taskId, labelIds),
      applyLabels: (labels) => recount(labels, previous, labelIds),
    });
    try {
      await this.api.setTaskLabels(taskId, labelIds);
      this.confirm(change, affected, [taskId]);
    } catch (error) {
      this.reject(change);
      throw error;
    }
  }

  /** Creates a label. It appears in every loaded list's label set once the server confirms it. */
  async createLabel(body: LabelCreate): Promise<LabelView> {
    const created = await this.api.createLabel(body);
    const change = this.addChange({
      collections: taskCollections,
      apply: (_collection, list) => list,
      applyLabels: (labels) =>
        labels.some((label) => label.id === created.id) ? labels : [...labels, created],
    });
    this.confirm(change, taskCollections, []);
    return created;
  }

  /** Renames or recolours a label. */
  async updateLabel(labelId: string, patch: LabelUpdate): Promise<LabelView> {
    const change = this.addChange({
      collections: taskCollections,
      apply: (_collection, list) => list,
      applyLabels: (labels) =>
        labels.map((label) => (label.id === labelId ? { ...label, ...patch } : label)),
    });
    try {
      const updated = await this.api.updateLabel(labelId, patch);
      this.confirm(change, taskCollections, []);
      return updated;
    } catch (error) {
      this.reject(change);
      throw error;
    }
  }

  /** Deletes a label, and with it every task's chip for it. */
  async deleteLabel(labelId: string): Promise<void> {
    const change = this.addChange({
      collections: taskCollections,
      apply: (_collection, list) =>
        list.map((task) =>
          task.labelIds.includes(labelId)
            ? { ...task, labelIds: task.labelIds.filter((id) => id !== labelId) }
            : task,
        ),
      applyLabels: (labels) => labels.filter((label) => label.id !== labelId),
    });
    try {
      await this.api.deleteLabel(labelId);
      this.confirm(change, taskCollections, []);
    } catch (error) {
      this.reject(change);
      throw error;
    }
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Internals                                                                                    */
  /* ------------------------------------------------------------------------------------------ */

  private entry(collection: TaskCollection): CollectionEntry {
    return this.collections.get(collection) as CollectionEntry;
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** The loaded lists that show the task now. */
  private collectionsHolding(taskId: string): TaskCollection[] {
    return taskCollections.filter((collection) =>
      Boolean(findTask(this.collection(collection).tasks, taskId)),
    );
  }

  private view(collection: TaskCollection, base: TaskList): TaskList {
    let list = base;
    for (const change of this.changes) {
      if (change.collections.includes(collection)) list = change.apply(collection, list);
    }
    return list;
  }

  private labelView(base: readonly LabelView[]): readonly LabelView[] {
    let labels = base;
    for (const change of this.changes) {
      if (change.applyLabels) labels = change.applyLabels(labels);
    }
    return labels;
  }

  private detailView(detail: TaskDetailResponse): TaskDetailResponse {
    let value = detail;
    for (const change of this.changes) {
      if (change.applyDetail) value = change.applyDetail(value);
    }
    return value;
  }

  private addChange(input: Omit<LocalChange, "id" | "confirmedSeq" | "watch">): LocalChange {
    this.changeIds += 1;
    const change: LocalChange = {
      ...input,
      id: this.changeIds,
      confirmedSeq: null,
      watch: { collections: [], taskIds: [] },
    };
    this.changes = [...this.changes, change];
    this.touchAll();
    return change;
  }

  private confirm(
    change: LocalChange,
    collections: readonly TaskCollection[],
    taskIds: readonly string[],
  ): void {
    change.confirmedSeq = this.nextSeq();
    change.watch = { collections, taskIds };
    this.refetch(collections, taskIds);
  }

  private refetch(collections: readonly TaskCollection[], taskIds: readonly string[]): void {
    for (const collection of collections) {
      if (this.entry(collection).status !== "idle") void this.refresh(collection);
    }
    for (const taskId of taskIds) {
      const entry = this.details.get(taskId);
      if (entry && entry.status !== "idle") void this.refreshDetail(taskId);
    }
    this.pruneChanges();
  }

  private reject(change: LocalChange): void {
    this.changes = this.changes.filter((candidate) => candidate.id !== change.id);
    this.touchAll();
  }

  /** Drops confirmed changes once every list and detail they touch was fetched afterwards. */
  private pruneChanges(): void {
    const kept = this.changes.filter((change) => {
      if (change.confirmedSeq === null) return true;
      const confirmedSeq = change.confirmedSeq;
      const listsCurrent = change.watch.collections.every((collection) => {
        const entry = this.entry(collection);
        return entry.status === "idle" || entry.loadedSeq > confirmedSeq;
      });
      const detailsCurrent = change.watch.taskIds.every((taskId) => {
        const entry = this.details.get(taskId);
        return !entry || entry.status === "idle" || entry.loadedSeq > confirmedSeq;
      });
      return !(listsCurrent && detailsCurrent);
    });
    if (kept.length !== this.changes.length) {
      this.changes = kept;
      this.touchAll();
    }
  }

  /** Drops the least recently loaded details past {@link MAX_DETAILS}, never one mid-request. */
  private trimDetails(): void {
    if (this.details.size <= MAX_DETAILS) return;
    for (const [taskId, entry] of this.details) {
      if (this.details.size <= MAX_DETAILS) return;
      if (!entry.inFlight) this.details.delete(taskId);
    }
  }

  private touchCollection(collection: TaskCollection): void {
    this.entry(collection).snapshot = null;
    this.emit();
  }

  private touchAll(): void {
    for (const entry of this.collections.values()) entry.snapshot = null;
    for (const entry of this.details.values()) entry.snapshot = null;
    this.emit();
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * The label counts a task's new set produces, so a chip's count moves with the chip rather than
 * waiting for the refetch. Idempotent by construction: once the server's own tree already holds the
 * new set, `previous` and `next` are the same and the counts are left alone.
 */
function recount(
  labels: readonly LabelView[],
  previous: readonly string[],
  next: readonly string[],
): readonly LabelView[] {
  const added = new Set(next.filter((id) => !previous.includes(id)));
  const removed = new Set(previous.filter((id) => !next.includes(id)));
  if (added.size === 0 && removed.size === 0) return labels;
  return labels.map((label) => {
    if (added.has(label.id)) return { ...label, taskCount: label.taskCount + 1 };
    if (removed.has(label.id)) return { ...label, taskCount: Math.max(0, label.taskCount - 1) };
    return label;
  });
}
