import {
  documentCompareResponseSchema,
  documentConflictResponseSchema,
  documentHeadResponseSchema,
  documentHistoryResponseSchema,
  documentPublishResponseSchema,
  documentRevisionResponseSchema,
} from "@symplist/contracts";
import { DocumentMaintenance, DocumentService } from "@symplist/core/documents";
import { int, sql, uuidv7 } from "@symplist/db";
import type { GitService, PublicationHooks } from "@symplist/docs";
import { afterEach, describe, expect, it } from "vitest";
import { InternalEventClient } from "../../../../worker/src/infra/internal-events.ts";
import { createWorkerLogger } from "../../../../worker/src/infra/logger.ts";
import { bootTestApp, type TestApp, type TestSession } from "../../../test/harness.ts";
import { WsTestClient } from "../../../test/ws-client.ts";
import { LocalScheduler } from "../../infra/scheduler/local-scheduler.ts";
import { DOCUMENT_GIT, DOCUMENT_PUBLICATION_HOOKS } from "./documents.module.ts";

const apps: TestApp[] = [];
const sockets: WsTestClient[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const app of apps.splice(0)) await app.close();
});

async function boot(options: Parameters<typeof bootTestApp>[0] = {}): Promise<TestApp> {
  const app = await bootTestApp(options);
  apps.push(app);
  return app;
}

async function createTask(app: TestApp, ownerId: string): Promise<string> {
  const id = uuidv7(app.clock.now());
  await app.db.run(
    sql(
      `INSERT INTO tasks (id, owner_id, collection, position, source, write_id, title_enc, created_at, updated_at)
       VALUES (:id, :owner, 'now', 'a0', 'user', :w, 'sym1.1.x.y', :now, :now)`,
      { id, owner: ownerId, w: uuidv7(app.clock.now()), now: int(app.clock.now()) },
    ),
  );
  return id;
}

let keySequence = 0;
function key(): string {
  keySequence += 1;
  return `doc-key-${keySequence.toString().padStart(12, "0")}`;
}

async function save(
  app: TestApp,
  session: TestSession,
  taskId: string,
  body: Record<string, unknown>,
  idempotencyKey = key(),
) {
  return app.post(`/v1/tasks/${taskId}/document/commits`, { session, body, idempotencyKey });
}

const marker = "MARKER-api-document-7c1e";

describe("documents api (§9.2, §9.3)", () => {
  it("saves, replays, refuses mismatches, reports conflicts with the draft kept, and serves history, previews, compare, restore and review", async () => {
    const app = await boot();
    const { id: ownerId, session } = await app.createSignedInUser();
    const taskId = await createTask(app, ownerId);

    const empty = await app.get(`/v1/tasks/${taskId}/document`, { session });
    expect(empty.status).toBe(200);
    expect(documentHeadResponseSchema.parse(empty.json())).toMatchObject({
      revision: null,
      sections: [],
    });

    const missingKey = await app.post(`/v1/tasks/${taskId}/document/commits`, {
      session,
      body: { baseRevision: null, markdown: "# A" },
    });
    expect(missingKey.json()).toMatchObject({ error: { code: "idempotency.key_required" } });

    const firstKey = key();
    const body = { baseRevision: null, markdown: `## Overview\n${marker}\n` };
    const first = await save(app, session, taskId, body, firstKey);
    expect(first.status).toBe(201);
    const published = documentPublishResponseSchema.parse(first.json());
    expect(published).toMatchObject({ status: "published", generation: 1 });

    const replay = await save(app, session, taskId, body, firstKey);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(replay.json()).toEqual(first.json());
    const mismatch = await save(app, session, taskId, { ...body, markdown: "# Other" }, firstKey);
    expect(mismatch.status).toBe(422);

    const unchanged = await save(app, session, taskId, {
      baseRevision: published.revision,
      markdown: body.markdown,
    });
    expect(unchanged.status).toBe(200);
    expect(unchanged.json()).toMatchObject({ status: "unchanged", revision: published.revision });

    app.clock.advance(5_000);
    const second = documentPublishResponseSchema.parse(
      (
        await save(app, session, taskId, {
          baseRevision: published.revision,
          markdown: `## Overview\n${marker}\n\n## Next steps\nShip\n`,
        })
      ).json(),
    );
    const conflict = await save(app, session, taskId, {
      baseRevision: published.revision,
      markdown: "## Overview\nmine\n",
      draftSeq: 3,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: {
        code: "document.conflict",
        details: { currentRevision: second.revision, currentGeneration: 2, draftPreserved: true },
      },
    });
    const head = documentHeadResponseSchema.parse(
      (await app.get(`/v1/tasks/${taskId}/document`, { session })).json(),
    );
    expect(head).toMatchObject({
      revision: second.revision,
      draft: { origin: "conflict", clientSeq: 3, markdown: "## Overview\nmine\n" },
    });
    expect(head.sections.map((section) => section.heading)).toEqual(["Overview", "Next steps"]);

    const review = await app.get(
      `/v1/tasks/${taskId}/document/conflict?base=${published.revision}`,
      { session },
    );
    expect(review.status).toBe(200);
    expect(
      documentConflictResponseSchema
        .parse(review.json())
        .sections.map((section) => [section.heading, section.status]),
    ).toEqual([
      ["Overview", "draft_changed"],
      ["Next steps", "saved_changed"],
    ]);

    const history = await app.get(`/v1/tasks/${taskId}/document/history?limit=1`, { session });
    const page = documentHistoryResponseSchema.parse(history.json());
    expect(page.items.map((item) => [item.generation, item.subject])).toEqual([
      [2, "Added Next steps"],
    ]);
    const next = documentHistoryResponseSchema.parse(
      (
        await app.get(`/v1/tasks/${taskId}/document/history?limit=1&cursor=${page.nextCursor}`, {
          session,
        })
      ).json(),
    );
    expect(next.items.map((item) => item.revision)).toEqual([published.revision]);

    const preview = await app.get(`/v1/tasks/${taskId}/document/revisions/${published.revision}`, {
      session,
    });
    expect(documentRevisionResponseSchema.parse(preview.json())).toMatchObject({
      isHead: false,
      markdown: body.markdown,
    });

    const compare = await app.get(
      `/v1/tasks/${taskId}/document/compare?base=${published.revision}`,
      { session },
    );
    const compared = documentCompareResponseSchema.parse(compare.json());
    expect(compared.changes.map((change) => change.status)).toEqual(["added"]);
    expect(compared.hunks.flatMap((hunk) => hunk.lines).some((line) => line.kind === "added")).toBe(
      true,
    );
    const badBase = await app.get(`/v1/tasks/${taskId}/document/compare?base=${"a".repeat(40)}`, {
      session,
    });
    expect(badBase.json()).toMatchObject({ error: { code: "document.resync_required" } });

    const restoreKey = key();
    const restore = await app.post(`/v1/tasks/${taskId}/document/restore`, {
      session,
      idempotencyKey: restoreKey,
      body: { revision: published.revision, expectedRevision: second.revision },
    });
    expect(restore.status).toBe(201);
    expect(restore.json()).toMatchObject({
      status: "published",
      restoredFrom: published.revision,
      generation: 3,
    });
    const staleRestore = await app.post(`/v1/tasks/${taskId}/document/restore`, {
      session,
      idempotencyKey: key(),
      body: { revision: published.revision, expectedRevision: second.revision },
    });
    expect(staleRestore.json()).toMatchObject({ error: { code: "document.conflict" } });

    // No document text in logs, D1 or R2 in plaintext.
    expect(app.logs.text()).not.toContain(marker);
    expect(await app.scanDatabaseFor(marker)).toEqual([]);
    expect(app.scanObjectsFor(marker)).toEqual([]);
    // One journey through the whole document surface: it boots the api, signs a user in, and does
    // real Argon2, AES-GCM and Git-object work for every save, publication, restore and scan, which
    // runs a little over Vitest's 5 s default on its own and well over it while `pnpm test` has
    // every other project on the machine. The budget is generous rather than tight so a busy
    // machine does not turn a passing suite red; nothing here waits on a timer.
  }, 60_000);

  it("bounds Git reconstructions and registers hourly maintenance in local mode", async () => {
    const app = await boot();
    const git = app.inject<GitService>(DOCUMENT_GIT);
    expect(git.limits).toMatchObject({
      maxConcurrent: 2,
      maxQueued: 16,
      maxBlobBytes: app.config.DOC_MAX_BYTES,
    });
    expect(git.available).toBe(true);
    const { id: ownerId, session } = await app.createSignedInUser();
    const taskId = await createTask(app, ownerId);
    await save(app, session, taskId, { baseRevision: null, markdown: "## A\none" });
    const maintenance = app.inject<DocumentMaintenance>(DocumentMaintenance);
    const result = await maintenance.run({ now: app.clock.now() + 2 * 24 * 60 * 60 * 1000 });
    expect(result).toMatchObject({ orphans: { complete: true }, expiredRequests: 0 });
    expect(app.inject<LocalScheduler>(LocalScheduler).active).toBe(false);
  });

  it("stores ordered drafts, throttles them and clears them", async () => {
    const app = await boot();
    const { id: ownerId, session } = await app.createSignedInUser();
    const taskId = await createTask(app, ownerId);
    const put = (clientSeq: number, markdown: string) =>
      app.request("PUT", `/v1/tasks/${taskId}/document/draft`, {
        session,
        body: { baseRevision: null, clientSeq, markdown },
      });
    expect((await put(2, "two")).status).toBe(200);
    const throttled = await put(3, "three");
    expect(throttled.status).toBe(503);
    expect(throttled.headers.get("retry-after")).not.toBeNull();
    app.clock.advance(3_000);
    expect((await put(1, "one")).json()).toMatchObject({ error: { code: "document.draft_stale" } });
    app.clock.advance(3_000);
    const deleted = await app.request("DELETE", `/v1/tasks/${taskId}/document/draft?clientSeq=2`, {
      session,
    });
    expect(deleted.status).toBe(204);
    expect((await app.get(`/v1/tasks/${taskId}/document`, { session })).json()).toMatchObject({
      draft: null,
    });
    expect(
      (await app.request("DELETE", `/v1/tasks/${taskId}/document/draft?clientSeq=-1`, { session }))
        .status,
    ).toBe(400);
  });

  it("requires a session, CSRF, ownership, admitted access and an active task", async () => {
    const app = await boot();
    const { id: ownerId, session } = await app.createSignedInUser();
    const taskId = await createTask(app, ownerId);
    const saved = documentPublishResponseSchema.parse(
      (await save(app, session, taskId, { baseRevision: null, markdown: "# Private plan" })).json(),
    );

    expect((await app.get(`/v1/tasks/${taskId}/document`)).status).toBe(401);
    const noCsrf = await app.post(`/v1/tasks/${taskId}/document/commits`, {
      session,
      csrf: null,
      idempotencyKey: key(),
      body: { baseRevision: null, markdown: "x" },
    });
    expect(noCsrf.status).toBe(403);

    const intruder = await app.createSignedInUser();
    const foreign = await app.get(`/v1/tasks/${taskId}/document`, { session: intruder.session });
    expect(foreign.status).toBe(404);
    expect(foreign.text).not.toContain("Private plan");
    const foreignSave = await save(app, intruder.session, taskId, {
      baseRevision: saved.revision,
      markdown: "# Hijack",
    });
    expect(foreignSave.status).toBe(404);
    const unknownTask = await app.get(`/v1/tasks/${uuidv7(app.clock.now())}/document`, { session });
    // Unknown and foreign tasks answer the same shape, without names.
    const shape = (response: typeof foreign) => {
      const { requestId: _requestId, ...rest } = response.json<{ error: { requestId: string } }>()
        .error;
      return { status: response.status, error: rest };
    };
    expect(shape(unknownTask)).toEqual(shape(foreign));
    expect((await app.get(`/v1/tasks/not-a-uuid/document`, { session })).status).toBe(400);

    await app.db.run(
      sql(
        `UPDATE tasks SET status = 'archived', archived_at = :now, archived_with_root_id = id WHERE id = :id`,
        { now: int(app.clock.now()), id: taskId },
      ),
    );
    const archived = await save(app, session, taskId, {
      baseRevision: saved.revision,
      markdown: "# Late",
    });
    expect(archived.json()).toMatchObject({ error: { code: "task.archived" } });
    expect((await app.get(`/v1/tasks/${taskId}/document`, { session })).status).toBe(200);

    const relocked = await app.createSignedInUser("relocked");
    const relockedTask = await createTask(app, relocked.id);
    expect(
      (await app.get(`/v1/tasks/${relockedTask}/document`, { session: relocked.session })).status,
    ).toBe(403);
  });

  it("removes the folded idempotency record when a save loses its race, so the key is not replayed as a success", async () => {
    const hooks: { beforePublish?: () => Promise<void> } = {};
    const app = await boot({
      overrides: [{ token: DOCUMENT_PUBLICATION_HOOKS, value: hooks as PublicationHooks }],
    });
    const { id: ownerId, session } = await app.createSignedInUser();
    const taskId = await createTask(app, ownerId);
    const base = documentPublishResponseSchema.parse(
      (await save(app, session, taskId, { baseRevision: null, markdown: "# Base" })).json(),
    );
    const service = app.inject<DocumentService>(DocumentService);
    let raced = false;
    hooks.beforePublish = async () => {
      if (raced) return;
      raced = true;
      await service.save(
        { kind: "user", userId: ownerId },
        { taskId, baseRevision: base.revision, markdown: "# Base\n\nother tab", kind: "edit" },
        { id: "competing-save" },
      );
    };
    const contested = key();
    const lost = await save(
      app,
      session,
      taskId,
      { baseRevision: base.revision, markdown: "# Base\n\nmine" },
      contested,
    );
    expect(lost.status).toBe(409);
    expect(lost.json()).toMatchObject({
      error: { code: "document.conflict", details: { currentGeneration: 2 } },
    });
    const records = await app.db.all(
      sql(`SELECT key FROM idempotency_records WHERE key = :key`, { key: contested }),
    );
    expect(records).toEqual([]);
    const head = documentHeadResponseSchema.parse(
      (await app.get(`/v1/tasks/${taskId}/document`, { session })).json(),
    );
    const retried = await save(
      app,
      session,
      taskId,
      { baseRevision: head.revision, markdown: "# Base\n\nmine" },
      contested,
    );
    expect(retried.status).toBe(201);
    expect(retried.headers.get("idempotency-replayed")).toBeNull();
  });

  it("announces head changes on the user topic, snapshots open heads and relays worker announcements from D1", async () => {
    const app = await boot();
    const { id: ownerId, session } = await app.createSignedInUser();
    const taskId = await createTask(app, ownerId);
    const saved = documentPublishResponseSchema.parse(
      (await save(app, session, taskId, { baseRevision: null, markdown: "## A\none" })).json(),
    );
    const socket = await WsTestClient.connect(app.wsUrl, {
      origin: app.config.WEB_ORIGIN,
      cookie: session.cookie,
    });
    sockets.push(socket);
    socket.send({ t: "sub", topic: "user", cursor: null, openTasks: [taskId] });
    const snapshot = await socket.waitFor((frame) => frame.t === "snapshot");
    expect(snapshot).toMatchObject({ data: { heads: { [taskId]: saved.revision } } });

    const next = documentPublishResponseSchema.parse(
      (
        await save(app, session, taskId, { baseRevision: saved.revision, markdown: "## A\ntwo" })
      ).json(),
    );
    const event = await socket.waitFor(
      (frame) => frame.t === "ev" && frame.type === "document.head_changed",
    );
    expect(event).toMatchObject({
      data: {
        taskId,
        revision: next.revision,
        author: "user",
        changedSectionIds: next.changedSectionIds,
      },
    });

    const worker = new InternalEventClient({
      keys: app.keys,
      apiOrigin: app.baseUrl,
      logger: createWorkerLogger({ info() {}, warn() {}, error() {} }),
      timers: app.clock,
    });
    const outcome = await worker.announce({
      type: "document.head_changed",
      ownerId,
      payload: {
        taskId,
        revision: next.revision as string,
        generation: 2,
        author: "simon",
        changedSectionIds: [...next.changedSectionIds],
      },
    });
    expect(outcome).toBe("delivered");
    const relayed = await socket.waitFor(
      (frame) =>
        frame.t === "ev" &&
        frame.type === "document.head_changed" &&
        Number(frame.seq) > Number(event.seq),
    );
    // The api publishes what D1 holds (author user), not the hint's claims.
    expect(relayed).toMatchObject({ data: { taskId, revision: next.revision, author: "user" } });
  });
});
