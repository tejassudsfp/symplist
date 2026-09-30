import type {
  ArchivedTaskNode,
  ArchiveQuery,
  ArchiveResponse,
  LabelColour,
  LabelCreate,
  LabelList,
  LabelUpdate,
  LabelView,
  PreferenceDataByGroup,
  PreferenceEntry,
  PreferenceGroup,
  PreferencesPutResponse,
  PreferencesResponse,
  TaskCollection,
  TaskCompleteRequest,
  TaskCompleteResponse,
  TaskCreateRequest,
  TaskCreateResponse,
  TaskDetailResponse,
  TaskId,
  TaskLabels,
  TaskMoveRequest,
  TaskMoveResponse,
  TaskNode,
  TaskRenameResponse,
  TaskRestoreResponse,
} from "@symplist/contracts";
import {
  LABEL_MAX_PER_TASK,
  normalizeLabelName,
  preferenceDefaults,
  preferenceGroups,
} from "@symplist/contracts";
import { type RenderResult, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { ActionsProvider } from "@/actions/provider";
import { actionRegistry } from "@/actions/registry-index";
import type { ActionServices } from "@/actions/types";
import { StatusAnnouncerProvider } from "@/components/ui/status-announcer";
import { ToastProvider } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import type { WorkspaceApi } from "./api.ts";
import { WorkspaceProvider } from "./workspace-provider.tsx";

/*
 * Test support for the workspace: an in-memory stand-in for the api that keeps the shapes the
 * contracts describe (pre-order trees with depth and child counts, versioned preference groups,
 * archive groups by day), plus the providers the feature is mounted inside.
 */

/**
 * The navigation mock every workspace test installs itself. It cannot live here: a `vi.mock` factory
 * that imports this module would deadlock, because this module imports `next/navigation` through the
 * workspace provider.
 *
 * ```ts
 * const navigation = vi.hoisted(() => ({ pathname: "/now", push: vi.fn(), replace: vi.fn() }));
 * vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname, useRouter: () => … }));
 * ```
 */

export interface SeedTask {
  readonly id: string;
  readonly title: string;
  readonly collection?: TaskCollection;
  readonly parentId?: string;
  readonly preview?: string;
  readonly source?: TaskNode["source"];
  /** Label ids this task carries; seed them with {@link FakeWorkspaceApi.seedLabel}. */
  readonly labelIds?: readonly string[];
}

interface StoredLabel {
  id: string;
  name: string;
  colour: LabelColour;
  createdAt: number;
  updatedAt: number;
}

interface StoredTask {
  id: string;
  parentId: string | null;
  collection: TaskCollection;
  position: number;
  title: string;
  preview: string | null;
  source: TaskNode["source"];
  version: number;
  status: "active" | "archived";
  archivedAt: number | null;
  archivedWithRootId: string | null;
  createdAt: number;
  updatedAt: number;
  labelIds: string[];
}

export type FailureKey =
  | "listTasks"
  | "createTask"
  | "renameTask"
  | "moveTask"
  | "completeTask"
  | "restoreTask"
  | "listArchive"
  | "getPreferences"
  | "putPreference"
  | "createLabel"
  | "updateLabel"
  | "deleteLabel"
  | "setTaskLabels";

const now = Date.UTC(2026, 8, 16, 9, 0, 0);

function positionKey(index: number): string {
  return `a${index.toString(36)}`;
}

/** An in-memory workspace api with the same observable behavior as the routes it stands in for. */
export class FakeWorkspaceApi implements WorkspaceApi {
  private tasks: StoredTask[] = [];
  private labels: StoredLabel[] = [];
  private sequence = 0;
  private preferences = new Map<PreferenceGroup, { version: number; data: unknown }>();
  /** One scripted failure per call, consumed on use; `persist` keeps failing. */
  private failures = new Map<FailureKey, { error: unknown; persist: boolean }>();
  readonly calls: { readonly method: string; readonly detail: unknown }[] = [];

  constructor(seed: readonly SeedTask[] = []) {
    for (const group of preferenceGroups) {
      this.preferences.set(group, { version: 0, data: preferenceDefaults[group] });
    }
    for (const task of seed) this.seed(task);
  }

  seed(task: SeedTask): void {
    this.sequence += 1;
    const parent = task.parentId ? this.byId(task.parentId) : null;
    this.tasks.push({
      id: task.id,
      parentId: parent?.id ?? null,
      collection: parent?.collection ?? task.collection ?? "now",
      position: this.sequence,
      title: task.title,
      preview: task.preview ?? null,
      source: task.source ?? "user",
      version: 1,
      status: "active",
      archivedAt: null,
      archivedWithRootId: null,
      createdAt: now + this.sequence,
      updatedAt: now + this.sequence,
      labelIds: [...(task.labelIds ?? [])],
    });
  }

  /** Adds a label the same way `POST /v1/labels` would, without going through a request. */
  seedLabel(id: string, name: string, colour: LabelColour = "blue"): string {
    this.sequence += 1;
    this.labels.push({
      id,
      name: normalizeLabelName(name),
      colour,
      createdAt: now + this.sequence,
      updatedAt: now + this.sequence,
    });
    return id;
  }

  /** The label ids a task carries, in the owner's label order. */
  labelsOf(taskId: string): string[] {
    return this.orderedLabelIds(this.byId(taskId)?.labelIds ?? []);
  }

  private orderedLabelIds(ids: readonly string[]): string[] {
    return this.labels.filter((label) => ids.includes(label.id)).map((label) => label.id);
  }

  private labelViews(): LabelView[] {
    return this.labels.map((label) => ({
      id: label.id,
      name: label.name,
      colour: label.colour,
      taskCount: this.tasks.filter(
        (task) => task.status === "active" && task.labelIds.includes(label.id),
      ).length,
      createdAt: label.createdAt,
      updatedAt: label.updatedAt,
    }));
  }

  private labelError(status: number, code: string, details?: Record<string, unknown>): ApiError {
    return new ApiError({
      status,
      code,
      message: "Refused",
      requestId: "req-test",
      ...(details ? { details } : {}),
    });
  }

  /** Scripts the next call of `key` to fail; `persist` makes every call fail. */
  fail(
    key: FailureKey,
    error: unknown = new ApiError({
      status: 503,
      code: "rate.limited",
      message: "Symplist is busy",
      requestId: "req-test",
    }),
    persist = false,
  ): void {
    this.failures.set(key, { error, persist });
  }

  clearFailure(key: FailureKey): void {
    this.failures.delete(key);
  }

  /** The stored preference group, as the account holds it. */
  storedPreference<Group extends PreferenceGroup>(group: Group): PreferenceDataByGroup[Group] {
    return this.preferences.get(group)?.data as PreferenceDataByGroup[Group];
  }

  setPreference(group: PreferenceGroup, data: unknown, version = 1): void {
    this.preferences.set(group, { version, data });
  }

  titles(collection: TaskCollection): string[] {
    return this.activeTree(collection).map((task) => `${"  ".repeat(task.depth)}${task.title}`);
  }

  archivedIds(): string[] {
    return this.tasks.filter((task) => task.status === "archived").map((task) => task.id);
  }

  private check(key: FailureKey): void {
    const failure = this.failures.get(key);
    if (!failure) return;
    if (!failure.persist) this.failures.delete(key);
    throw failure.error;
  }

  private byId(id: string): StoredTask | undefined {
    return this.tasks.find((task) => task.id === id);
  }

  private childrenOf(parentId: string | null, collection: TaskCollection): StoredTask[] {
    return this.tasks
      .filter(
        (task) =>
          task.status === "active" && task.parentId === parentId && task.collection === collection,
      )
      .sort((a, b) => a.position - b.position);
  }

  private activeTree(collection: TaskCollection): TaskNode[] {
    const walk = (parentId: string | null, depth: number): TaskNode[] =>
      this.childrenOf(parentId, collection).flatMap((task) => [
        this.node(task, depth),
        ...walk(task.id, depth + 1),
      ]);
    return walk(null, 0);
  }

  private node(task: StoredTask, depth: number): TaskNode {
    return {
      id: task.id as TaskId,
      parentId: (task.parentId ?? null) as TaskId | null,
      collection: task.collection,
      position: positionKey(task.position),
      depth,
      title: task.title,
      preview: task.preview,
      source: task.source,
      version: task.version,
      childCount: this.childrenOf(task.id, task.collection).length,
      labelIds: this.orderedLabelIds(task.labelIds),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  private subtree(task: StoredTask): StoredTask[] {
    const children = this.tasks.filter((candidate) => candidate.parentId === task.id);
    return [task, ...children.flatMap((child) => this.subtree(child))];
  }

  private depthOf(task: StoredTask): number {
    let depth = 0;
    let current = task;
    while (current.parentId) {
      const parent = this.byId(current.parentId);
      if (!parent) break;
      depth += 1;
      current = parent;
    }
    return depth;
  }

  private nextPosition(): number {
    this.sequence += 1;
    return this.sequence;
  }

  /* --------------------------------------------------------------------------------------- */

  /**
   * One page of a collection, as the route returns it. `pageSize` makes a test walk real pages; by
   * default a collection fits in one, so most tests never see a cursor.
   */
  pageSize = Number.POSITIVE_INFINITY;

  async listTasks(collection: TaskCollection, options?: { readonly cursor?: string }) {
    this.calls.push({
      method: "listTasks",
      detail: { collection, cursor: options?.cursor ?? null },
    });
    this.check("listTasks");
    const all = this.activeTree(collection);
    const offset = options?.cursor ? Number(options.cursor.split(":")[1] ?? 0) : 0;
    const end = Number.isFinite(this.pageSize) ? offset + this.pageSize : all.length;
    const tasks = all.slice(offset, end);
    return {
      collection,
      taskTreeVersion: this.sequence,
      tasks,
      labels: this.labelViews(),
      nextCursor: offset + tasks.length < all.length ? `p:${offset + tasks.length}` : null,
    };
  }

  async listLabels(): Promise<LabelList> {
    this.calls.push({ method: "listLabels", detail: null });
    return { labels: this.labelViews() };
  }

  async createLabel(body: LabelCreate): Promise<LabelView> {
    this.calls.push({ method: "createLabel", detail: body });
    this.check("createLabel");
    const name = normalizeLabelName(body.name);
    const clash = this.labels.find(
      (label) => label.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0,
    );
    if (clash) {
      throw this.labelError(409, "label.duplicate_name", { labelId: clash.id });
    }
    this.sequence += 1;
    const id = `label-${this.sequence}`;
    this.seedLabel(id, name, body.colour);
    return this.labelViews().find((label) => label.id === id) as LabelView;
  }

  async updateLabel(labelId: string, patch: LabelUpdate): Promise<LabelView> {
    this.calls.push({ method: "updateLabel", detail: { labelId, patch } });
    this.check("updateLabel");
    const label = this.labels.find((candidate) => candidate.id === labelId);
    if (!label) throw this.labelError(404, "label.unknown");
    const name = patch.name === undefined ? label.name : normalizeLabelName(patch.name);
    const clash = this.labels.find(
      (candidate) =>
        candidate.id !== labelId &&
        candidate.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0,
    );
    if (clash) throw this.labelError(409, "label.duplicate_name", { labelId: clash.id });
    label.name = name;
    if (patch.colour !== undefined) label.colour = patch.colour;
    this.sequence += 1;
    label.updatedAt = now + this.sequence;
    return this.labelViews().find((candidate) => candidate.id === labelId) as LabelView;
  }

  async deleteLabel(labelId: string): Promise<void> {
    this.calls.push({ method: "deleteLabel", detail: labelId });
    this.check("deleteLabel");
    if (!this.labels.some((label) => label.id === labelId)) {
      throw this.labelError(404, "label.unknown");
    }
    this.labels = this.labels.filter((label) => label.id !== labelId);
    for (const task of this.tasks) {
      task.labelIds = task.labelIds.filter((id) => id !== labelId);
    }
    this.sequence += 1;
  }

  async setTaskLabels(taskId: string, labelIds: readonly string[]): Promise<TaskLabels> {
    this.calls.push({ method: "setTaskLabels", detail: { taskId, labelIds: [...labelIds] } });
    this.check("setTaskLabels");
    const unique = [...new Set(labelIds)];
    if (unique.length > LABEL_MAX_PER_TASK) {
      throw this.labelError(422, "label.limit_reached", { limit: LABEL_MAX_PER_TASK });
    }
    for (const id of unique) {
      if (!this.labels.some((label) => label.id === id))
        throw this.labelError(404, "label.unknown");
    }
    // An unknown task and an archived one are both "not there", as the route has it.
    const task = this.byId(taskId);
    if (task?.status !== "active") throw this.labelError(404, "not_found");
    task.labelIds = unique;
    this.sequence += 1;
    return { taskId: taskId as TaskId, labelIds: this.orderedLabelIds(unique) };
  }

  async getTask(taskId: string): Promise<TaskDetailResponse> {
    this.calls.push({ method: "getTask", detail: taskId });
    const task = this.byId(taskId);
    if (!task) {
      throw new ApiError({
        status: 404,
        code: "not_found",
        message: "Not found",
        requestId: "req-test",
      });
    }
    const ancestors: TaskDetailResponse["ancestors"] = [];
    let parentId = task.parentId;
    while (parentId) {
      const parent = this.byId(parentId);
      if (!parent) break;
      ancestors.unshift({ id: parent.id as TaskId, title: parent.title, status: parent.status });
      parentId = parent.parentId;
    }
    return {
      task: {
        id: task.id as TaskId,
        parentId: (task.parentId ?? null) as TaskId | null,
        collection: task.collection,
        position: positionKey(task.position),
        status: task.status,
        title: task.title,
        preview: task.preview,
        source: task.source,
        version: task.version,
        childCount: this.childrenOf(task.id, task.collection).length,
        archivedAt: task.archivedAt,
        archivedWithRootId: (task.archivedWithRootId ?? null) as TaskId | null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
      ancestors,
    };
  }

  async createTask(body: TaskCreateRequest): Promise<TaskCreateResponse> {
    this.calls.push({ method: "createTask", detail: body });
    this.check("createTask");
    const parent = body.parentId ? this.byId(body.parentId) : null;
    const task: StoredTask = {
      id: `task-${this.tasks.length + 1}-${body.title.replace(/\W+/g, "-").toLowerCase()}`,
      parentId: parent?.id ?? null,
      collection: parent?.collection ?? body.collection ?? "now",
      position: this.nextPosition(),
      title: body.title,
      preview: null,
      source: "user",
      version: 1,
      status: "active",
      archivedAt: null,
      archivedWithRootId: null,
      createdAt: now,
      updatedAt: now,
      labelIds: [],
    };
    this.tasks.push(task);
    return { task: this.node(task, this.depthOf(task)) };
  }

  async renameTask(taskId: string, title: string): Promise<TaskRenameResponse> {
    this.calls.push({ method: "renameTask", detail: { taskId, title } });
    this.check("renameTask");
    const task = this.byId(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    task.title = title;
    task.version += 1;
    return { taskId: taskId as TaskId, title, version: task.version };
  }

  async moveTask(taskId: string, body: TaskMoveRequest): Promise<TaskMoveResponse> {
    this.calls.push({ method: "moveTask", detail: { taskId, body } });
    this.check("moveTask");
    const task = this.byId(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    const siblings = this.childrenOf(task.parentId, task.collection);
    const index = siblings.findIndex((candidate) => candidate.id === taskId);
    const previous = {
      collection: task.collection,
      parentId: (task.parentId ?? null) as TaskId | null,
      afterId: (index > 0 ? (siblings[index - 1]?.id ?? null) : null) as TaskId | null,
    };
    const neighbour = body.afterId ?? body.beforeId;
    const neighbourTask = neighbour ? this.byId(neighbour) : null;
    const parentId =
      body.parentId !== undefined
        ? body.parentId
        : neighbourTask
          ? neighbourTask.parentId
          : body.collection !== undefined
            ? null
            : task.parentId;
    const collection = neighbourTask?.collection ?? body.collection ?? task.collection;
    const moved = this.subtree(task);
    task.parentId = parentId ?? null;
    for (const member of moved) member.collection = collection;
    if (neighbourTask) {
      const target = neighbourTask.position;
      task.position = body.afterId ? target + 0.5 : target - 0.5;
    } else {
      task.position = this.nextPosition();
    }
    task.version += 1;
    return {
      taskId: taskId as TaskId,
      collection,
      parentId: (task.parentId ?? null) as TaskId | null,
      position: positionKey(Math.round(task.position)),
      movedTaskIds: moved.map((member) => member.id as TaskId),
      previous,
    };
  }

  async completeTask(taskId: string, body: TaskCompleteRequest): Promise<TaskCompleteResponse> {
    this.calls.push({ method: "completeTask", detail: { taskId, body } });
    this.check("completeTask");
    const task = this.byId(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    const children = this.childrenOf(task.id, task.collection);
    const archived: StoredTask[] = [task];
    const promoted: StoredTask[] = [];
    if (body.mode === "all") {
      archived.push(...this.subtree(task).slice(1));
    } else {
      // Decision WS6: the direct subtasks take the completed task's own top-level slot, in order.
      children.forEach((child, index) => {
        child.parentId = null;
        child.position = task.position + (index + 1) / 100;
        promoted.push(child);
      });
    }
    for (const member of archived) {
      member.status = "archived";
      member.archivedAt = now;
      member.archivedWithRootId = task.id;
    }
    return {
      taskId: taskId as TaskId,
      mode: children.length === 0 ? "single" : body.mode,
      archivedTaskIds: archived.map((member) => member.id as TaskId),
      promotedTaskIds: promoted.map((member) => member.id as TaskId),
      archivedAt: now,
    };
  }

  async restoreTask(taskId: string): Promise<TaskRestoreResponse> {
    this.calls.push({ method: "restoreTask", detail: taskId });
    this.check("restoreTask");
    const task = this.byId(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    const restored = this.tasks.filter(
      (candidate) => candidate.archivedWithRootId === task.id && candidate.status === "archived",
    );
    for (const member of restored) {
      member.status = "active";
      member.archivedAt = null;
      member.archivedWithRootId = null;
    }
    return {
      taskId: taskId as TaskId,
      restoredTaskIds: restored.map((member) => member.id as TaskId),
      collection: task.collection,
      parentId: (task.parentId ?? null) as TaskId | null,
      position: positionKey(Math.round(task.position)),
      fallback: "none",
    };
  }

  async listArchive(query: ArchiveQuery): Promise<ArchiveResponse> {
    this.calls.push({ method: "listArchive", detail: query });
    this.check("listArchive");
    const roots = this.tasks.filter(
      (task) => task.status === "archived" && task.archivedWithRootId === task.id,
    );
    const groups = new Map<string, ArchivedTaskNode[]>();
    for (const root of roots) {
      const members = this.tasks.filter(
        (task) => task.archivedWithRootId === root.id && task.status === "archived",
      );
      const titles = members.map((member) => member.title.toLowerCase());
      if (query.q && !titles.some((title) => title.includes(query.q?.toLowerCase() ?? ""))) {
        continue;
      }
      const date = new Date(root.archivedAt ?? now).toISOString().slice(0, 10);
      const list = groups.get(date) ?? [];
      list.push(
        ...members.map<ArchivedTaskNode>((member) => ({
          id: member.id as TaskId,
          parentId: (member.parentId ?? null) as TaskId | null,
          rootId: root.id as TaskId,
          collection: member.collection,
          depth: member.id === root.id ? 0 : 1,
          title: member.title,
          preview: member.preview,
          source: member.source,
          archivedAt: member.archivedAt ?? now,
          createdAt: member.createdAt,
        })),
      );
      groups.set(date, list);
    }
    return {
      taskTreeVersion: this.sequence,
      timeZone: query.timeZone ?? "UTC",
      groups: [...groups.entries()].map(([date, tasks]) => ({ date, tasks })),
      nextCursor: null,
    };
  }

  async getPreferences(): Promise<PreferencesResponse> {
    this.calls.push({ method: "getPreferences", detail: null });
    this.check("getPreferences");
    const groups = Object.fromEntries(
      preferenceGroups.map((group) => {
        const entry = this.preferences.get(group);
        return [group, { group, version: entry?.version ?? 0, data: entry?.data, updatedAt: now }];
      }),
    );
    return { groups } as PreferencesResponse;
  }

  async getPreference(group: PreferenceGroup): Promise<PreferenceEntry> {
    this.calls.push({ method: "getPreference", detail: group });
    const entry = this.preferences.get(group);
    return {
      group,
      version: entry?.version ?? 0,
      data: entry?.data,
      updatedAt: now,
    } as PreferenceEntry;
  }

  async putPreference(
    group: PreferenceGroup,
    body: { readonly baseVersion: number; readonly clientSeq: number; readonly data: unknown },
  ): Promise<PreferencesPutResponse> {
    this.calls.push({ method: "putPreference", detail: { group, body } });
    this.check("putPreference");
    const entry = this.preferences.get(group) ?? { version: 0, data: preferenceDefaults[group] };
    if (entry.version !== body.baseVersion) {
      throw new ApiError({
        status: 409,
        code: "preferences.conflict",
        message: "Saved somewhere else first",
        requestId: "req-test",
        details: {
          group,
          version: entry.version,
          data: entry.data,
          updatedAt: now,
          clientSeq: body.clientSeq,
        },
      });
    }
    const next = { version: entry.version + 1, data: body.data };
    this.preferences.set(group, next);
    return {
      group,
      version: next.version,
      data: next.data,
      updatedAt: now,
      clientSeq: body.clientSeq,
    };
  }
}

export interface RenderWorkspaceOptions {
  readonly api?: FakeWorkspaceApi;
  readonly userId?: string;
}

export interface RenderWorkspaceResult extends RenderResult {
  readonly api: FakeWorkspaceApi;
  readonly user: ReturnType<typeof userEvent.setup>;
}

/** Renders a workspace surface inside the providers the app gives it. */
export function renderWorkspace(
  node: ReactNode,
  options: RenderWorkspaceOptions = {},
): RenderWorkspaceResult {
  const api = options.api ?? new FakeWorkspaceApi();
  // `delay: null` types without a timer between keystrokes. These suites type whole sentences into
  // a tree that re-renders on every character, and the per-key timer alone put them over vitest's
  // timeout when the suite runs alongside the rest of the app.
  const user = userEvent.setup({ delay: null });
  const result = render(
    <StatusAnnouncerProvider>
      <ToastProvider>
        <ActionsProvider actions={actionRegistry} services={testActionServices()}>
          <WorkspaceProvider api={api} realtime={null} userId={options.userId ?? "user-1"}>
            {node}
          </WorkspaceProvider>
        </ActionsProvider>
      </ToastProvider>
    </StatusAnnouncerProvider>,
  );
  return { ...result, api, user };
}

/** The action services a mounted workspace needs; navigation is the test's `next/navigation` mock. */
function testActionServices(): ActionServices {
  return {
    navigate: () => undefined,
    assign: () => undefined,
    announce: () => undefined,
    route: null,
    shell: null,
  };
}

/**
 * The region-level failure on screen. It cannot be found with `findByRole("alert")`: the status
 * announcer keeps a permanently mounted assertive region, which that query matches first.
 */
export function findInlineError(): Promise<HTMLElement> {
  return waitFor(() => {
    const node = document.querySelector<HTMLElement>('[data-slot="inline-error"]');
    if (!node) throw new Error("no inline error yet");
    return node;
  });
}
