import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { int, sql, uuidv7 } from "@symplist/db";
import { searchIndexObjectPrefix } from "@symplist/search";
import type { ObjectStore } from "@symplist/storage";
import { StorageError } from "@symplist/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchIndexCache } from "./cache.ts";
import { decodeSearchCursor, encodeSearchCursor } from "./cursor.ts";
import { SearchServiceError } from "./errors.ts";
import {
  createSearchTestStore,
  insertOwner,
  recordIntent,
  type SearchTestStore,
  writeTask,
} from "./harness.test-support.ts";
import type { SearchLog } from "./log.ts";
import {
  type SearchPrincipal,
  SearchQueryService,
  type SearchQueryServiceOptions,
} from "./service.ts";
import { SearchIndexWriter } from "./writer.ts";

let store: SearchTestStore;
let owner: string;
let principal: SearchPrincipal;
const logged: string[] = [];
const log: SearchLog = {
  info: (event, fields) => logged.push(JSON.stringify({ event, ...fields })),
  warn: (event, fields) => logged.push(JSON.stringify({ event, ...fields })),
  error: (event, fields) => logged.push(JSON.stringify({ event, ...fields })),
};

function service(overrides: Partial<SearchQueryServiceOptions> = {}): SearchQueryService {
  return new SearchQueryService({
    db: store.db,
    objects: store.objects,
    keys: store.keys,
    sources: store.sources,
    cache: new SearchIndexCache({ now: () => store.now, log }),
    now: () => store.now,
    log,
    tuning: { stateTtlMs: 0 },
    ...overrides,
  });
}

async function publish(ownerId = owner) {
  const outcome = await new SearchIndexWriter({
    db: store.db,
    objects: store.objects,
    keys: store.keys,
    sources: store.sources,
    now: () => store.now,
  }).run(ownerId, { mode: "local" });
  if (outcome.status !== "published")
    throw new Error(`expected a publication, got ${outcome.status}`);
  return outcome;
}

async function titles(search: SearchQueryService, q: string, extra: object = {}, who = principal) {
  const { response } = await search.search(who, { q, ...extra });
  return response.items.map((item) => item.task.title);
}

beforeEach(async () => {
  store = await createSearchTestStore();
  owner = await insertOwner(store, "maya@example.test");
  principal = { userId: owner, accessGeneration: 0 };
  logged.length = 0;
});

afterEach(() => {
  store.close();
});

describe("SearchQueryService freshness and statuses (§10.1)", () => {
  it("serves task titles while rebuilding and asks for a rebuild", async () => {
    const task = await writeTask(store, owner, { title: "Send the project outline" });
    store.documents.publishMarkdown(owner, task, "## Notes\ncommunity garden", "rev1");
    const search = service();
    const { response, indexing } = await search.search(principal, { q: "outline" });
    expect(response).toMatchObject({ status: "rebuilding", indexGeneration: 0, pendingIntents: 1 });
    expect(response.items.map((item) => item.task.title)).toEqual(["Send the project outline"]);
    expect(response.notices).toContain("changes_pending");
    expect(indexing).toBe("rebuild");
    // Document text is not searched until the index exists.
    expect((await search.search(principal, { q: "garden" })).response.items).toEqual([]);
    expect((await search.freshness(principal)).response).toEqual({
      status: "rebuilding",
      indexGeneration: 0,
      pendingIntents: 1,
    });
  });

  it("is ready once a generation is published, with documents and freshness", async () => {
    const task = await writeTask(store, owner, { title: "Send the project outline" });
    store.documents.publishMarkdown(owner, task, "## Notes\ncommunity garden budget", "rev1");
    await recordIntent(store, owner, "document", task);
    await publish();
    const search = service();
    const { response, indexing } = await search.search(principal, { q: "garden" });
    expect(response).toMatchObject({
      status: "ready",
      indexGeneration: 1,
      pendingIntents: 0,
      notices: [],
    });
    expect(indexing).toBeNull();
    const [group] = response.items;
    expect(group?.match).toBe("body");
    expect(group?.sections[0]).toMatchObject({
      heading: "Notes",
      match: "body",
      indexedRevision: "rev1",
      currentRevision: "rev1",
      stale: false,
    });
    expect(group?.sections[0]?.snippet.text).toBe("community garden budget");
    expect(group?.sections[0]?.snippet.highlights).toEqual([{ start: 10, end: 16 }]);
    expect((await search.freshness(principal)).response).toEqual({
      status: "ready",
      indexGeneration: 1,
      pendingIntents: 0,
    });
  });

  it("overlays committed changes that are not published yet", async () => {
    const task = await writeTask(store, owner, { title: "Draft invoice" });
    await publish();
    const search = service();
    expect(await titles(search, "invoice")).toEqual(["Draft invoice"]);

    await writeTask(store, owner, { id: task, title: "Send receipt", version: 2 });
    await writeTask(store, owner, { title: "Brand new task" });
    const { response } = await search.search(principal, { q: "receipt" });
    expect(response).toMatchObject({ status: "ready", indexGeneration: 1, pendingIntents: 2 });
    expect(response.items.map((item) => [item.task.title, item.titleStale])).toEqual([
      ["Send receipt", false],
    ]);
    expect(await titles(search, "invoice")).toEqual([]);
    expect(await titles(search, "brand")).toEqual(["Brand new task"]);
  });

  it("reports partial results when pending changes exceed the overlay bound", async () => {
    await writeTask(store, owner, { title: "Seed" });
    await publish();
    for (let index = 0; index < 4; index += 1)
      await writeTask(store, owner, { title: `Extra ${index}` });
    const search = service({ tuning: { stateTtlMs: 0, maxOverlayIntents: 2 } });
    const { response } = await search.search(principal, { q: "extra" });
    expect(response.status).toBe("partial");
    expect(response.notices).toContain("changes_pending");
    expect(response.items).toHaveLength(2);
    expect((await search.freshness(principal)).response.status).toBe("partial");
  });

  it("asks for the writer again when intents wait too long", async () => {
    await writeTask(store, owner, { title: "Seed" });
    await publish();
    await writeTask(store, owner, { title: "Waiting" });
    const search = service({ tuning: { stateTtlMs: 0, staleIntentMs: 1_000 } });
    expect((await search.search(principal, { q: "waiting" })).indexing).toBeNull();
    store.now += 5_000;
    expect((await search.search(principal, { q: "waiting" })).indexing).toBe("stale");
  });

  it("serves title fallback results and a rebuild when the published object is unreadable", async () => {
    await writeTask(store, owner, { title: "Readable title" });
    const published = await publish();
    const row = await store.db.first(
      sql(`SELECT object_key FROM search_indexes WHERE owner_id = :owner`, { owner }),
    );
    await store.objects.delete(String(row?.object_key));
    await store.objects.put({ key: String(row?.object_key), body: new Uint8Array(64) });
    const getSpy = vi.spyOn(store.objects, "get");
    const search = service();
    const { response, indexing } = await search.search(principal, { q: "readable" });
    expect(response.status).toBe("rebuilding");
    expect(response.indexGeneration).toBe(published.generation);
    expect(response.items.map((item) => item.task.title)).toEqual(["Readable title"]);
    expect(indexing).toBe("rebuild");
    await search.search(principal, { q: "readable" });
    // An unreadable generation is not downloaded on every keystroke.
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it("answers search.unavailable when the index cannot be downloaded", async () => {
    await writeTask(store, owner, { title: "Seed" });
    await publish();
    const broken: ObjectStore = {
      put: (input) => store.objects.put(input),
      head: (key) => store.objects.head(key),
      delete: (key) => store.objects.delete(key),
      list: (input) => store.objects.list(input),
      get: async () => {
        throw new StorageError("storage.unavailable", "down");
      },
    };
    await expect(
      service({ objects: broken }).search(principal, { q: "seed" }),
    ).rejects.toMatchObject({
      code: "search.unavailable",
    });
  });
});

describe("re-authorization when rendering (§10.1)", () => {
  it("re-reads tasks so archived, moved or deleted tasks never leak from the index", async () => {
    const archived = await writeTask(store, owner, { title: "Pottery class" });
    const moved = await writeTask(store, owner, { title: "Pottery wheel" });
    const deleted = await writeTask(store, owner, { title: "Pottery glaze" });
    await publish();
    // Changes without intents (a bug or a lost intent) are still caught by the fresh read.
    await writeTask(
      store,
      owner,
      { id: archived, title: "Pottery class", archived: true },
      { intent: false },
    );
    await writeTask(
      store,
      owner,
      { id: moved, title: "Pottery wheel", collection: "later" },
      { intent: false },
    );
    await store.db.run(sql(`DELETE FROM tasks WHERE id = :id`, { id: deleted }));
    const search = service();
    expect(await titles(search, "pottery", { collections: ["now"] })).toEqual([]);
    expect(await titles(search, "pottery")).toEqual(["Pottery wheel"]);
    expect(await titles(search, "pottery", { archive: "include" })).toEqual(
      expect.arrayContaining(["Pottery class", "Pottery wheel"]),
    );
  });

  it("reports titles and document revisions that changed since indexing", async () => {
    const task = await writeTask(store, owner, { title: "Trip plan" });
    store.documents.publishMarkdown(owner, task, "## Hotel\nlakeside inn", "rev1");
    await recordIntent(store, owner, "document", task);
    await publish();
    store.documents.publishMarkdown(owner, task, "## Hotel\nmountain lodge", "rev2");
    await writeTask(
      store,
      owner,
      { id: task, title: "Trip itinerary", version: 2 },
      { intent: false },
    );
    const { response } = await service().search(principal, { q: "lakeside" });
    expect(response.items[0]).toMatchObject({
      task: { title: "Trip itinerary" },
      titleStale: true,
      sections: [{ indexedRevision: "rev1", currentRevision: "rev2", stale: true }],
    });
  });

  it("shows the parent breadcrumb and highlights the current title", async () => {
    const parent = await writeTask(store, owner, { title: "Refresh my portfolio" });
    await writeTask(store, owner, { title: "Pick five projects", parentId: parent });
    await publish();
    const { response } = await service().search(principal, { q: "pick" });
    expect(response.items[0]?.task).toMatchObject({
      title: "Pick five projects",
      titleHighlights: [{ start: 0, end: 4 }],
      parent: { id: parent, title: "Refresh my portfolio" },
    });
  });

  it("keeps two owners apart even with identical words and a shared cache", async () => {
    const other = await insertOwner(store, "other@example.test");
    await writeTask(store, owner, { title: "Maya invoice" });
    await writeTask(store, other, { title: "Other invoice" });
    await publish(owner);
    await publish(other);
    const cache = new SearchIndexCache({ now: () => store.now });
    const search = service({ cache });
    expect(await titles(search, "invoice")).toEqual(["Maya invoice"]);
    expect(await titles(search, "invoice", {}, { userId: other, accessGeneration: 0 })).toEqual([
      "Other invoice",
    ]);
    expect(cache.stats().owners).toBe(2);
  });

  it("restricts a task-scoped caller to its tasks", async () => {
    const visible = await writeTask(store, owner, { title: "Scoped invoice" });
    await writeTask(store, owner, { title: "Hidden invoice" });
    await publish();
    expect(
      await titles(
        service(),
        "invoice",
        {},
        { userId: owner, accessGeneration: 0, taskScope: new Set([visible]) },
      ),
    ).toEqual(["Scoped invoice"]);
  });
});

describe("pagination and cursors (§10.1)", () => {
  async function seed(count: number) {
    for (let index = 0; index < count; index += 1) {
      await writeTask(store, owner, {
        title: `Weekly review ${index}`,
        updatedAt: store.now + index,
      });
    }
    await publish();
  }

  it("pages through stable results without repeats", async () => {
    await seed(12);
    const search = service();
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const { response } = await search.search(principal, {
        q: "weekly",
        limit: 5,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...response.items.map((item) => item.task.id));
      cursor = response.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(12);
  });

  it("refuses a cursor after the index generation it pinned is gone", async () => {
    await seed(6);
    const search = service();
    const first = await search.search(principal, { q: "weekly", limit: 2 });
    await writeTask(store, owner, { title: "Weekly review extra" });
    await publish();
    await expect(
      search.search(principal, { q: "weekly", limit: 2, cursor: first.response.nextCursor ?? "" }),
    ).rejects.toMatchObject({ code: "search.cursor_stale", details: { indexGeneration: 2 } });
  });

  it("keeps serving a pinned view when only pending changes moved on", async () => {
    await seed(6);
    const search = service();
    const first = await search.search(principal, { q: "weekly", limit: 3 });
    await writeTask(store, owner, { title: "Weekly review pending" });
    const second = await search.search(principal, {
      q: "weekly",
      limit: 3,
      cursor: first.response.nextCursor ?? "",
    });
    const ids = [...first.response.items, ...second.response.items].map((item) => item.task.id);
    expect(new Set(ids).size).toBe(6);
  });

  it("rejects malformed cursors and cursors of another query or scope", async () => {
    await seed(4);
    const search = service();
    const first = await search.search(principal, { q: "weekly", limit: 2 });
    const cursor = first.response.nextCursor ?? "";
    expect(decodeSearchCursor(cursor)).toMatchObject({ generation: 1, offset: 2 });
    await expect(search.search(principal, { q: "review", limit: 2, cursor })).rejects.toMatchObject(
      {
        code: "search.cursor_invalid",
      },
    );
    await expect(
      search.search(principal, { q: "weekly", limit: 2, cursor, archive: "include" }),
    ).rejects.toMatchObject({ code: "search.cursor_invalid" });
    await expect(
      search.search(principal, { q: "weekly", cursor: "not-a-cursor" }),
    ).rejects.toBeInstanceOf(SearchServiceError);
    const forged = encodeSearchCursor({
      generation: 1,
      pendingThrough: 0,
      offset: 0,
      digest: "x".repeat(22),
    });
    await expect(search.search(principal, { q: "weekly", cursor: forged })).rejects.toMatchObject({
      code: "search.cursor_invalid",
    });
  });
});

describe("cache eviction (§3.3, §5.5)", () => {
  it("evicts an owner on restriction and deletion, and reloads after an access change", async () => {
    await writeTask(store, owner, { title: "Cached task" });
    await publish();
    const cache = new SearchIndexCache({ now: () => store.now });
    const search = service({ cache });
    const getSpy = vi.spyOn(store.objects, "get");
    await search.search(principal, { q: "cached" });
    await search.search(principal, { q: "cached" });
    expect(getSpy).toHaveBeenCalledTimes(1);

    search.evictOwner(owner, "restricted");
    expect(cache.has(owner)).toBe(false);
    await search.search(principal, { q: "cached" });
    expect(getSpy).toHaveBeenCalledTimes(2);

    await search.search({ userId: owner, accessGeneration: 2 }, { q: "cached" });
    expect(getSpy).toHaveBeenCalledTimes(3);
    expect(cache.stats().evictions).toBeGreaterThanOrEqual(2);

    search.evictOwner(owner, "deleted");
    expect(cache.has(owner)).toBe(false);
  });

  it("bounds decrypted bytes across owners, evicting the least recently used", async () => {
    const other = await insertOwner(store, "other@example.test");
    await writeTask(store, owner, { title: "First owner" });
    await writeTask(store, other, { title: "Second owner" });
    const firstBytes = (await publish(owner)).byteSize;
    const secondBytes = (await publish(other)).byteSize;
    const cache = new SearchIndexCache({
      now: () => store.now,
      maxBytes: Math.max(firstBytes, secondBytes) + 10,
    });
    const search = service({ cache });
    await search.search(principal, { q: "owner" });
    expect(cache.has(owner)).toBe(true);
    await search.search({ userId: other, accessGeneration: 0 }, { q: "owner" });
    expect(cache.has(other)).toBe(true);
    expect(cache.has(owner)).toBe(false);
    expect(cache.stats().bytes).toBeLessThanOrEqual(cache.stats().maxBytes);
  });

  it("drops idle indexes", async () => {
    await writeTask(store, owner, { title: "Idle" });
    await publish();
    const cache = new SearchIndexCache({ now: () => store.now, idleMs: 1_000 });
    const search = service({ cache });
    await search.search(principal, { q: "idle" });
    store.now += 2_000;
    search.sweep();
    expect(cache.has(owner)).toBe(false);
  });
});

describe("content types, chat opt-in and deadline filters", () => {
  it("returns chat hits only for an opted-in, indexed owner and explains why otherwise", async () => {
    const task = await writeTask(store, owner, { title: "Portfolio" });
    const messageId = uuidv7(store.now);
    store.messages.persist(owner, {
      id: messageId,
      taskId: task,
      conversationId: uuidv7(store.now),
      speaker: "simon",
      createdAt: store.now,
      text: "Three projects have no image yet",
    });
    await recordIntent(store, owner, "message", messageId);
    await publish();
    const search = service({ tuning: { stateTtlMs: 0, chatOptInTtlMs: 0 } });

    let result = await search.search(principal, { q: "image", types: ["chat"] });
    expect(result.response.items).toEqual([]);
    expect(result.response.notices).toContain("chat_opt_in_required");

    store.chatOptIn.set(owner, true);
    result = await search.search(principal, { q: "image", types: ["chat"] });
    expect(result.response.status).toBe("partial");
    expect(result.response.notices).toContain("chat_indexing");
    expect(result.indexing).toBe("rebuild");

    await publish();
    search.invalidateState(owner);
    result = await search.search(principal, { q: "image", types: ["chat"] });
    expect(result.response.status).toBe("ready");
    expect(result.response.items[0]).toMatchObject({
      match: "chat",
      messageCount: 1,
      messages: [
        { messageId, speaker: "simon", snippet: { text: "Three projects have no image yet" } },
      ],
    });
  });

  it("answers filter_unavailable for deadline filters without schedule metadata", async () => {
    await writeTask(store, owner, { title: "Deadline task" });
    await publish();
    const withoutDeadlines = service({ sources: { ...store.sources, deadlines: null } });
    await expect(
      withoutDeadlines.search(principal, { q: "deadline", deadline: { kind: "has" } }),
    ).rejects.toMatchObject({ code: "search.filter_unavailable" });
  });

  it("narrows results with deadline filters when schedule metadata exists", async () => {
    const due = await writeTask(store, owner, { title: "Due report" });
    await writeTask(store, owner, { title: "Undated report" });
    await publish();
    store.deadlineMatches.set(owner, new Set([due]));
    const search = service();
    const { response } = await search.search(principal, {
      q: "report",
      deadline: { kind: "overdue", timeZone: "America/Los_Angeles" },
    });
    expect(response.items.map((item) => item.task.title)).toEqual(["Due report"]);
    expect(response.scope.deadline).toEqual({ kind: "overdue", timeZone: "America/Los_Angeles" });
    expect(store.deadlines.calls).toEqual([
      { ownerId: owner, filter: { kind: "overdue", timeZone: "America/Los_Angeles" } },
    ]);
  });

  it("expands one task's hits", async () => {
    const task = await writeTask(store, owner, { title: "Trip" });
    const markdown = Array.from(
      { length: 6 },
      (_, index) => `## Day ${index}\nBring the camera`,
    ).join("\n");
    store.documents.publishMarkdown(owner, task, markdown, "rev1");
    await recordIntent(store, owner, "document", task);
    await publish();
    const search = service();
    const collapsed = await search.search(principal, { q: "camera" });
    expect(collapsed.response.items[0]).toMatchObject({ sectionCount: 6 });
    expect(collapsed.response.items[0]?.sections).toHaveLength(3);
    const expanded = await search.search(principal, { q: "camera", taskId: task });
    expect(expanded.response.items[0]?.sections).toHaveLength(6);
    expect(expanded.response.scope.taskId).toBe(task);
  });
});

describe("quick title search (command palette)", () => {
  it("returns title matches with their kind and never documents", async () => {
    const task = await writeTask(store, owner, { title: "Try the pottery class" });
    await writeTask(store, owner, { title: "Book the pottery class", archived: true });
    store.documents.publishMarkdown(owner, task, "## Notes\npottery aprons", "rev1");
    await recordIntent(store, owner, "document", task);
    await writeTask(store, owner, { title: "Aprons in the document only" });
    await publish();
    const search = service();
    const { response } = await search.titles(principal, { q: "potery" });
    expect(response).toMatchObject({ status: "ready", indexGeneration: 1 });
    expect(response.items.map((item) => [item.task.title, item.match])).toEqual([
      ["Try the pottery class", "title_typo"],
    ]);
    const archived = await search.titles(principal, { q: "pottery", archive: "include" });
    expect(archived.response.items.map((item) => item.task.archived).sort()).toEqual([false, true]);
    expect(
      (await search.titles(principal, { q: "try the pottery class" })).response.items[0]?.match,
    ).toBe("title_exact");
  });
});

describe("hygiene (note 14)", () => {
  it("never logs queries, titles or snippets", async () => {
    await writeTask(store, owner, { title: "Confidential merger plan" });
    await publish();
    await service().search(principal, { q: "confidential merger" });
    expect(logged.join("\n")).not.toMatch(/confidential|merger/i);
    expect(logged.some((line) => line.includes("search.query_served"))).toBe(true);
  });

  it("uses no model or network client anywhere in core/search", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const files = (function walk(path: string): string[] {
      return readdirSync(path).flatMap((name) => {
        const full = join(path, name);
        return statSync(full).isDirectory() ? walk(full) : /\.ts$/.test(name) ? [full] : [];
      });
    })(dir).filter((file) => !/\.test\.ts$/.test(file));
    const forbidden =
      /from\s+["'](?:ai|@ai-sdk\/[^"']+|@symplist\/agent|@symplist\/integrations|@composio\/core)["']|\bfetch\s*\(/;
    expect(files.filter((file) => forbidden.test(readFileSync(file, "utf8")))).toEqual([]);
  });

  it("keeps index objects under the owner prefix", async () => {
    await writeTask(store, owner, { title: "Prefix" });
    await publish();
    const listed = await store.objects.list({ prefix: "u/" });
    expect(
      listed.objects.every((object) => object.key.startsWith(searchIndexObjectPrefix(owner))),
    ).toBe(true);
    expect(int(1)).toBe("1");
  });
});

describe("source failures", () => {
  it("answers search.unavailable when a document source fails while overlaying changes", async () => {
    const task = await writeTask(store, owner, { title: "Overlay source" });
    await publish();
    store.documents.publishMarkdown(owner, task, "## New\ncontent", "rev2");
    await recordIntent(store, owner, "document", task);
    store.documents.failure = new Error("snapshot store down");
    await expect(service().search(principal, { q: "overlay" })).rejects.toMatchObject({
      code: "search.unavailable",
    });
    expect(logged.join("\n")).not.toContain("snapshot store down");
    store.documents.failure = null;
    expect((await service().search(principal, { q: "content" })).response.items).toHaveLength(1);
  });
});
