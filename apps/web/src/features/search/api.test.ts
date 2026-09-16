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

  it("reads recent tasks from preferences and drops ones that are gone or archived", async () => {
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
      const id = url.pathname.split("/").at(-1) as string;
      if (id === ids[3]) return errorBody("not_found", 404);
      const archived = id === ids[2];
      return {
        body: {
          task: {
            id,
            parentId: id === ids[1] ? ids[0] : null,
            collection: "now",
            status: archived ? "archived" : "active",
            title: archived ? "Choose portfolio photos" : "Refresh my portfolio",
            version: 3,
          },
          ancestors: id === ids[1] ? [{ id: ids[0], title: "Refresh my portfolio" }] : [],
        },
      };
    });
    const recent = await api.recentTasks();
    expect(recent.map((task) => task.id)).toEqual([ids[0], ids[1]]);
    expect(recent[1]?.parentTitle).toBe("Refresh my portfolio");
    expect(calls).toHaveLength(5);
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
