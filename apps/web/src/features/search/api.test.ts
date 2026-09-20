import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, ApiNetworkError } from "@/lib/api";
import {
  classifySearchError,
  createSearchApi,
  normalizeQuery,
  searchContentQuery,
  taskHref,
} from "./api.ts";
import { resultGroup, searchResponse, titleResponse, titleResult } from "./test-support.tsx";

const origin = "https://api.example";

interface Call {
  readonly url: URL;
  readonly init: RequestInit;
}

function clientWith(
  handler: (
    call: Call,
  ) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>,
) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push({ url, init });
    const { status = 200, body } = await handler({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const client = new ApiClient({ baseUrl: origin, fetch: fetchImpl, isBrowser: () => true });
  return { api: createSearchApi(client), calls };
}

function errorBody(code: string, status: number) {
  return { status, body: { error: { code, message: "no", requestId: "r1" } } };
}

describe("the search API calls", () => {
  it("sends the full search scope as the contract's query string", () => {
    expect(
      searchContentQuery({
        q: "  portfolio  ",
        collections: ["now", "later"],
        archive: "include",
        types: ["tasks", "documents", "chat"],
        deadline: { kind: "range", from: "2026-03-01", to: "2026-03-05", timeZone: "UTC" },
        cursor: "abc",
        limit: 20,
      }),
    ).toEqual({
      q: "portfolio",
      collections: "now,later",
      archive: "include",
      types: "tasks,documents,chat",
      taskId: undefined,
      deadline: "range",
      deadlineFrom: "2026-03-01",
      deadlineTo: "2026-03-05",
      timeZone: "UTC",
      cursor: "abc",
      limit: 20,
    });
    expect(
      searchContentQuery({
        q: "x",
        collections: ["now"],
        archive: "exclude",
        types: ["tasks"],
        deadline: { kind: "has" },
      }).timeZone,
    ).toBeUndefined();
    expect(normalizeQuery(` ${"a".repeat(260)} `)).toHaveLength(200);
  });

  it("calls the title endpoint with cookies and validates the response", async () => {
    const { api, calls } = clientWith(() => ({
      body: titleResponse([titleResult("Refresh my portfolio")]),
    }));
    const response = await api.titles("portf", { limit: 8 });
    expect(response.items[0]?.task.title).toBe("Refresh my portfolio");
    expect(calls[0]?.url.toString()).toBe(`${origin}/v1/search/titles?q=portf&limit=8`);
    expect(calls[0]?.init.credentials).toBe("include");
    expect(calls[0]?.init.redirect).toBe("error");
  });

  it("refuses a response that does not match its contract", async () => {
    const { api } = clientWith(() => ({ body: { status: "ready", items: [] } }));
    await expect(
      api.content({
        q: "x",
        collections: ["now"],
        archive: "exclude",
        types: ["tasks"],
        deadline: null,
      }),
    ).rejects.toMatchObject({ kind: "protocol" });
  });

  it("places recent tasks from one tree page and drops ones that are gone or archived", async () => {
    const ids = [
      "0192f0a0-0000-7000-8000-000000000101",
      "0192f0a0-0000-7000-8000-000000000102",
      "0192f0a0-0000-7000-8000-000000000401",
      "0192f0a0-0000-7000-8000-000000000999",
    ];
    const { api, calls } = clientWith(({ url }) => {
      if (url.pathname === "/v1/preferences/recent") {
        return { body: { group: "recent", version: 4, data: { taskIds: ids }, updatedAt: 1 } };
      }
      // The tree holds active tasks only: the archived id (401) and the removed one (999) are
      // simply not in it, which is how they drop out.
      return {
        body: {
          collection: url.searchParams.get("collection"),
          taskTreeVersion: 7,
          tasks: [
            {
              id: ids[0],
              parentId: null,
              collection: "now",
              position: "a0",
              depth: 0,
              title: "Refresh my portfolio",
              preview: null,
              source: "user",
              version: 3,
              childCount: 1,
              createdAt: 1,
              updatedAt: 2,
            },
            {
              id: ids[1],
              parentId: ids[0],
              collection: "now",
              position: "a1",
              depth: 1,
              title: "Choose portfolio photos",
              preview: null,
              source: "user",
              version: 3,
              childCount: 0,
              createdAt: 1,
              updatedAt: 2,
            },
          ],
          nextCursor: null,
        },
      };
    });
    const recent = await api.recentTasks();
    expect(recent.map((task) => task.id)).toEqual([ids[0], ids[1]]);
    expect(recent[1]?.parentTitle).toBe("Refresh my portfolio");
    // One preferences read and one tree page, not one request per recent id (§3.1).
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/v1/preferences/recent",
      "/v1/tasks",
      "/v1/tasks",
      "/v1/tasks",
    ]);
    expect(calls[1]?.url.searchParams.get("collection")).toBe("now");
  });

  it("stops walking the tree the moment every recent id is placed", async () => {
    const id = "0192f0a0-0000-7000-8000-000000000101";
    const { api, calls } = clientWith(({ url }) => {
      if (url.pathname === "/v1/preferences/recent") {
        return { body: { group: "recent", version: 4, data: { taskIds: [id] }, updatedAt: 1 } };
      }
      return {
        body: {
          collection: url.searchParams.get("collection"),
          taskTreeVersion: 7,
          tasks: [
            {
              id,
              parentId: null,
              collection: "now",
              position: "a0",
              depth: 0,
              title: "Refresh my portfolio",
              preview: null,
              source: "user",
              version: 3,
              childCount: 0,
              createdAt: 1,
              updatedAt: 2,
            },
          ],
          nextCursor: null,
        },
      };
    });
    await expect(api.recentTasks()).resolves.toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("reads no tree at all when the account has no recent tasks", async () => {
    const { api, calls } = clientWith(() => ({
      body: { group: "recent", version: 4, data: { taskIds: [] }, updatedAt: 1 },
    }));
    await expect(api.recentTasks()).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("keeps the tasks one collection placed when another collection fails", async () => {
    const ids = ["0192f0a0-0000-7000-8000-000000000101", "0192f0a0-0000-7000-8000-000000000201"];
    const { api } = clientWith(({ url }) => {
      if (url.pathname === "/v1/preferences/recent") {
        return { body: { group: "recent", version: 4, data: { taskIds: ids }, updatedAt: 1 } };
      }
      if (url.searchParams.get("collection") !== "now") return errorBody("rate.limited", 503);
      return {
        body: {
          collection: "now",
          taskTreeVersion: 7,
          tasks: [
            {
              id: ids[0],
              parentId: null,
              collection: "now",
              position: "a0",
              depth: 0,
              title: "Refresh my portfolio",
              preview: null,
              source: "user",
              version: 3,
              childCount: 0,
              createdAt: 1,
              updatedAt: 2,
            },
          ],
          nextCursor: null,
        },
      };
    });
    await expect(api.recentTasks()).resolves.toMatchObject([{ id: ids[0] }]);
  });

  it("raises the failure when no collection could be read at all", async () => {
    const { api } = clientWith(({ url }) =>
      url.pathname === "/v1/preferences/recent"
        ? {
            body: {
              group: "recent",
              version: 4,
              data: { taskIds: ["0192f0a0-0000-7000-8000-000000000101"] },
              updatedAt: 1,
            },
          }
        : errorBody("rate.limited", 503),
    );
    await expect(api.recentTasks()).rejects.toBeInstanceOf(ApiError);
  });

  it("reports a task that is gone as null and keeps other failures", async () => {
    const { api } = clientWith(({ url }) =>
      url.pathname.endsWith("101") ? errorBody("not_found", 404) : errorBody("rate.limited", 503),
    );
    await expect(api.locateTask("0192f0a0-0000-7000-8000-000000000101")).resolves.toBeNull();
    await expect(api.locateTask("0192f0a0-0000-7000-8000-000000000102")).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(api.locateTask("not-an-id")).resolves.toBeNull();
  });

  it("opens active tasks in their collection and archived ones in the archive", () => {
    expect(taskHref({ id: "t1", collection: "later", archived: false })).toBe("/later/t1");
    expect(taskHref({ id: "t1", collection: "later", archived: true })).toBe("/archive/t1");
  });

  it("returns a page of grouped results", async () => {
    const { api, calls } = clientWith(() => ({
      body: searchResponse([resultGroup("Refresh my portfolio")], { nextCursor: "c2" }),
    }));
    const response = await api.content({
      q: "portfolio",
      collections: ["now"],
      archive: "exclude",
      types: ["tasks", "documents"],
      deadline: null,
      limit: 20,
    });
    expect(response.nextCursor).toBe("c2");
    expect(calls[0]?.url.searchParams.get("types")).toBe("tasks,documents");
  });
});

describe("classifying search failures", () => {
  const online = () => true;
  const offline = () => false;

  it("tells offline, unavailable, access and filter failures apart", () => {
    expect(classifySearchError(new ApiNetworkError(), offline)).toEqual({ kind: "offline" });
    expect(classifySearchError(new ApiNetworkError(), online)).toEqual({ kind: "unavailable" });
    const api = (code: string, status: number, retryAfterSeconds?: number) =>
      new ApiError({
        status,
        code,
        message: "",
        requestId: "r",
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      });
    expect(classifySearchError(api("auth.session_required", 401), online)).toEqual({
      kind: "signed_out",
    });
    expect(classifySearchError(api("access.locked", 403), online)).toEqual({ kind: "no_access" });
    expect(classifySearchError(api("search.cursor_stale", 409), online)).toEqual({
      kind: "cursor_stale",
    });
    expect(classifySearchError(api("search.filter_unavailable", 422), online)).toEqual({
      kind: "filter_unavailable",
    });
    expect(classifySearchError(api("search.cursor_invalid", 400), online)).toEqual({
      kind: "invalid",
    });
    expect(classifySearchError(api("rate.limited", 503, 12), online)).toEqual({
      kind: "unavailable",
      retryAfterSeconds: 12,
    });
  });

  it("never reports a cancelled request as a failure", () => {
    expect(classifySearchError(new DOMException("aborted", "AbortError"), online)).toBeNull();
  });

  it("classifies unknown errors without leaking them", () => {
    const spy = vi.fn();
    expect(classifySearchError(new Error("boom"), online)).toEqual({ kind: "unavailable" });
    expect(spy).not.toHaveBeenCalled();
  });
});
