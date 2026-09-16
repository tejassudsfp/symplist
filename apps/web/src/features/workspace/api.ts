import {
  type ArchiveQuery,
  type ArchiveResponse,
  archiveResponseSchema,
  type PreferenceEntry,
  type PreferenceGroup,
  type PreferencesPutResponse,
  type PreferencesResponse,
  preferenceEntrySchema,
  preferencesPutResponseSchema,
  preferencesResponseSchema,
  type TaskCollection,
  type TaskCompleteRequest,
  type TaskCompleteResponse,
  type TaskCreateRequest,
  type TaskCreateResponse,
  type TaskDetailResponse,
  type TaskMoveRequest,
  type TaskMoveResponse,
  type TaskRenameResponse,
  type TaskRestoreResponse,
  type TaskTreeResponse,
  taskCompleteResponseSchema,
  taskCreateResponseSchema,
  taskDetailResponseSchema,
  taskMoveResponseSchema,
  taskRenameResponseSchema,
  taskRestoreResponseSchema,
  taskTreeResponseSchema,
} from "@symplist/contracts";
import { type ApiClient, getApiClient } from "@/lib/api";

/**
 * The workspace's calls to the api (§2.1, §10.3), typed with the contracts schemas. Stores take this
 * interface, so component tests pass an in-memory fake and the app uses the browser client.
 * Mutations take the caller's idempotency key: a retry of the same intent reuses it (§6.1).
 */
export interface WorkspaceApi {
  /** One page of a collection's pre-order tree; pass the previous page's `nextCursor` for more. */
  listTasks(
    collection: TaskCollection,
    options?: { readonly cursor?: string; readonly signal?: AbortSignal },
  ): Promise<TaskTreeResponse>;
  getTask(taskId: string, signal?: AbortSignal): Promise<TaskDetailResponse>;
  createTask(body: TaskCreateRequest, idempotencyKey: string): Promise<TaskCreateResponse>;
  renameTask(taskId: string, title: string, idempotencyKey: string): Promise<TaskRenameResponse>;
  moveTask(
    taskId: string,
    body: TaskMoveRequest,
    idempotencyKey: string,
  ): Promise<TaskMoveResponse>;
  completeTask(
    taskId: string,
    body: TaskCompleteRequest,
    idempotencyKey: string,
  ): Promise<TaskCompleteResponse>;
  restoreTask(taskId: string, idempotencyKey: string): Promise<TaskRestoreResponse>;
  listArchive(query: ArchiveQuery, signal?: AbortSignal): Promise<ArchiveResponse>;
  getPreferences(signal?: AbortSignal): Promise<PreferencesResponse>;
  getPreference(group: PreferenceGroup, signal?: AbortSignal): Promise<PreferenceEntry>;
  putPreference(
    group: PreferenceGroup,
    body: { readonly baseVersion: number; readonly clientSeq: number; readonly data: unknown },
  ): Promise<PreferencesPutResponse>;
}

function taskPath(taskId: string, suffix = ""): string {
  return `/v1/tasks/${encodeURIComponent(taskId)}${suffix}`;
}

/** The workspace api over a browser client. */
export function createWorkspaceApi(client: () => ApiClient = getApiClient): WorkspaceApi {
  return {
    listTasks: (collection, options) =>
      client().get("/v1/tasks", {
        query: { collection, ...(options?.cursor ? { cursor: options.cursor } : {}) },
        schema: taskTreeResponseSchema,
        ...(options?.signal ? { signal: options.signal } : {}),
      }),
    getTask: (taskId, signal) =>
      client().get(taskPath(taskId), {
        schema: taskDetailResponseSchema,
        ...(signal ? { signal } : {}),
      }),
    createTask: (body, idempotencyKey) =>
      client().post("/v1/tasks", { body, idempotencyKey, schema: taskCreateResponseSchema }),
    renameTask: (taskId, title, idempotencyKey) =>
      client().patch(taskPath(taskId), {
        body: { title },
        idempotencyKey,
        schema: taskRenameResponseSchema,
      }),
    moveTask: (taskId, body, idempotencyKey) =>
      client().post(taskPath(taskId, "/move"), {
        body,
        idempotencyKey,
        schema: taskMoveResponseSchema,
      }),
    completeTask: (taskId, body, idempotencyKey) =>
      client().post(taskPath(taskId, "/complete"), {
        body,
        idempotencyKey,
        schema: taskCompleteResponseSchema,
      }),
    restoreTask: (taskId, idempotencyKey) =>
      client().post(taskPath(taskId, "/restore"), {
        idempotencyKey,
        schema: taskRestoreResponseSchema,
      }),
    listArchive: (query, signal) =>
      client().get("/v1/archive", {
        query: {
          ...(query.cursor ? { cursor: query.cursor } : {}),
          ...(query.limit !== undefined ? { limit: String(query.limit) } : {}),
          ...(query.q ? { q: query.q } : {}),
          ...(query.timeZone ? { timeZone: query.timeZone } : {}),
        },
        schema: archiveResponseSchema,
        ...(signal ? { signal } : {}),
      }),
    getPreferences: (signal) =>
      client().get("/v1/preferences", {
        schema: preferencesResponseSchema,
        ...(signal ? { signal } : {}),
      }),
    getPreference: (group, signal) =>
      client().get(`/v1/preferences/${group}`, {
        schema: preferenceEntrySchema,
        ...(signal ? { signal } : {}),
      }) as Promise<PreferenceEntry>,
    putPreference: (group, body) =>
      client().put(`/v1/preferences/${group}`, {
        body,
        schema: preferencesPutResponseSchema,
      }),
  };
}
