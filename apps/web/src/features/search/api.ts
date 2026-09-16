import {
  counterSchema,
  type SearchArchiveMode,
  type SearchCollection,
  type SearchContentType,
  type SearchDeadlineFilter,
  type SearchFreshness,
  type SearchResponse,
  type SearchTitleResponse,
  searchCollectionSchema,
  searchFreshnessResponseSchema,
  searchQueryMaxChars,
  searchResponseSchema,
  searchTitleResponseSchema,
  taskIdSchema,
} from "@symplist/contracts";
import { z } from "zod";
import {
  ApiAbortedError,
  type ApiClient,
  ApiError,
  ApiNetworkError,
  ApiProtocolError,
} from "@/lib/api";

/*
 * The search feature's browser calls (§10.1, note 14). Every call goes through the shared API client,
 * so cookies, CSRF rules and the error envelope are handled once, and every response is validated
 * against its contract before anything renders.
 */

/** Full search parameters as the screen holds them; turned into the `GET /v1/search` query string. */
export interface SearchContentRequest {
  readonly q: string;
  readonly collections: readonly SearchCollection[];
  readonly archive: SearchArchiveMode;
  readonly types: readonly SearchContentType[];
  readonly deadline: SearchDeadlineFilter | null;
  /** Expands one task's hits (up to 50 sections and messages). */
  readonly taskId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

/** A query the api accepts: trimmed, 1 to 200 characters (`searchQueryTextSchema`). */
export function normalizeQuery(value: string): string {
  return value.trim().slice(0, searchQueryMaxChars);
}

export function searchContentQuery(
  request: SearchContentRequest,
): Record<string, string | number | undefined> {
  const deadline = request.deadline;
  return {
    q: normalizeQuery(request.q),
    collections: request.collections.join(","),
    archive: request.archive,
    types: request.types.join(","),
    taskId: request.taskId,
    deadline: deadline?.kind,
    deadlineFrom: deadline?.kind === "range" ? deadline.from : undefined,
    deadlineTo: deadline?.kind === "range" ? deadline.to : undefined,
    timeZone:
      deadline && (deadline.kind === "due_today" || deadline.kind === "overdue")
        ? deadline.timeZone
        : deadline?.kind === "range"
          ? deadline.timeZone
          : undefined,
    cursor: request.cursor,
    limit: request.limit,
  };
}

/**
 * The workspace feature's `GET /v1/preferences/recent` entry, read with the fields the palette needs
 * (§10.3). Unknown fields are ignored so the palette keeps working as the entry gains fields.
 */
export const recentPreferenceEntrySchema = z.object({
  group: z.literal("recent"),
  version: counterSchema,
  data: z.object({ taskIds: z.array(taskIdSchema).max(20) }),
});

/** The workspace feature's `GET /v1/tasks/:id` response, read with the fields search needs (§2.1). */
export const taskLocationResponseSchema = z.object({
  task: z.object({
    id: taskIdSchema,
    parentId: taskIdSchema.nullable(),
    collection: searchCollectionSchema,
    status: z.enum(["active", "archived"]),
    title: z.string().max(4096),
  }),
  /** Root first; the last entry is the direct parent. */
  ancestors: z.array(z.object({ id: taskIdSchema, title: z.string().max(4096) })).max(64),
});

/** Where a task is now, for recent tasks and for resolving a result before opening it. */
export interface TaskLocation {
  readonly id: string;
  readonly title: string;
  readonly collection: SearchCollection;
  readonly archived: boolean;
  readonly parentTitle: string | null;
}

/** The most recent tasks the palette shows for an empty query. */
export const RECENT_TASKS_SHOWN = 5;

/** The browser path that opens a task (archived tasks open from the archive, note 14). */
export function taskHref(task: {
  readonly id: string;
  readonly collection: SearchCollection;
  readonly archived: boolean;
}): string {
  return task.archived ? `/archive/${task.id}` : `/${task.collection}/${task.id}`;
}

/** Query parameters a task page reads to jump to a search hit; values are opaque ids only. */
export const SEARCH_JUMP_PARAMS = Object.freeze({ section: "section", message: "message" });

export interface SearchApi {
  titles(
    q: string,
    options: { readonly archive?: SearchArchiveMode; readonly limit?: number },
    signal?: AbortSignal,
  ): Promise<SearchTitleResponse>;
  content(request: SearchContentRequest, signal?: AbortSignal): Promise<SearchResponse>;
  freshness(signal?: AbortSignal): Promise<SearchFreshness>;
  /** Recent task ids from preferences, resolved to their current place; unavailable tasks drop out. */
  recentTasks(signal?: AbortSignal): Promise<readonly TaskLocation[]>;
  /** The task's current place, or null when it no longer exists or is not the viewer's. */
  locateTask(taskId: string, signal?: AbortSignal): Promise<TaskLocation | null>;
}

function locationFrom(response: z.infer<typeof taskLocationResponseSchema>): TaskLocation {
  const parent = response.task.parentId === null ? undefined : response.ancestors.at(-1);
  return {
    id: response.task.id,
    title: response.task.title,
    collection: response.task.collection,
    archived: response.task.status === "archived",
    parentTitle: parent?.title ?? null,
  };
}

/** Builds the search calls over an API client. */
export function createSearchApi(client: ApiClient): SearchApi {
  const locateTask = async (taskId: string, signal?: AbortSignal) => {
    if (!taskIdSchema.safeParse(taskId).success) return null;
    try {
      const response = await client.get(`/v1/tasks/${taskId}`, {
        schema: taskLocationResponseSchema,
        ...(signal ? { signal } : {}),
      });
      return locationFrom(response);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  };
  return {
    titles: (q, options, signal) =>
      client.get("/v1/search/titles", {
        query: { q: normalizeQuery(q), archive: options.archive, limit: options.limit },
        schema: searchTitleResponseSchema,
        ...(signal ? { signal } : {}),
      }),
    content: (request, signal) =>
      client.get("/v1/search", {
        query: searchContentQuery(request),
        schema: searchResponseSchema,
        ...(signal ? { signal } : {}),
      }),
    freshness: (signal) =>
      client.get("/v1/search/freshness", {
        schema: searchFreshnessResponseSchema,
        ...(signal ? { signal } : {}),
      }),
    locateTask,
    recentTasks: async (signal) => {
      const entry = await client.get("/v1/preferences/recent", {
        schema: recentPreferenceEntrySchema,
        ...(signal ? { signal } : {}),
      });
      // A few extra ids cover recent tasks that were archived or removed since.
      const ids = entry.data.taskIds.slice(0, RECENT_TASKS_SHOWN + 3);
      const settled = await Promise.allSettled(ids.map((id) => locateTask(id, signal)));
      const found: TaskLocation[] = [];
      let failure: unknown = null;
      for (const outcome of settled) {
        if (outcome.status === "fulfilled") {
          // Archived and removed tasks never show as recent; archive stays an explicit choice.
          if (outcome.value && !outcome.value.archived) found.push(outcome.value);
        } else {
          failure ??= outcome.reason;
        }
      }
      if (failure !== null && found.length === 0) throw failure;
      return found.slice(0, RECENT_TASKS_SHOWN);
    },
  };
}

/**
 * Why a search could not show results, in the terms the UI explains (note 14: no matches and failure
 * are different; offline, unavailable and access states each say what to do next).
 */
export type SearchFailure =
  | { readonly kind: "offline" }
  | { readonly kind: "unavailable"; readonly retryAfterSeconds?: number }
  | { readonly kind: "signed_out" }
  | { readonly kind: "no_access" }
  | { readonly kind: "cursor_stale" }
  | { readonly kind: "filter_unavailable" }
  | { readonly kind: "invalid" };

/** Classifies an error; null for a cancelled request, which is never shown. */
export function classifySearchError(
  error: unknown,
  isOnline: () => boolean = () => typeof navigator === "undefined" || navigator.onLine !== false,
): SearchFailure | null {
  if (error instanceof ApiAbortedError) return null;
  if (error instanceof DOMException && error.name === "AbortError") return null;
  if (error instanceof ApiNetworkError)
    return isOnline() ? { kind: "unavailable" } : { kind: "offline" };
  if (error instanceof ApiError) {
    if (error.status === 401) return { kind: "signed_out" };
    if (error.status === 403) return { kind: "no_access" };
    if (error.code === "search.cursor_stale") return { kind: "cursor_stale" };
    if (error.code === "search.filter_unavailable") return { kind: "filter_unavailable" };
    if (error.status === 400 || error.status === 422) return { kind: "invalid" };
    return error.retryAfterSeconds === undefined
      ? { kind: "unavailable" }
      : { kind: "unavailable", retryAfterSeconds: error.retryAfterSeconds };
  }
  if (error instanceof ApiProtocolError) return { kind: "unavailable" };
  return isOnline() ? { kind: "unavailable" } : { kind: "offline" };
}
