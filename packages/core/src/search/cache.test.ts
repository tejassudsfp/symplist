import { SearchIndex, SearchView } from "@symplist/search";
import { describe, expect, it } from "vitest";
import { DEFAULT_SEARCH_CACHE_BYTES, SearchIndexCache } from "./cache.ts";
import { decodeSearchCursor, encodeSearchCursor } from "./cursor.ts";

const owners = [
  "0192f0a0-0000-7000-8000-0000000000a1",
  "0192f0a0-0000-7000-8000-0000000000a2",
  "0192f0a0-0000-7000-8000-0000000000a3",
];

function index(ownerId: string): SearchIndex {
  return SearchIndex.create({ ownerId, includeChat: false });
}

describe("SearchIndexCache (§3.3, §10.1)", () => {
  it("defaults to a 128 MB bound", () => {
    expect(DEFAULT_SEARCH_CACHE_BYTES).toBe(128 * 1024 * 1024);
    expect(new SearchIndexCache({ now: () => 0 }).stats().maxBytes).toBe(
      DEFAULT_SEARCH_CACHE_BYTES,
    );
  });

  it("serves an owner's generation only under the access generation it was loaded with", () => {
    const cache = new SearchIndexCache({ now: () => 0 });
    const base = index(owners[0] as string);
    cache.setBase(owners[0] as string, { accessGeneration: 3, generation: 7, base, bytes: 100 });
    expect(cache.base(owners[0] as string, 7, 3)?.base).toBe(base);
    expect(cache.base(owners[0] as string, 8, 3)).toBeUndefined();
    expect(cache.base(owners[0] as string, 7, 4)).toBeUndefined();
    expect(cache.has(owners[0] as string)).toBe(false);
    expect(cache.stats()).toMatchObject({ bytes: 0, evictions: 1 });
  });

  it("evicts least recently used owners to stay within the byte bound", () => {
    let now = 0;
    const cache = new SearchIndexCache({ now: () => now, maxBytes: 250 });
    for (const owner of owners) {
      now += 1;
      cache.setBase(owner, { accessGeneration: 0, generation: 1, base: index(owner), bytes: 100 });
      if (owner === owners[1]) {
        now += 1;
        cache.base(owners[0] as string, 1, 0);
      }
    }
    expect(cache.has(owners[0] as string)).toBe(true);
    expect(cache.has(owners[1] as string)).toBe(false);
    expect(cache.has(owners[2] as string)).toBe(true);
    expect(cache.stats().bytes).toBe(200);
  });

  it("counts overlay views and keeps at most two per owner", () => {
    const cache = new SearchIndexCache({ now: () => 0, maxBytes: 1_000 });
    const owner = owners[0] as string;
    const base = index(owner);
    cache.setBase(owner, { accessGeneration: 0, generation: 1, base, bytes: 100 });
    for (const key of ["1:1", "1:2", "1:3"]) {
      cache.setView(owner, key, { view: SearchView.of(base), complete: true, bytes: 50 });
    }
    expect(cache.view(owner, "1:1")).toBeUndefined();
    expect(cache.view(owner, "1:3")?.complete).toBe(true);
    expect(cache.stats().bytes).toBe(200);
    cache.setBase(owner, { accessGeneration: 0, generation: 2, base, bytes: 100 });
    expect(cache.view(owner, "1:3")).toBeUndefined();
    expect(cache.stats().bytes).toBe(100);
  });

  it("does not hold an index larger than the whole bound", () => {
    const logged: string[] = [];
    const cache = new SearchIndexCache({
      now: () => 0,
      maxBytes: 50,
      log: { info: () => undefined, warn: (event) => logged.push(event), error: () => undefined },
    });
    const owner = owners[0] as string;
    expect(
      cache.setBase(owner, { accessGeneration: 0, generation: 1, base: index(owner), bytes: 60 }),
    ).toBe(false);
    expect(cache.has(owner)).toBe(false);
    expect(logged).toEqual(["search.cache_entry_too_large"]);
  });

  it("drops idle owners and everything on explicit eviction", () => {
    let now = 0;
    const cache = new SearchIndexCache({ now: () => now, idleMs: 100 });
    cache.setBase(owners[0] as string, {
      accessGeneration: 0,
      generation: 1,
      base: null,
      bytes: 0,
    });
    cache.setBase(owners[1] as string, {
      accessGeneration: 0,
      generation: 1,
      base: null,
      bytes: 0,
    });
    now = 50;
    cache.base(owners[1] as string, 1, 0);
    now = 120;
    expect(cache.evictIdle()).toBe(1);
    expect(cache.has(owners[1] as string)).toBe(true);
    expect(cache.evictOwner(owners[1] as string, "restricted")).toBe(true);
    expect(cache.evictOwner(owners[1] as string, "restricted")).toBe(false);
  });
});

describe("search cursors", () => {
  it("round-trips and rejects anything else", () => {
    const cursor = {
      generation: 4,
      pendingThrough: 19,
      offset: 20,
      digest: "abcdefghijklmnopqrstuv",
    };
    expect(decodeSearchCursor(encodeSearchCursor(cursor))).toEqual(cursor);
    for (const bad of [
      "",
      "!!!",
      Buffer.from('[2,1,1,1,"abcdefghijklmnopqrstuv"]').toString("base64url"),
      Buffer.from('[1,1,1,0,"abcdefghijklmnopqrstuv"]').toString("base64url"),
      Buffer.from('[1,-1,1,1,"abcdefghijklmnopqrstuv"]').toString("base64url"),
      Buffer.from('{"g":1}').toString("base64url"),
    ]) {
      expect(() => decodeSearchCursor(bad)).toThrow(
        expect.objectContaining({ code: "search.cursor_invalid" }),
      );
    }
  });
});
