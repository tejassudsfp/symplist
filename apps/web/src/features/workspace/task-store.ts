import {
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
  /** Set when the server confirmed the change; the change is dropped after a later fetch. */
  confirmedSeq: number | null;
  /** The lists and details refetched after confirmation, which must include the change. */
  watch: { readonly collections: readonly TaskCollection[]; readonly taskIds: readonly string[] };
}

interface CollectionEntry {
  status: LoadStatus;
  base: TaskList;
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
      const response = await this.api.listTasks(collection);
      if (this.disposed) return;
      entry.base = response.tasks;
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
      this.details.set(taskId, entry);
    }
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
    for (const [taskId, entry] of this.details) {
      if (entry.status === "idle") continue;
      if (taskIds.length === 0 || taskIds.includes(taskId)) void this.refreshDetail(taskId);
    }
  }

  /** Refetches every loaded list and detail (for example after reconnecting). */
  refreshAll(): void {
    for (const collection of taskCollections) {
      if (this.entry(collection).status !== "idle") void this.refresh(collection);
    }
    for (const [taskId, entry] of this.details) {
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
