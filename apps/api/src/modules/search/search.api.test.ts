import type { SearchFreshness, SearchTitleResponse } from "@symplist/contracts";
import { searchResponseSchema, searchTitleResponseSchema } from "@symplist/contracts";
import type { D1AccessService } from "@symplist/core/access";
import {
  D1SearchTaskSource,
  InMemoryDocumentTextSource,
  SEARCH_INDEX_PUBLISHED_EVENT,
  type SearchIndexCache,
  SearchIndexWriter,
  SearchServiceError,
  type SearchSources,
  searchIndexIdempotencyKey,
  searchIntentStatement,
  taskTitleContext,
} from "@symplist/core/search";
import { encryptFieldText, zeroize } from "@symplist/crypto";
import { type DbClient, int, newWriteId, sql, uuidv7 } from "@symplist/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InternalEventClient } from "../../../../worker/src/infra/internal-events.ts";
import { createWorkerLogger } from "../../../../worker/src/infra/logger.ts";
import {
  bootTestApp,
  type TestApp,
  type TestAppOptions,
  type TestSession,
} from "../../../test/harness.ts";
import { WsTestClient } from "../../../test/ws-client.ts";
import { ACCESS_SERVICE } from "../../common/access/access.providers.ts";
import {
  DEFAULT_SEARCH_API_TUNING,
  SEARCH_API_TUNING,
  SEARCH_INDEX_CACHE,
  SEARCH_QUERY_SERVICE,
  SEARCH_SOURCES,
} from "./search.tokens.ts";
import { SearchIndexCoordinator } from "./search-index.coordinator.ts";

const apps: TestApp[] = [];
const sockets: WsTestClient[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const app of apps.splice(0)) await app.close();
});

interface Booted {
  readonly app: TestApp;
  readonly documents: InMemoryDocumentTextSource;
}

async function boot(options: TestAppOptions = {}): Promise<Booted> {
  let booted: TestApp | undefined;
  // The sources read the booted app's database; the documents feature is stood in for in memory.
  const lazyDb: DbClient = {
    batch: (statements, batchOptions) => (booted as TestApp).db.batch(statements, batchOptions),
    all: (statement, batchOptions) => (booted as TestApp).db.all(statement, batchOptions),
    first: (statement, batchOptions) => (booted as TestApp).db.first(statement, batchOptions),
    run: (statement, batchOptions) => (booted as TestApp).db.run(statement, batchOptions),
  };
  const documents = new InMemoryDocumentTextSource();
  const sources: SearchSources = {
    tasks: new D1SearchTaskSource(lazyDb),
    documents,
    messages: null,
    chatOptIn: null,
    deadlines: null,
  };
  booted = await bootTestApp({
    ...options,
    overrides: [
      { token: SEARCH_SOURCES, value: sources },
      { token: SEARCH_API_TUNING, value: { ...DEFAULT_SEARCH_API_TUNING, localDelayMs: 30_000 } },
      ...(options.overrides ?? []),
    ],
  });
  apps.push(booted);
  return { app: booted, documents };
}

async function writeTask(
  app: TestApp,
  ownerId: string,
  input: {
    readonly title: string;
    readonly id?: string;
    readonly archived?: boolean;
    readonly version?: number;
  },
): Promise<string> {
  const id = input.id ?? uuidv7(app.clock.now());
  const key = await app.accountKeys.require(ownerId);
  const titleEnc = encryptFieldText(key, taskTitleContext(ownerId, id), input.title);
  zeroize(key.key);
  const now = app.clock.now();
  const version = input.version ?? 1;
  await app.db.batch([
    sql(
      `INSERT INTO tasks (id, owner_id, collection, position, status, archived_at, source, version, write_id,
         title_enc, created_at, updated_at)
       VALUES (:id, :owner, 'now', 'a0', :status, :archived_at, 'user', :version, :w, :title, :now, :now)
       ON CONFLICT (id) DO UPDATE SET status = excluded.status, archived_at = excluded.archived_at,
         version = excluded.version, title_enc = excluded.title_enc, updated_at = excluded.updated_at`,
      {
        id,
        owner: ownerId,
        status: input.archived ? "archived" : "active",
        archived_at: input.archived ? int(now) : null,
        version: int(version),
        w: newWriteId(),
        title: titleEnc,
        now: int(now),
      },
    ),
    searchIntentStatement({
      ownerId,
      entity: "task",
      entityId: id,
      revisionOrSeq: version,
      op: "upsert",
      now,
    }),
  ]);
  return id;
}

async function searchAs(app: TestApp, session: TestSession, query: string) {
  return app.get(`/v1/search?${query}`, { session });
}

async function index(app: TestApp, ownerId: string) {
  const summary = await app.inject<SearchIndexCoordinator>(SearchIndexCoordinator).runNow(ownerId);
  expect(summary.status).toBe("published");
  return summary;
}

describe("GET /v1/search (§10.1, note 14)", () => {
  it("requires an admitted session, so locked and relocked accounts retrieve nothing", async () => {
    const { app } = await boot();
    expect((await app.get("/v1/search?q=anything")).status).toBe(401);
    expect((await app.get("/v1/search/titles?q=anything")).status).toBe(401);
    expect((await app.get("/v1/search/freshness")).status).toBe(401);
    for (const state of ["locked", "relocked", "suspended", "unverified"] as const) {
      const user = await app.createSignedInUser(state);
      await writeTask(app, user.id, { title: "Protected plans" });
      const response = await searchAs(app, user.session, "q=protected");
      expect(response.status).toBe(403);
      expect(JSON.stringify(response.json())).not.toContain("Protected");
      expect(
        (await app.get("/v1/search/titles?q=protected", { session: user.session })).status,
      ).toBe(403);
    }
  });

  it("validates the query string with fixed messages", async () => {
    const { app } = await boot();
    const user = await app.createSignedInUser();
    for (const query of [
      "",
      "q=",
      `q=${"x".repeat(201)}`,
      "q=a&collections=now,archive",
      "q=a&collections=now,now",
      "q=a&types=tasks,vault",
      "q=a&archive=all",
      "q=a&limit=0",
      "q=a&limit=51",
      "q=a&limit=01",
      "q=a&unknown=1",
      "q=a&q=b",
      "q=a&taskId=not-a-task",
      "q=a&deadline=due_today",
      "q=a&deadline=range&timeZone=UTC&deadlineFrom=2026-09-10",
      "q=a&deadline=range&timeZone=UTC&deadlineFrom=2026-09-10&deadlineTo=2026-09-01",
      "q=a&deadline=has&timeZone=UTC",
      "q=a&deadline=overdue&timeZone=Mars/Olympus",
      "q=a&cursor=%21%21",
    ]) {
      const response = await searchAs(app, user.session, query);
      expect(response.status, query).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code, query).toBe("validation");
      expect(response.text).not.toContain("Mars/Olympus");
    }
  });

  it("answers filter_unavailable for deadline filters until scheduling supplies schedule metadata", async () => {
    const { app } = await boot();
    const user = await app.createSignedInUser();
    const response = await searchAs(
      app,
      user.session,
      "q=report&deadline=overdue&timeZone=America%2FLos_Angeles",
    );
    expect(response.status).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: "search.filter_unavailable" } });
  });

  it("serves titles while the index is missing, builds it in process, then serves documents", async () => {
    const { app, documents } = await boot();
    const user = await app.createSignedInUser();
    const task = await writeTask(app, user.id, { title: "Send the project outline" });
    documents.publishMarkdown(
      user.id,
      task,
      "## Outline\nDraft for the community garden project",
      "rev1",
    );
    await app.db.run(
      searchIntentStatement({
        ownerId: user.id,
        entity: "document",
        entityId: task,
        revisionOrSeq: 1,
        op: "upsert",
        now: app.clock.now(),
      }),
    );
    const socket = await WsTestClient.connect(app.wsUrl, {
      origin: app.config.WEB_ORIGIN,
      cookie: user.session.cookie,
    });
    sockets.push(socket);
    socket.send({ t: "sub", topic: "user", cursor: null, openTasks: [] });
    await socket.waitFor((frame) => frame.t === "snapshot");

    const first = await searchAs(app, user.session, "q=outline");
    expect(first.status).toBe(200);
    const rebuilding = searchResponseSchema.parse(first.json());
    expect(rebuilding).toMatchObject({
      status: "rebuilding",
      indexGeneration: 0,
      pendingIntents: 2,
    });
    expect(rebuilding.items.map((item) => item.task.title)).toEqual(["Send the project outline"]);
    expect(first.headers.get("cache-control")).toContain("no-store");

    // The rebuild request runs the local writer at once.
    await app.clock.advance(0);
    await vi.waitFor(async () => {
      const freshness = (
        await app.get("/v1/search/freshness", { session: user.session })
      ).json<SearchFreshness>();
      expect(freshness).toEqual({ status: "ready", indexGeneration: 1, pendingIntents: 0 });
    });
    const event = await socket.waitFor(
      (frame) => frame.t === "ev" && frame.type === "search.freshness",
    );
    expect(event).toMatchObject({ topic: "user", data: { generation: 1, pending: 0 } });

    const ready = searchResponseSchema.parse(
      (await searchAs(app, user.session, "q=garden")).json(),
    );
    expect(ready).toMatchObject({
      status: "ready",
      indexGeneration: 1,
      pendingIntents: 0,
      scope: {
        collections: ["now", "later", "unclassified"],
        archive: "exclude",
        types: ["tasks", "documents"],
      },
    });
    expect(ready.items[0]).toMatchObject({
      task: { id: task, title: "Send the project outline", archived: false, parent: null },
      match: "body",
      sections: [
        {
          heading: "Outline",
          match: "body",
          indexedRevision: "rev1",
          currentRevision: "rev1",
          stale: false,
        },
      ],
    });
    expect(app.logs.text()).not.toMatch(/outline|garden/i);
    expect(await app.scanDatabaseFor("community garden")).toEqual([]);
    expect(app.scanObjectsFor("community garden")).toEqual([]);
  });

  it("indexes new changes after the producers' delay and overlays them before that", async () => {
    const { app } = await boot();
    const user = await app.createSignedInUser();
    await writeTask(app, user.id, { title: "Draft invoice" });
    await index(app, user.id);
    const renamed = (
      await app.db.first(sql(`SELECT id FROM tasks WHERE owner_id = :owner`, { owner: user.id }))
    )?.id;
    await writeTask(app, user.id, { id: String(renamed), title: "Send receipt", version: 2 });

    const overlay = searchResponseSchema.parse(
      (await searchAs(app, user.session, "q=receipt")).json(),
    );
    expect(overlay).toMatchObject({ status: "ready", indexGeneration: 1, pendingIntents: 1 });
    expect(overlay.items.map((item) => item.task.title)).toEqual(["Send receipt"]);

    const coordinator = app.inject<SearchIndexCoordinator>(SearchIndexCoordinator);
    coordinator.request(user.id, "changes");
    await app.clock.advance(29_000);
    expect((await app.get("/v1/search/freshness", { session: user.session })).json()).toMatchObject(
      {
        indexGeneration: 1,
      },
    );
    await app.clock.advance(1_000);
    await vi.waitFor(async () =>
      expect(
        (await app.get("/v1/search/freshness", { session: user.session })).json(),
      ).toMatchObject({
        indexGeneration: 2,
        pendingIntents: 0,
      }),
    );
  });

  it("keeps two users apart", async () => {
    const { app } = await boot();
    const maya = await app.createSignedInUser();
    const other = await app.createSignedInUser();
    await writeTask(app, maya.id, { title: "Maya invoice" });
    await writeTask(app, other.id, { title: "Other invoice" });
    await index(app, maya.id);
    await index(app, other.id);
    const mine = searchResponseSchema.parse(
      (await searchAs(app, maya.session, "q=invoice")).json(),
    );
    const theirs = searchResponseSchema.parse(
      (await searchAs(app, other.session, "q=invoice")).json(),
    );
    expect(mine.items.map((item) => item.task.title)).toEqual(["Maya invoice"]);
    expect(theirs.items.map((item) => item.task.title)).toEqual(["Other invoice"]);
    // A task id of another user expands to nothing.
    const foreign = theirs.items[0]?.task.id ?? "";
    const expanded = searchResponseSchema.parse(
      (await searchAs(app, maya.session, `q=invoice&taskId=${foreign}`)).json(),
    );
    expect(expanded.items).toEqual([]);
  });

  it("pages with cursors and answers cursor_stale after a new generation", async () => {
    const { app } = await boot();
    const user = await app.createSignedInUser();
    for (let index = 0; index < 5; index += 1)
      await writeTask(app, user.id, { title: `Weekly review ${index}` });
    await index(app, user.id);
    const first = searchResponseSchema.parse(
      (await searchAs(app, user.session, "q=weekly&limit=2")).json(),
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = searchResponseSchema.parse(
      (await searchAs(app, user.session, `q=weekly&limit=2&cursor=${first.nextCursor}`)).json(),
    );
    expect(second.items.map((item) => item.task.id)).not.toContain(first.items[0]?.task.id);

    await writeTask(app, user.id, { title: "Weekly review extra" });
    await index(app, user.id);
    const stale = await searchAs(app, user.session, `q=weekly&limit=2&cursor=${first.nextCursor}`);
    expect(stale.status).toBe(409);
    expect(stale.json()).toMatchObject({
      error: { code: "search.cursor_stale", details: { indexGeneration: 2 } },
    });
    const mismatched = await searchAs(
      app,
      user.session,
      `q=review&limit=2&cursor=${second.nextCursor}`,
    );
    expect(mismatched.status).toBe(400);
    expect(mismatched.json()).toMatchObject({ error: { code: "search.cursor_invalid" } });
  });

  it("excludes archived tasks unless the archive is requested, and marks them", async () => {
    const { app } = await boot();
    const user = await app.createSignedInUser();
    await writeTask(app, user.id, { title: "Try the pottery class" });
    await writeTask(app, user.id, { title: "Book the pottery class", archived: true });
    await index(app, user.id);
    const active = searchResponseSchema.parse(
      (await searchAs(app, user.session, "q=pottery")).json(),
    );
    expect(active.items.map((item) => item.task.title)).toEqual(["Try the pottery class"]);
    const all = searchResponseSchema.parse(
      (await searchAs(app, user.session, "q=pottery&archive=include")).json(),
    );
    expect(all.items.find((item) => item.task.archived)?.task.title).toBe("Book the pottery class");
  });
});

describe("GET /v1/search/titles (command palette)", () => {
  it("returns exact, prefix and typo title matches", async () => {
    const { app } = await boot();
    const user = await app.createSignedInUser();
    await writeTask(app, user.id, { title: "Book a bike tune-up" });
    await writeTask(app, user.id, { title: "Try the pottery class" });
    await index(app, user.id);
    const read = async (query: string) =>
      searchTitleResponseSchema.parse(
        (
          await app.get(`/v1/search/titles?${query}`, { session: user.session })
        ).json<SearchTitleResponse>(),
      );
    expect((await read("q=Book%20a%20bike%20tune-up")).items.map((item) => item.match)).toEqual([
      "title_exact",
    ]);
    expect((await read("q=bo")).items.map((item) => [item.task.title, item.match])).toEqual([
      ["Book a bike tune-up", "title_prefix"],
    ]);
    expect((await read("q=potery&limit=3")).items.map((item) => item.match)).toEqual([
      "title_typo",
    ]);
    expect((await read("q=zzzz")).items).toEqual([]);
    expect(
      (await app.get("/v1/search/titles?q=a&limit=21", { session: user.session })).status,
    ).toBe(400);
  });
});

describe("cache eviction on restriction and deletion (§5.5, §10.1)", () => {
  it("drops the user's decrypted index after relock and after account deletion", async () => {
    const { app } = await boot();
    const user = await app.createSignedInUser();
    await writeTask(app, user.id, { title: "Cached plans" });
    await index(app, user.id);
    expect((await searchAs(app, user.session, "q=cached")).status).toBe(200);
    const cache = app.inject<SearchIndexCache>(SEARCH_INDEX_CACHE);
    expect(cache.has(user.id)).toBe(true);

    const access = app.inject<D1AccessService>(ACCESS_SERVICE);
    const outcome = await access.restrict({
      userId: user.id,
      reason: "relocked",
      writeId: newWriteId(),
      now: app.clock.now(),
    });
    expect(outcome.applied).toBe(true);
    expect(cache.has(user.id)).toBe(false);
    expect((await searchAs(app, user.session, "q=cached")).status).toBe(403);
    expect(app.logs.events("search.cache_entry_evicted")).toMatchObject([{ reason: "restricted" }]);

    const other = await app.createSignedInUser();
    await writeTask(app, other.id, { title: "Other cached" });
    await index(app, other.id);
    await searchAs(app, other.session, "q=cached");
    expect(cache.has(other.id)).toBe(true);
    await access.afterRestriction({
      userId: other.id,
      reason: "deleted",
      accessGeneration: 5,
      committedAt: app.clock.now(),
    });
    expect(cache.has(other.id)).toBe(false);
  });
});

describe("durable mode (§10.1: the api never writes the index)", () => {
  const durable = {
    env: {
      DURABLE: "true",
      TRIGGER_SECRET_KEY: "tr_dev_searchtest",
      TRIGGER_PROJECT_REF: "proj_searchtest",
    },
  };

  it("enqueues the search-index task once per window with an ids-only payload and never writes", async () => {
    const { app } = await boot(durable);
    const user = await app.createSignedInUser();
    await writeTask(app, user.id, { title: "Durable plans" });
    const first = searchResponseSchema.parse(
      (await searchAs(app, user.session, "q=durable")).json(),
    );
    expect(first.status).toBe("rebuilding");
    await searchAs(app, user.session, "q=durable");
    await vi.waitFor(() => expect(app.trigger.triggers).toHaveLength(1));
    expect(app.trigger.triggers[0]).toMatchObject({
      taskIdentifier: "search-index",
      payload: { ownerId: user.id },
      options: {
        idempotencyKey: searchIndexIdempotencyKey(user.id, app.clock.now()),
        delay: "30s",
      },
    });
    expect(JSON.stringify(app.trigger.triggers)).not.toContain("Durable plans");
    const coordinator = app.inject<SearchIndexCoordinator>(SearchIndexCoordinator);
    expect(await coordinator.runNow(user.id)).toMatchObject({ status: "skipped" });
    expect(await app.db.first(sql(`SELECT COUNT(*) AS count FROM search_indexes`))).toEqual({
      count: 0,
    });
    expect(app.scanObjectsFor("search")).toEqual([]);

    await app.clock.advance(30_000);
    await searchAs(app, user.session, "q=durable");
    await vi.waitFor(() => expect(app.trigger.triggers).toHaveLength(2));
  });

  it("publishes search.freshness from D1 when the worker announces a publication", async () => {
    const { app } = await boot(durable);
    const user = await app.createSignedInUser();
    await writeTask(app, user.id, { title: "Announced" });
    // Publish generation 1 as the worker's writer would, then announce it with a misleading payload.
    const writer = new SearchIndexWriter({
      db: app.db,
      objects: app.objects,
      keys: app.keys,
      sources: app.inject<SearchSources>(SEARCH_SOURCES),
      now: () => app.clock.now(),
    });
    expect(await writer.run(user.id, { mode: "durable" })).toMatchObject({
      status: "published",
      generation: 1,
    });

    const socket = await WsTestClient.connect(app.wsUrl, {
      origin: app.config.WEB_ORIGIN,
      cookie: user.session.cookie,
    });
    sockets.push(socket);
    socket.send({ t: "sub", topic: "user", cursor: null, openTasks: [] });
    await socket.waitFor((frame) => frame.t === "snapshot");
    const worker = new InternalEventClient({
      keys: app.keys,
      apiOrigin: app.baseUrl,
      logger: createWorkerLogger({
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }),
      timers: app.clock,
    });
    expect(
      await worker.announce({
        type: SEARCH_INDEX_PUBLISHED_EVENT,
        ownerId: user.id,
        payload: { generation: 99, pending: 7 },
      }),
    ).toBe("delivered");
    const event = await socket.waitFor(
      (frame) => frame.t === "ev" && frame.type === "search.freshness",
    );
    expect(event).toMatchObject({ data: { generation: 1, pending: 0 } });
  });
});

describe("search failures", () => {
  it("answers search.unavailable with a fixed message when the index cannot be read", async () => {
    const unavailable = {
      search: async () => {
        throw new SearchServiceError("search.unavailable");
      },
      titles: async () => {
        throw new SearchServiceError("search.unavailable");
      },
      freshness: async () => {
        throw new SearchServiceError("search.unavailable");
      },
    };
    const { app } = await boot({
      overrides: [{ token: SEARCH_QUERY_SERVICE, value: unavailable }],
    });
    const user = await app.createSignedInUser();
    for (const path of [
      "/v1/search?q=anything",
      "/v1/search/titles?q=anything",
      "/v1/search/freshness",
    ]) {
      const response = await app.get(path, { session: user.session });
      expect(response.status).toBe(503);
      expect(response.json()).toMatchObject({
        error: {
          code: "search.unavailable",
          message: "Search is temporarily unavailable; try again",
        },
      });
    }
    expect(app.logs.text()).not.toContain("anything");
  });
});

describe("local index scheduling (§10.1: the api writes when DURABLE=false)", () => {
  it("sweeps owners whose intents waited while the local scheduler runs", async () => {
    const { app } = await boot({ runtime: { backgroundLoops: true } });
    const user = await app.createSignedInUser();
    await writeTask(app, user.id, { title: "Swept task" });
    await app.clock.advance(30_000);
    await app.clock.advance(30_000);
    await vi.waitFor(async () =>
      expect(
        (
          await app.db.first(
            sql(`SELECT generation FROM search_indexes WHERE owner_id = :owner`, {
              owner: user.id,
            }),
          )
        )?.generation,
      ).toBe(1),
    );
  });

  it("schedules nothing periodic without background loops, so long clock moves stay cheap", async () => {
    const { app } = await boot();
    const user = await app.createSignedInUser();
    await writeTask(app, user.id, { title: "Unswept task" });
    const batch = vi.spyOn(app.db, "batch");
    await app.clock.advance(24 * 60 * 60_000);
    expect(batch).not.toHaveBeenCalled();
    expect(await app.db.first(sql(`SELECT COUNT(*) AS count FROM search_indexes`))).toEqual({
      count: 0,
    });
  });
});
