import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveResponseSchema,
  errorEnvelopeSchema,
  taskCompleteResponseSchema,
  taskCreateResponseSchema,
  taskDetailResponseSchema,
  taskMoveResponseSchema,
  taskRestoreResponseSchema,
  taskTreeResponseSchema,
} from "@symplist/contracts";
import {
  type ArchiveContributor,
  archiveGuard,
  MemoryTaskTreeCache,
  TASK_TREE_CHANGED_EVENT,
  TaskService,
} from "@symplist/core/tasks";
import { int, type LocalSqliteClient, sql } from "@symplist/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InternalEventClient } from "../../../../worker/src/infra/internal-events.ts";
import { createWorkerLogger } from "../../../../worker/src/infra/logger.ts";
import { bootTestApp, type TestApp, type TestSession, testApiEnv } from "../../../test/harness.ts";
import { WsTestClient } from "../../../test/ws-client.ts";
import { SERVER_ANALYTICS } from "../../infra/analytics/analytics.providers.ts";
import { TASK_SERVICE } from "./workspace.providers.ts";

const apps: TestApp[] = [];
const sockets: WsTestClient[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const app of apps.splice(0)) await app.close();
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

async function boot(options: Parameters<typeof bootTestApp>[0] = {}): Promise<TestApp> {
  const app = await bootTestApp(options);
  apps.push(app);
  return app;
}

let keySequence = 0;
function key(): string {
  keySequence += 1;
  return `workspace-key-${String(keySequence).padStart(8, "0")}`;
}

interface Client {
  readonly app: TestApp;
  readonly session: TestSession;
  create(body: object, idempotencyKey?: string): ReturnType<TestApp["request"]>;
  send(
    method: string,
    path: string,
    body?: object,
    idempotencyKey?: string,
  ): ReturnType<TestApp["request"]>;
  tree(collection: string): Promise<Array<string>>;
}

function client(app: TestApp, session: TestSession): Client {
  return {
    app,
    session,
    create: (body, idempotencyKey = key()) =>
      app.post("/v1/tasks", { session, body, idempotencyKey }),
    send: (method, path, body, idempotencyKey = key()) =>
      app.request(method, path, {
        session,
        ...(body === undefined ? {} : { body }),
        idempotencyKey,
      }),
    async tree(collection) {
      const response = await app.get(`/v1/tasks?collection=${collection}`, { session });
      expect(response.status).toBe(200);
      const tree = taskTreeResponseSchema.parse(response.json());
      return tree.tasks.map((task) => `${"  ".repeat(task.depth)}${task.title}`);
    },
  };
}

async function signedIn(
  app: TestApp,
  state: Parameters<TestApp["createSignedInUser"]>[0] = "admitted",
) {
  const user = await app.createSignedInUser(state);
  return { ...client(app, user.session), id: user.id };
}

async function created(user: Client, body: object): Promise<string> {
  const response = await user.create(body);
  expect(response.status, response.text).toBe(201);
  return taskCreateResponseSchema.parse(response.json()).task.id;
}

function code(response: { json<T>(): T }): string {
  return errorEnvelopeSchema.parse(response.json()).error.code;
}

describe("task routes (§2.1)", () => {
  it("creates, lists, renames, moves, completes and restores over HTTP", async () => {
    const app = await boot();
    const maya = await signedIn(app);
    const portfolio = await created(maya, { title: "Refresh my portfolio", collection: "now" });
    const pick = await created(maya, {
      title: "Pick five projects to feature",
      parentId: portfolio,
    });
    await created(maya, { title: "Rewrite the about page", parentId: portfolio });
    const outline = await created(maya, { title: "Send the project outline", collection: "now" });
    await created(maya, { title: "Book a bike tune-up", collection: "now" });
    expect(await maya.tree("now")).toEqual([
      "Refresh my portfolio",
      "  Pick five projects to feature",
      "  Rewrite the about page",
      "Send the project outline",
      "Book a bike tune-up",
    ]);

    const detail = await app.get(`/v1/tasks/${pick}`, { session: maya.session });
    expect(taskDetailResponseSchema.parse(detail.json())).toMatchObject({
      task: { id: pick, status: "active", parentId: portfolio },
      ancestors: [{ id: portfolio, title: "Refresh my portfolio", status: "active" }],
    });

    const renamed = await maya.send("PATCH", `/v1/tasks/${outline}`, { title: "Send the outline" });
    expect(renamed.status).toBe(200);
    expect(renamed.json()).toEqual({ taskId: outline, title: "Send the outline", version: 2 });

    const moved = await maya.send("POST", `/v1/tasks/${pick}/move`, { collection: "later" });
    expect(moved.status).toBe(200);
    expect(taskMoveResponseSchema.parse(moved.json())).toMatchObject({
      parentId: null,
      collection: "later",
      previous: { collection: "now", parentId: portfolio, afterId: null },
    });
    expect(await maya.tree("later")).toEqual(["Pick five projects to feature"]);

    const completed = await maya.send("POST", `/v1/tasks/${portfolio}/complete`, {
      mode: "parent_only",
      stopRun: false,
    });
    expect(completed.status).toBe(200);
    expect(taskCompleteResponseSchema.parse(completed.json()).mode).toBe("parent_only");
    expect(await maya.tree("now")).toEqual([
      "Rewrite the about page",
      "Send the outline",
      "Book a bike tune-up",
    ]);

    const archive = await app.get("/v1/archive?timeZone=America%2FLos_Angeles", {
      session: maya.session,
    });
    expect(archive.status).toBe(200);
    const page = archiveResponseSchema.parse(archive.json());
    expect(page.groups.flatMap((group) => group.tasks.map((task) => task.title))).toEqual([
      "Refresh my portfolio",
    ]);

    const restored = await maya.send("POST", `/v1/tasks/${portfolio}/restore`);
    expect(restored.status).toBe(200);
    expect(taskRestoreResponseSchema.parse(restored.json())).toMatchObject({
      restoredTaskIds: [portfolio],
      collection: "now",
      fallback: "none",
    });
    // A promoted subtask took the parent's slot, so the restored parent follows it.
    expect((await maya.tree("now")).slice(0, 2)).toEqual([
      "Rewrite the about page",
      "Refresh my portfolio",
    ]);
  });

  it("stores titles only as ciphertext and never logs them", async () => {
    const app = await boot();
    const maya = await signedIn(app);
    const title = "MARKER-3c1f Choose portfolio photos";
    const id = await created(maya, { title, collection: "now" });
    await maya.send("PATCH", `/v1/tasks/${id}`, { title: `${title} again` });
    await maya.send("POST", `/v1/tasks/${id}/complete`, { mode: "all", stopRun: false });
    expect(await app.scanDatabaseFor("MARKER-3c1f")).toEqual([]);
    expect(app.logs.text()).not.toContain("MARKER-3c1f");
  });

  it("replays exact retries, refuses reused keys and requires a key", async () => {
    const app = await boot();
    const maya = await signedIn(app);
    const idempotencyKey = key();
    const first = await maya.create(
      { title: "Plan a quiet weekend", collection: "later" },
      idempotencyKey,
    );
    const retry = await maya.create(
      { title: "Plan a quiet weekend", collection: "later" },
      idempotencyKey,
    );
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.headers.get("idempotency-replayed")).toBe("true");
    expect(retry.json()).toEqual(first.json());
    expect(await maya.tree("later")).toEqual(["Plan a quiet weekend"]);

    const mismatch = await maya.create(
      { title: "Something else", collection: "later" },
      idempotencyKey,
    );
    expect(mismatch.status).toBe(422);
    expect(code(mismatch)).toBe("idempotency.mismatch");

    const missing = await app.post("/v1/tasks", {
      session: maya.session,
      body: { title: "No key", collection: "now" },
    });
    expect(missing.status).toBe(400);
    expect(code(missing)).toBe("idempotency.key_required");

    // Completing twice with the same key returns the first result, not task.archived.
    const id = taskCreateResponseSchema.parse(first.json()).task.id;
    const completeKey = key();
    const done = await maya.send(
      "POST",
      `/v1/tasks/${id}/complete`,
      { mode: "all", stopRun: false },
      completeKey,
    );
    const again = await maya.send(
      "POST",
      `/v1/tasks/${id}/complete`,
      { mode: "all", stopRun: false },
      completeKey,
    );
    expect(again.status).toBe(200);
    expect(again.json()).toEqual(done.json());
    const other = await maya.send("POST", `/v1/tasks/${id}/complete`, {
      mode: "all",
      stopRun: false,
    });
    expect(other.status).toBe(409);
    expect(code(other)).toBe("task.archived");
  });

  it("validates input without echoing it", async () => {
    const app = await boot();
    const maya = await signedIn(app);
    const secret = "MARKER-77aa";
    for (const body of [
      { title: `${secret}\nsecond line`, collection: "now" },
      { title: "   ", collection: "now" },
      { title: "x".repeat(501), collection: "now" },
      { title: "No place" },
      { title: secret, collection: "someday" },
      { title: secret, collection: "now", afterId: "not-a-uuid" },
    ]) {
      const response = await maya.create(body);
      expect(response.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect(code(response)).toBe("validation");
      expect(response.text).not.toContain(secret);
    }
    const badQuery = await app.get("/v1/tasks?collection=inbox", { session: maya.session });
    expect(badQuery.status).toBe(400);
    const badId = await app.get("/v1/tasks/1234", { session: maya.session });
    expect(badId.status).toBe(400);
    const badZone = await app.get("/v1/archive?timeZone=Mars%2FOlympus", { session: maya.session });
    expect(badZone.status).toBe(400);
    expect(errorEnvelopeSchema.parse(badZone.json()).error.details).toMatchObject({
      issues: [{ path: ["timeZone"] }],
    });
  });

  it("answers placement, depth and archived refusals with stable codes", async () => {
    const app = await boot();
    const maya = await signedIn(app);
    const parent = await created(maya, { title: "Parent", collection: "now" });
    const child = await created(maya, { title: "Child", parentId: parent });
    const cycle = await maya.send("POST", `/v1/tasks/${parent}/move`, { parentId: child });
    expect(cycle.status).toBe(422);
    expect(errorEnvelopeSchema.parse(cycle.json()).error).toMatchObject({
      code: "task.placement_invalid",
      details: { reason: "cycle" },
    });
    await maya.send("POST", `/v1/tasks/${parent}/complete`, { mode: "all", stopRun: false });
    const archivedRename = await maya.send("PATCH", `/v1/tasks/${child}`, { title: "Late" });
    expect(archivedRename.status).toBe(409);
    expect(code(archivedRename)).toBe("task.archived");
    const underArchived = await maya.create({ title: "Sub", parentId: parent });
    expect(underArchived.status).toBe(409);
    expect(code(underArchived)).toBe("task.archived");
  });
});

describe("restoring an active task", () => {
  it("records the unchanged placement so a retried Undo replays it", async () => {
    const app = await boot();
    const maya = await signedIn(app);
    const id = await created(maya, { title: "Book a bike tune-up", collection: "later" });
    const undoKey = key();
    const first = await maya.send("POST", `/v1/tasks/${id}/restore`, undefined, undoKey);
    expect(first.status).toBe(200);
    expect(first.json()).toMatchObject({
      restoredTaskIds: [],
      collection: "later",
      fallback: "none",
    });
    const retry = await maya.send("POST", `/v1/tasks/${id}/restore`, undefined, undoKey);
    expect(retry.status).toBe(200);
    expect(retry.headers.get("idempotency-replayed")).toBe("true");
    expect(retry.json()).toEqual(first.json());
    expect(
      await app.db.all(
        sql(`SELECT status FROM idempotency_records WHERE key = :key`, { key: undoKey }),
      ),
    ).toEqual([{ status: "completed" }]);
  });
});

describe("access and ownership", () => {
  it("hides other owners' tasks behind the same not_found", async () => {
    const app = await boot();
    const maya = await signedIn(app);
    const other = await signedIn(app);
    const id = await created(maya, { title: "Private", collection: "now" });
    const unknown = "0192f0a0-0000-7000-8000-0000000000ff";
    for (const target of [id, unknown]) {
      const read = await app.get(`/v1/tasks/${target}`, { session: other.session });
      const rename = await other.send("PATCH", `/v1/tasks/${target}`, { title: "Mine now" });
      const move = await other.send("POST", `/v1/tasks/${target}/move`, { collection: "later" });
      const complete = await other.send("POST", `/v1/tasks/${target}/complete`, {
        mode: "all",
        stopRun: false,
      });
      const restore = await other.send("POST", `/v1/tasks/${target}/restore`);
      const subtask = await other.create({ title: "Under yours", parentId: target });
      for (const response of [read, rename, move, complete, restore, subtask]) {
        expect(response.status).toBe(404);
        expect(errorEnvelopeSchema.parse(response.json()).error).toEqual({
          code: "not_found",
          message: "Not found",
          requestId: expect.any(String),
        });
      }
    }
    expect(await other.tree("now")).toEqual([]);
    expect(await maya.tree("now")).toEqual(["Private"]);
  });

  it("requires a session, the CSRF token, the web origin and admitted access", async () => {
    const app = await boot();
    const maya = await signedIn(app);
    const body = { title: "Nope", collection: "now" };
    const anonymous = await app.get("/v1/tasks?collection=now");
    expect(anonymous.status).toBe(401);
    const noCsrf = await app.post("/v1/tasks", {
      session: maya.session,
      body,
      csrf: null,
      idempotencyKey: key(),
    });
    expect(noCsrf.status).toBe(403);
    expect(code(noCsrf)).toBe("auth.csrf_invalid");
    const noOrigin = await app.post("/v1/tasks", {
      session: maya.session,
      body,
      origin: null,
      idempotencyKey: key(),
    });
    expect(noOrigin.status).toBe(403);
    for (const [state, expected] of [
      ["locked", "access.locked"],
      ["relocked", "access.relocked"],
      ["suspended", "access.suspended"],
      ["unverified", "access.unverified"],
    ] as const) {
      const user = await signedIn(app, state);
      const list = await app.get("/v1/tasks?collection=now", { session: user.session });
      const create = await user.create(body);
      expect([list.status, create.status]).toEqual([403, 403]);
      expect(code(create)).toBe(expected);
    }
    expect(await app.scanDatabaseFor("Nope")).toEqual([]);
  });

  it("refuses a write in its batch when access was taken away after the session was cached", async () => {
    const app = await boot();
    const maya = await signedIn(app);
    await maya.tree("now");
    await app.db.run(
      sql(
        `UPDATE users SET beta_state = 'relocked', access_generation = access_generation + 1 WHERE id = :id`,
        {
          id: maya.id,
        },
      ),
    );
    const response = await maya.create({ title: "Too late", collection: "now" });
    expect(response.status).toBe(403);
    expect(code(response)).toBe("access.relocked");
    expect(await app.db.all(sql(`SELECT id FROM tasks`))).toEqual([]);
  });

  it("refuses a write that changes nothing after a relock, recording no response", async () => {
    const app = await boot();
    const maya = await signedIn(app);
    // Restoring an active task changes nothing, so it has no row or version to be refused by: the
    // batch must still carry the access check, or a relocked account would get a recorded 200.
    const id = await created(maya, { title: "Already here", collection: "now" });
    await app.db.run(
      sql(
        `UPDATE users SET beta_state = 'relocked', access_generation = access_generation + 1 WHERE id = :id`,
        { id: maya.id },
      ),
    );
    const undoKey = key();
    const response = await maya.send("POST", `/v1/tasks/${id}/restore`, undefined, undoKey);
    expect(response.status).toBe(403);
    expect(code(response)).toBe("access.relocked");
    expect(
      await app.db.all(
        sql(`SELECT status FROM idempotency_records WHERE key = :key`, { key: undoKey }),
      ),
    ).toEqual([]);
  });
});

describe("D1 requests and the tree cache (§3.1, §3.3)", () => {
  it("uses one D1 request per call once the tree is cached", async () => {
    const app = await boot();
    const maya = await signedIn(app);
    await maya.tree("now");
    await maya.tree("now");
    const spy = vi.spyOn(app.db, "batch");
    const count = async (work: () => Promise<unknown>) => {
      const before = spy.mock.calls.length;
      await work();
      return spy.mock.calls.length - before;
    };
    let id = "";
    expect(
      await count(async () => {
        id = await created(maya, { title: "One", collection: "now" });
      }),
    ).toBe(1);
    expect(await count(() => maya.tree("now"))).toBe(0);
    expect(await count(() => maya.send("PATCH", `/v1/tasks/${id}`, { title: "Uno" }))).toBe(1);
    expect(
      await count(() => maya.send("POST", `/v1/tasks/${id}/move`, { collection: "later" })),
    ).toBe(1);
    expect(
      await count(() =>
        maya.send("POST", `/v1/tasks/${id}/complete`, { mode: "all", stopRun: false }),
      ),
    ).toBe(1);
    expect(await count(() => maya.send("POST", `/v1/tasks/${id}/restore`))).toBe(1);
    expect(await count(() => app.get("/v1/archive", { session: maya.session }))).toBe(1);
  });

  it("stays correct across two api instances and follows worker announcements", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "symplist-workspace-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const env = testApiEnv();
    const a = await boot({ env, dataDir });
    const b = await boot({ env, dataDir, clock: a.clock });
    const user = await a.createUser();
    const sessionA = await a.signIn(user.id);
    const sessionB = { ...sessionA, csrf: b.sessions.csrfToken(sessionA.sessionId) };
    const onA = client(a, sessionA);
    const onB = client(b, sessionB);
    const ids: string[] = [];
    for (const title of ["A", "B", "C", "D"])
      ids.push(await created(onA, { title, collection: "now" }));
    await onB.tree("now");
    const [taskA, , , taskD] = ids as [string, string, string, string];

    // Both instances reorder concurrently from caches at the same version.
    const [left, right] = await Promise.all([
      onA.send("POST", `/v1/tasks/${taskD}/move`, { afterId: taskA }),
      onB.send("POST", `/v1/tasks/${ids[2]}/move`, { beforeId: taskA }),
    ]);
    expect([left.status, right.status]).toEqual([200, 200]);
    const fresh = client(a, sessionA);
    const expected = ["C", "A", "D", "B"];
    a.inject<TaskService>(TASK_SERVICE).invalidate(user.id);
    expect(await fresh.tree("now")).toEqual(expected);

    // A write made elsewhere is invisible to B's cache until B is told...
    await created(onA, { title: "From A", collection: "later" });
    expect(await onB.tree("later")).toEqual([]);
    const socket = await WsTestClient.connect(b.wsUrl, {
      origin: b.config.WEB_ORIGIN,
      cookie: sessionB.cookie,
    });
    sockets.push(socket);
    socket.send({ t: "sub", topic: "user", cursor: null, openTasks: [] });
    const snapshot = await socket.waitFor((frame) => frame.t === "snapshot");
    expect((snapshot.data as { taskTreeVersion: number }).taskTreeVersion).toBe(7);
    // ...by the worker's signed announcement, whose ids are only hints.
    const worker = new InternalEventClient({
      keys: b.keys,
      apiOrigin: b.baseUrl,
      logger: createWorkerLogger({
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }),
      timers: b.clock,
    });
    expect(
      await worker.announce({
        type: TASK_TREE_CHANGED_EVENT,
        ownerId: user.id,
        payload: {
          taskTreeVersion: 999,
          taskIds: [ids[0] as string, "0192f0a0-0000-7000-8000-0000000000ff"],
        },
      }),
    ).toBe("delivered");
    const event = await socket.waitFor((frame) => frame.t === "ev");
    expect(event).toMatchObject({
      type: "tasks.changed",
      data: { taskTreeVersion: 7, taskIds: [ids[0]] },
    });
    expect(await onB.tree("later")).toEqual(["From A"]);
  });

  it("publishes tasks.changed to the owner's sockets only", async () => {
    const app = await boot();
    const maya = await signedIn(app);
    const other = await signedIn(app);
    const mine = await WsTestClient.connect(app.wsUrl, {
      origin: app.config.WEB_ORIGIN,
      cookie: maya.session.cookie,
    });
    const theirs = await WsTestClient.connect(app.wsUrl, {
      origin: app.config.WEB_ORIGIN,
      cookie: other.session.cookie,
    });
    sockets.push(mine, theirs);
    for (const socket of [mine, theirs]) {
      socket.send({ t: "sub", topic: "user", cursor: null, openTasks: [] });
      const snapshot = await socket.waitFor((frame) => frame.t === "snapshot");
      expect(snapshot.data).toMatchObject({ taskTreeVersion: 0 });
    }
    const id = await created(maya, { title: "Watched", collection: "now" });
    const event = await mine.waitFor((frame) => frame.t === "ev");
    expect(event).toMatchObject({
      topic: "user",
      type: "tasks.changed",
      data: { taskTreeVersion: 1, taskIds: [id] },
    });
    await theirs.settle();
    expect(theirs.frames.filter((frame) => frame.t === "ev")).toEqual([]);
    expect(JSON.stringify(event)).not.toContain("Watched");
  });
});

describe("completion with an active run (injected run-state check)", () => {
  it("refuses with task.run_active and stops the run when asked", async () => {
    let target: TaskService | undefined;
    const lazy = new Proxy({} as TaskService, {
      get: (_object, property) => {
        if (!target) return undefined;
        const service = target as unknown as Record<PropertyKey, unknown>;
        const value = service[property];
        return typeof value === "function" ? value.bind(service) : value;
      },
    });
    const app = await boot({ overrides: [{ token: TASK_SERVICE, value: lazy }] });
    const db = app.db as LocalSqliteClient;
    await db.executeScript(
      `CREATE TABLE probe_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL) STRICT;`,
    );
    // The probe uses the id queries, so a completion archiving more tasks than D1's 100 statement
    // parameters still decides in one statement.
    const simon: ArchiveContributor = {
      domain: "simon",
      blockingCondition: ({ taskIdsQuery }) => ({
        sql: `EXISTS (SELECT 1 FROM probe_runs WHERE task_id IN (${taskIdsQuery.sql}) AND status IN ('queued', 'running', 'awaiting_approval', 'awaiting_user'))`,
        params: taskIdsQuery.params,
      }),
      statements: (input) => {
        const guard = archiveGuard(input);
        return [
          sql(
            `UPDATE probe_runs SET status = 'stopped' WHERE task_id IN (${input.archivedTaskIds.sql}) AND status IN ('queued', 'running') AND ${guard.exists}`,
            { ...input.archivedTaskIds.params, ...guard.params },
          ),
        ];
      },
    };
    target = new TaskService({
      db,
      keys: app.keys,
      policy: { betaAccessRequired: true },
      now: () => app.clock.now(),
      cache: new MemoryTaskTreeCache({ now: () => app.clock.now() }),
      archiveContributors: [simon],
    });
    const maya = await signedIn(app);
    const id = await created(maya, { title: "Send the project outline", collection: "now" });
    let deepest = id;
    for (let index = 0; index < 120; index += 1) {
      const subtask = await created(maya, {
        title: `Step ${index}`,
        parentId: index % 4 === 0 && index < 100 ? deepest : id,
      });
      if (index % 4 === 0 && index < 100) deepest = subtask;
    }
    await db.run(
      sql(`INSERT INTO probe_runs (id, task_id, status) VALUES ('run-1', :task, 'running')`, {
        task: deepest,
      }),
    );
    const refused = await maya.send("POST", `/v1/tasks/${id}/complete`, {
      mode: "all",
      stopRun: false,
    });
    expect(refused.status).toBe(409);
    expect(code(refused)).toBe("task.run_active");
    expect(await maya.tree("now")).toHaveLength(121);
    const stopped = await maya.send("POST", `/v1/tasks/${id}/complete`, {
      mode: "all",
      stopRun: true,
    });
    expect(stopped.status).toBe(200);
    expect(taskCompleteResponseSchema.parse(stopped.json()).archivedTaskIds).toHaveLength(121);
    expect(await db.all(sql(`SELECT status FROM probe_runs`))).toEqual([{ status: "stopped" }]);
    expect(await maya.tree("now")).toEqual([]);
  });
});

describe("server analytics (§15)", () => {
  it("captures task_created, task_moved and task_completed only with consent, without content", async () => {
    const captures: unknown[] = [];
    const analytics = {
      enabled: true,
      capture: async (input: unknown) => {
        captures.push(input);
        return { status: "queued" as const };
      },
      flush: async () => undefined,
      shutdown: async () => undefined,
    };
    const app = await boot({ overrides: [{ token: SERVER_ANALYTICS, value: analytics }] });
    const maya = await signedIn(app);
    const id = await created(maya, { title: "Plan a quiet weekend", collection: "now" });
    await app.db.run(
      sql(
        `UPDATE users SET analytics_consent = 'granted', analytics_consent_at = :now, analytics_id = 'a-1' WHERE id = :id`,
        {
          now: int(app.clock.now()),
          id: maya.id,
        },
      ),
    );
    const sub = await created(maya, { title: "Farmers market", parentId: id });
    await maya.send("POST", `/v1/tasks/${id}/move`, { collection: "later" });
    await maya.send("POST", `/v1/tasks/${id}/complete`, { mode: "parent_only", stopRun: false });
    void sub;
    expect(captures).toHaveLength(4);
    expect(captures.map((entry) => (entry as { event: string }).event)).toEqual([
      "task_created",
      "task_created",
      "task_moved",
      "task_completed",
    ]);
    expect(captures[1]).toMatchObject({
      subject: { consent: "granted", analyticsId: "a-1" },
      properties: { source: "user", collection: "now", is_subtask: true },
    });
    expect(captures[0]).toMatchObject({ subject: { consent: "unset" } });
    expect(captures[2]).toMatchObject({
      properties: { from_collection: "now", to_collection: "later", source: "user" },
    });
    expect(captures[3]).toMatchObject({ properties: { collection: "later", mode: "parent_only" } });
    expect(JSON.stringify(captures)).not.toContain("quiet weekend");
  });
});
