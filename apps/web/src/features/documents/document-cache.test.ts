import type { DocumentHeadResponse } from "@symplist/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cachedHead,
  cacheHead,
  clearDocumentCache,
  DOCUMENT_CACHE_LIMIT,
  DOCUMENT_CACHE_MAX_AGE_MS,
  documentCacheSize,
  forgetDocument,
} from "./document-cache.ts";

function head(revision: string, markdown = "# Page"): DocumentHeadResponse {
  return { revision, markdown } as DocumentHeadResponse;
}

const now = 1_758_000_000_000;

beforeEach(() => {
  clearDocumentCache();
});

describe("documentCache", () => {
  it("returns what was stored for a task", () => {
    cacheHead("a", head("r1"), now);
    expect(cachedHead("a", now)).toMatchObject({ revision: "r1" });
  });

  it("knows nothing about a task it has not seen", () => {
    expect(cachedHead("missing", now)).toBeUndefined();
  });

  it("keeps tasks apart", () => {
    cacheHead("a", head("r1", "alpha"), now);
    cacheHead("b", head("r2", "beta"), now);
    expect(cachedHead("a", now)?.markdown).toBe("alpha");
    expect(cachedHead("b", now)?.markdown).toBe("beta");
  });

  it("replaces an entry rather than growing a second one", () => {
    cacheHead("a", head("r1"), now);
    cacheHead("a", head("r2"), now);
    expect(documentCacheSize()).toBe(1);
    expect(cachedHead("a", now)?.revision).toBe("r2");
  });

  it("stops offering an entry once it is too old to trust", () => {
    cacheHead("a", head("r1"), now);
    expect(cachedHead("a", now + DOCUMENT_CACHE_MAX_AGE_MS + 1)).toBeUndefined();
    expect(documentCacheSize()).toBe(0);
  });

  it("still offers an entry inside its window", () => {
    cacheHead("a", head("r1"), now);
    expect(cachedHead("a", now + DOCUMENT_CACHE_MAX_AGE_MS - 1)).toBeDefined();
  });

  it("drops the least recently used task past the limit", () => {
    for (let index = 0; index <= DOCUMENT_CACHE_LIMIT; index += 1) {
      cacheHead(`task-${index}`, head(`r${index}`), now);
    }
    expect(documentCacheSize()).toBe(DOCUMENT_CACHE_LIMIT);
    expect(cachedHead("task-0", now)).toBeUndefined();
    expect(cachedHead(`task-${DOCUMENT_CACHE_LIMIT}`, now)).toBeDefined();
  });

  it("counts a read as use, so the task being worked on is not the one evicted", () => {
    for (let index = 0; index < DOCUMENT_CACHE_LIMIT; index += 1) {
      cacheHead(`task-${index}`, head(`r${index}`), now);
    }
    // Touch the oldest, then overflow by one: the next oldest goes instead.
    expect(cachedHead("task-0", now)).toBeDefined();
    cacheHead("extra", head("rx"), now);
    expect(cachedHead("task-0", now)).toBeDefined();
    expect(cachedHead("task-1", now)).toBeUndefined();
  });

  it("forgets one task without touching the others", () => {
    cacheHead("a", head("r1"), now);
    cacheHead("b", head("r2"), now);
    forgetDocument("a");
    expect(cachedHead("a", now)).toBeUndefined();
    expect(cachedHead("b", now)).toBeDefined();
  });

  it("clears everything, because content must not cross accounts", () => {
    cacheHead("a", head("r1"), now);
    cacheHead("b", head("r2"), now);
    clearDocumentCache();
    expect(documentCacheSize()).toBe(0);
    expect(cachedHead("a", now)).toBeUndefined();
  });
});
