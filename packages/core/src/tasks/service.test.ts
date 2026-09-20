import { randomBytes } from "node:crypto";
import { taskNodeSchema } from "@symplist/contracts";
import { createKeyProvider, keyFamilies, type ManagedKeyProvider } from "@symplist/crypto";
import {
  applyMigrations,
  createLocalSqliteClient,
  type DbClient,
  int,
  type LocalSqliteClient,
  sql,
  uuidv7,
} from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountKeyStore } from "../account/keys.ts";
import { IdempotencyStore } from "../idempotency/store.ts";
import { ARCHIVE_MEMBERS_PER_GROUP } from "./archive.ts";
import type { ArchiveContributor } from "./archive-contributors/types.ts";
import { archiveGuard } from "./archive-runner.ts";
import type { TaskAuthorization } from "./authorization.ts";
import { TaskOperationError } from "./errors.ts";
import { POSITION_REBALANCE_LENGTH, restorableCollection } from "./plans.ts";
import { type TaskActor, TaskService, type TaskWriteFold } from "./service.ts";
import { onTaskTreeCommitted, type TaskTreeCommit } from "./signals.ts";
import { activeTaskGuard, activeTaskGuardFailure } from "./sql.ts";
import { MemoryTaskTreeCache, TaskTreeLoader } from "./state.ts";

const start = Date.UTC(2026, 8, 15, 9, 0, 0);
let clock = start;
const now = () => clock;
let db: LocalSqliteClient;
let keys: ManagedKeyProvider;
const user: TaskActor = { kind: "user" };

async function insertUser(options: { beta?: string } = {}): Promise<string> {
  const id = uuidv7(clock);
  await db.batch([
    sql(
      `INSERT INTO users (id, email, email_verified_at, beta_state, onboarding_step, created_at, updated_at, write_id)
       VALUES (:id, :email, :now, :beta, 'done', :now, :now, :w)`,
      {
        id,
        email: `${id}@example.test`,
        now: int(clock),
        beta: options.beta ?? "unlocked",
        w: uuidv7(clock),
      },
    ),
    new AccountKeyStore({ db, keys }).provisionStatement({ userId: id, now: clock }),
  ]);
  return id;
}

function service(
  options: { cache?: boolean; contributors?: ArchiveContributor[]; db?: DbClient } = {},
) {
  return new TaskService({
    db: options.db ?? db,
    keys,
    policy: { betaAccessRequired: true },
    now,
    ...(options.cache === false ? {} : { cache: new MemoryTaskTreeCache({ now }) }),
    archiveContributors: options.contributors ?? [],
  });
}

function applied<Body>(result: { kind: string; body?: unknown }): Body {
  if (result.kind !== "applied") throw new Error(`expected an applied write, got ${result.kind}`);
  return result.body as Body;
}

async function create(
  tasks: TaskService,
  owner: string,
  title: string,
  extra: Partial<Parameters<TaskService["create"]>[0]> = {},
): Promise<string> {
  clock += 1;
  const result = await tasks.create({ ownerId: owner, actor: user, title, ...extra });
  return applied<{ task: { id: string } }>(result).task.id;
}

async function titles(
  tasks: TaskService,
  owner: string,
  collection: "now" | "later" | "unclassified",
) {
  const tree = await tasks.listCollection(owner, collection);
  return tree.tasks.map((task) => `${"  ".repeat(task.depth)}${task.title}`);
}

async function rows(owner: string) {
  return db.all<{
    id: string;
    parent_id: string | null;
    collection: string;
    position: string;
    status: string;
    archived_with_root_id: string | null;
    version: number;
    title_enc: string;
  }>(sql(`SELECT * FROM tasks WHERE owner_id = :owner`, { owner }));
}

async function expectRefused(promise: Promise<unknown>, code: string, details?: object) {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(TaskOperationError);
  expect((error as TaskOperationError).code).toBe(code);
  if (details) expect((error as TaskOperationError).details).toEqual(details);
}

/** A cached state must equal what a fresh read returns. */
async function expectCacheExact(tasks: TaskService, owner: string) {
  const cached = await tasks.state(owner);
  const fresh = await new TaskTreeLoader({ db, keys }).load(owner);
  expect(cached.version).toBe(fresh.version);
  const strip = (state: typeof cached) =>
    [...state.tree.byId.values()]
      .map((record) => ({ ...record }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  expect(strip(cached)).toEqual(strip(fresh));
}

beforeEach(async () => {
  clock = start;
  db = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
  await applyMigrations(db);
  keys = createKeyProvider(
    Object.fromEntries(
      keyFamilies.map((family) => [
        family,
        { current: 1, versions: new Map([[1, randomBytes(32)]]) },
      ]),
    ),
  );
});

afterEach(() => {
  db.close();
  keys.destroy();
});

describe("creating tasks", () => {
  it("creates inline in a collection and as subtasks, encrypting titles at rest", async () => {
    const owner = await insertUser();
    const tasks = service();
    const first = await create(tasks, owner, "Refresh my portfolio", { collection: "now" });
    await create(tasks, owner, "Send the project outline", { collection: "now" });
    await create(tasks, owner, "Book a bike tune-up", { collection: "now" });
    const child = await create(tasks, owner, "Pick five projects to feature", { parentId: first });
    await create(tasks, owner, "Rewrite the about page", { parentId: first });
    await create(tasks, owner, "Pick photos", { parentId: child });
    await create(tasks, owner, "Plan a quiet weekend", { collection: "later" });
    await create(tasks, owner, "Before everything", { collection: "now", placement: "start" });
    const outline = (await tasks.listCollection(owner, "now")).tasks.find(
      (task) => task.title === "Send the project outline",
    );
    await create(tasks, owner, "After the outline", { collection: "now", afterId: outline?.id });

    expect(await titles(tasks, owner, "now")).toEqual([
      "Before everything",
      "Refresh my portfolio",
      "  Pick five projects to feature",
      "    Pick photos",
      "  Rewrite the about page",
      "Send the project outline",
      "After the outline",
      "Book a bike tune-up",
    ]);
    expect(await titles(tasks, owner, "later")).toEqual(["Plan a quiet weekend"]);

    const tree = await tasks.listCollection(owner, "now");
    for (const node of tree.tasks) expect(taskNodeSchema.parse(node)).toEqual(node);
    expect(tree.taskTreeVersion).toBe(9);
    expect(tree.tasks.find((task) => task.id === first)?.childCount).toBe(2);

    for (const row of await rows(owner)) {
      expect(row.title_enc.startsWith("sym1.")).toBe(true);
      expect(row.title_enc).not.toContain("portfolio");
    }
    const intents = await db.all(
      sql(`SELECT entity, op, revision_or_seq FROM search_intents WHERE owner_id = :owner`, {
        owner,
      }),
    );
    expect(intents).toHaveLength(9);
    expect(intents.every((row) => row.entity === "task" && row.op === "upsert")).toBe(true);
    await expectCacheExact(tasks, owner);
  });

  it("uses one D1 request per write and none per read once the tree is cached", async () => {
    const owner = await insertUser();
    const tasks = service();
    await tasks.listCollection(owner, "now");
    const spy = vi.spyOn(db, "batch");
    const id = await create(tasks, owner, "One", { collection: "now" });
    await create(tasks, owner, "Two", { collection: "now" });
    clock += 1;
    await tasks.rename({ ownerId: owner, taskId: id, title: "One renamed" });
    clock += 1;
    await tasks.move({ ownerId: owner, actor: user, taskId: id, collection: "later" });
    clock += 1;
    await tasks.complete({ ownerId: owner, taskId: id, mode: "all", stopRun: false });
    clock += 1;
    await tasks.restore({ ownerId: owner, taskId: id });
    expect(spy).toHaveBeenCalledTimes(6);
    await tasks.listCollection(owner, "later");
    expect(spy).toHaveBeenCalledTimes(6);
    await expectCacheExact(tasks, owner);
  });

  it("refuses unknown, foreign and archived parents and too deep nesting", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const tasks = service();
    const foreign = await create(tasks, other, "Theirs", { collection: "now" });
    await expectRefused(
      tasks.create({ ownerId: owner, actor: user, title: "x", parentId: foreign }),
      "not_found",
    );
    const parent = await create(tasks, owner, "Parent", { collection: "now" });
    await tasks.complete({ ownerId: owner, taskId: parent, mode: "all", stopRun: false });
    await expectRefused(
      tasks.create({ ownerId: owner, actor: user, title: "x", parentId: parent }),
      "task.archived",
    );
    let deepest = await create(tasks, owner, "Level 0", { collection: "now" });
    for (let depth = 1; depth < 32; depth += 1) {
      deepest = await create(tasks, owner, `Level ${depth}`, { parentId: deepest });
    }
    await expectRefused(
      tasks.create({ ownerId: owner, actor: user, title: "Too deep", parentId: deepest }),
      "task.depth_limit",
    );
    await expectRefused(
      tasks.create({
        ownerId: owner,
        actor: user,
        title: "x",
        collection: "later",
        parentId: deepest,
      }),
      "task.placement_invalid",
      { reason: "collection_mismatch" },
    );
  });

  it("refuses writes once access is taken away, inside the batch", async () => {
    const owner = await insertUser();
    const tasks = service();
    const id = await create(tasks, owner, "Mine", { collection: "now" });
    await db.run(
      sql(
        `UPDATE users SET beta_state = 'relocked', access_generation = access_generation + 1 WHERE id = :id`,
        {
          id: owner,
        },
      ),
    );
    await expectRefused(
      tasks.create({ ownerId: owner, actor: user, title: "x", collection: "now" }),
      "access.relocked",
    );
    await expectRefused(
      tasks.rename({ ownerId: owner, taskId: id, title: "x" }),
      "access.relocked",
    );
    expect(await rows(owner)).toHaveLength(1);
  });

  it("renumbers a list instead of growing keys without bound", async () => {
    const owner = await insertUser();
    const tasks = service();
    for (let index = 0; index < 400; index += 1) {
      await create(tasks, owner, `Task ${index}`, { collection: "now", placement: "start" });
    }
    const all = await rows(owner);
    expect(Math.max(...all.map((row) => row.position.length))).toBeLessThanOrEqual(
      POSITION_REBALANCE_LENGTH,
    );
    const tree = await titles(tasks, owner, "now");
    expect(tree[0]).toBe("Task 399");
    expect(tree[399]).toBe("Task 0");
    await expectCacheExact(tasks, owner);
  });
});

describe("renaming", () => {
  it("renames active tasks only, for their owner only", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const tasks = service();
    const id = await create(tasks, owner, "Old", { collection: "now" });
    clock += 1;
    const result = await tasks.rename({ ownerId: owner, taskId: id, title: "New" });
    expect(applied(result)).toEqual({ taskId: id, title: "New", version: 2 });
    expect((await tasks.listCollection(owner, "now")).tasks[0]?.title).toBe("New");
    await expectRefused(tasks.rename({ ownerId: other, taskId: id, title: "Stolen" }), "not_found");
    await tasks.complete({ ownerId: owner, taskId: id, mode: "all", stopRun: false });
    await expectRefused(
      tasks.rename({ ownerId: owner, taskId: id, title: "Late" }),
      "task.archived",
    );
    await expectCacheExact(tasks, owner);
  });
});

describe("moving and reordering", () => {
  it("carries descendants to another collection when a parent moves", async () => {
    const owner = await insertUser();
    const tasks = service();
    const parent = await create(tasks, owner, "Parent", { collection: "now" });
    const child = await create(tasks, owner, "Child", { parentId: parent });
    const grandchild = await create(tasks, owner, "Grandchild", { parentId: child });
    await create(tasks, owner, "Existing later", { collection: "later" });
    clock += 1;
    const moved = applied<{ movedTaskIds: string[]; previous: object }>(
      await tasks.move({ ownerId: owner, actor: user, taskId: parent, collection: "later" }),
    );
    expect(moved.movedTaskIds).toEqual([parent, child, grandchild]);
    expect(moved.previous).toEqual({ collection: "now", parentId: null, afterId: null });
    expect(await titles(tasks, owner, "later")).toEqual([
      "Existing later",
      "Parent",
      "  Child",
      "    Grandchild",
    ]);
    expect(await titles(tasks, owner, "now")).toEqual([]);
    const stored = await rows(owner);
    expect(stored.filter((row) => row.collection === "later")).toHaveLength(4);
    await expectCacheExact(tasks, owner);
  });

  it("makes a subtask top level when it moves to another collection (P3)", async () => {
    const owner = await insertUser();
    const tasks = service();
    const parent = await create(tasks, owner, "Parent", { collection: "now" });
    const child = await create(tasks, owner, "Child", { parentId: parent });
    await create(tasks, owner, "Grandchild", { parentId: child });
    clock += 1;
    const moved = applied<{ parentId: string | null; previous: { parentId: string } }>(
      await tasks.move({ ownerId: owner, actor: user, taskId: child, collection: "unclassified" }),
    );
    expect(moved.parentId).toBeNull();
    expect(moved.previous.parentId).toBe(parent);
    expect(await titles(tasks, owner, "unclassified")).toEqual(["Child", "  Grandchild"]);
    expect(await titles(tasks, owner, "now")).toEqual(["Parent"]);
    // Undo: move it back under its parent.
    clock += 1;
    await tasks.move({ ownerId: owner, actor: user, taskId: child, parentId: parent });
    expect(await titles(tasks, owner, "now")).toEqual(["Parent", "  Child", "    Grandchild"]);
    await expectCacheExact(tasks, owner);
  });

  it("reorders with neighbours and refuses impossible places", async () => {
    const owner = await insertUser();
    const tasks = service();
    const a = await create(tasks, owner, "A", { collection: "now" });
    const b = await create(tasks, owner, "B", { collection: "now" });
    const c = await create(tasks, owner, "C", { collection: "now" });
    const later = await create(tasks, owner, "Later", { collection: "later" });
    clock += 1;
    await tasks.move({ ownerId: owner, actor: user, taskId: c, afterId: a });
    expect(await titles(tasks, owner, "now")).toEqual(["A", "C", "B"]);
    clock += 1;
    await tasks.move({ ownerId: owner, actor: user, taskId: a, beforeId: b, afterId: c });
    expect(await titles(tasks, owner, "now")).toEqual(["C", "A", "B"]);
    clock += 1;
    await tasks.move({ ownerId: owner, actor: user, taskId: b, parentId: c });
    expect(await titles(tasks, owner, "now")).toEqual(["C", "  B", "A"]);

    await expectRefused(
      tasks.move({ ownerId: owner, actor: user, taskId: c, parentId: b }),
      "task.placement_invalid",
      { reason: "cycle" },
    );
    await expectRefused(
      tasks.move({ ownerId: owner, actor: user, taskId: c, parentId: c }),
      "task.placement_invalid",
      { reason: "cycle" },
    );
    await expectRefused(
      tasks.move({ ownerId: owner, actor: user, taskId: a, afterId: later, collection: "now" }),
      "task.placement_invalid",
      { reason: "collection_mismatch" },
    );
    await expectRefused(
      tasks.move({ ownerId: owner, actor: user, taskId: a, afterId: b, parentId: null }),
      "task.placement_invalid",
      { reason: "neighbour_not_sibling" },
    );
    await expectRefused(
      tasks.move({ ownerId: owner, actor: user, taskId: a, afterId: a }),
      "task.placement_invalid",
      { reason: "neighbour_not_sibling" },
    );
    const d = await create(tasks, owner, "D", { collection: "now" });
    await expectRefused(
      tasks.move({ ownerId: owner, actor: user, taskId: d, afterId: a, beforeId: c }),
      "task.placement_invalid",
      { reason: "neighbours_not_adjacent" },
    );
    await expectCacheExact(tasks, owner);
  });

  it("keeps positions distinct and ordered under concurrent reorders from stale trees", async () => {
    const owner = await insertUser();
    const seed = service({ cache: false });
    const ids: string[] = [];
    for (const title of ["A", "B", "C", "D", "E"])
      ids.push(await create(seed, owner, title, { collection: "now" }));
    const [a, b, c, d, e] = ids as [string, string, string, string, string];
    // Two api instances, each with a cache warmed at the same version.
    const first = service();
    const second = service();
    await first.listCollection(owner, "now");
    await second.listCollection(owner, "now");
    const spy = vi.spyOn(db, "batch");
    clock += 1;
    const results = await Promise.all([
      first.move({ ownerId: owner, actor: user, taskId: d, afterId: a }),
      second.move({ ownerId: owner, actor: user, taskId: e, afterId: a }),
    ]);
    expect(results.map((result) => result.kind)).toEqual(["applied", "applied"]);
    // The loser saw a moved tree version, read the tree again and planned again.
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(4);
    const order = await titles(service({ cache: false }), owner, "now");
    expect(order[0]).toBe("A");
    expect(new Set(order)).toEqual(new Set(["A", "B", "C", "D", "E"]));
    expect(order.slice(1, 3).sort()).toEqual(["D", "E"]);
    const positions = (await rows(owner)).map((row) => row.position);
    expect(new Set(positions).size).toBe(5);
    void b;
    void c;
    // Each instance keeps working from its own cache: a stale one reads again on its next write.
    clock += 1;
    await first.move({ ownerId: owner, actor: user, taskId: b, beforeId: a });
    clock += 1;
    await second.move({ ownerId: owner, actor: user, taskId: c, beforeId: b });
    expect(await titles(service({ cache: false }), owner, "now")).toEqual([
      "C",
      "B",
      "A",
      ...order.slice(1, 3),
    ]);
    await expectCacheExact(second, owner);
  });

  it("gives up with task.conflict when the tree keeps changing", async () => {
    const owner = await insertUser();
    const tasks = service({ cache: false });
    const a = await create(tasks, owner, "A", { collection: "now" });
    const real = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementation(async (statements, options) => {
      if (
        statements.some((statement) =>
          statement.sql.startsWith("UPDATE users SET task_tree_version"),
        )
      ) {
        await real([
          sql(`UPDATE users SET task_tree_version = task_tree_version + 1 WHERE id = :id`, {
            id: owner,
          }),
        ]);
      }
      return real(statements, options);
    });
    await expectRefused(
      tasks.move({ ownerId: owner, actor: user, taskId: a, collection: "later" }),
      "task.conflict",
    );
    vi.restoreAllMocks();
    expect(await titles(tasks, owner, "now")).toEqual(["A"]);
  });
});

describe("completing (§2.1, P1)", () => {
  it("archives a leaf, all descendants, or only the parent while promoting its subtasks", async () => {
    const owner = await insertUser();
    const tasks = service();
    const leaf = await create(tasks, owner, "Leaf", { collection: "now" });
    const parent = await create(tasks, owner, "Parent", { collection: "now" });
    const child = await create(tasks, owner, "Child", { parentId: parent });
    const grandchild = await create(tasks, owner, "Grandchild", { parentId: child });
    const sibling = await create(tasks, owner, "Sibling", { parentId: parent });
    await create(tasks, owner, "After", { collection: "now" });

    clock += 1;
    expect(
      applied(await tasks.complete({ ownerId: owner, taskId: leaf, mode: "all", stopRun: false })),
    ).toEqual({
      taskId: leaf,
      mode: "single",
      archivedTaskIds: [leaf],
      promotedTaskIds: [],
      archivedAt: clock,
    });

    clock += 1;
    const onlyParent = applied<{ promotedTaskIds: string[]; archivedTaskIds: string[] }>(
      await tasks.complete({ ownerId: owner, taskId: parent, mode: "parent_only", stopRun: false }),
    );
    expect(onlyParent.archivedTaskIds).toEqual([parent]);
    expect(onlyParent.promotedTaskIds).toEqual([child, sibling]);
    expect(await titles(tasks, owner, "now")).toEqual([
      "Child",
      "  Grandchild",
      "Sibling",
      "After",
    ]);

    clock += 1;
    const all = applied<{ archivedTaskIds: string[] }>(
      await tasks.complete({ ownerId: owner, taskId: child, mode: "all", stopRun: false }),
    );
    expect(all.archivedTaskIds).toEqual([child, grandchild]);
    const stored = await rows(owner);
    expect(stored.find((row) => row.id === grandchild)?.archived_with_root_id).toBe(child);
    expect(stored.find((row) => row.id === parent)?.archived_with_root_id).toBe(parent);
    expect(await titles(tasks, owner, "now")).toEqual(["Sibling", "After"]);
    await expectCacheExact(tasks, owner);
  });

  it("inserts a search intent for every task a completion archives or promotes (§10.1)", async () => {
    const owner = await insertUser();
    const tasks = service();
    const parent = await create(tasks, owner, "Parent", { collection: "now" });
    const child = await create(tasks, owner, "Child", { parentId: parent });
    const grandchild = await create(tasks, owner, "Grandchild", { parentId: child });
    await db.run(sql(`DELETE FROM search_intents WHERE owner_id = :owner`, { owner }));

    clock += 1;
    await tasks.complete({ ownerId: owner, taskId: child, mode: "parent_only", stopRun: false });
    // The archived task and the subtask promoted into its place both changed, so both are indexed.
    expect(
      await db.all<{ entity_id: string; op: string }>(
        sql(`SELECT entity_id, op FROM search_intents WHERE owner_id = :owner ORDER BY entity_id`, {
          owner,
        }),
      ),
    ).toEqual(
      [
        { entity_id: child, op: "upsert" },
        { entity_id: grandchild, op: "upsert" },
      ].sort((a, b) => (a.entity_id < b.entity_id ? -1 : 1)),
    );

    await db.run(sql(`DELETE FROM search_intents WHERE owner_id = :owner`, { owner }));
    clock += 1;
    await tasks.complete({ ownerId: owner, taskId: parent, mode: "all", stopRun: false });
    const archived = await db.all<{ entity_id: string; entity: string; revision_or_seq: number }>(
      sql(
        `SELECT entity_id, entity, revision_or_seq FROM search_intents WHERE owner_id = :owner ORDER BY entity_id`,
        { owner },
      ),
    );
    expect(archived.map((intent) => intent.entity_id).sort()).toEqual([parent]);
    expect(archived[0]?.entity).toBe("task");
    // The intent carries the row's version after the archive, not before it.
    const row = (await rows(owner)).find((task) => task.id === parent);
    expect(archived[0]?.revision_or_seq).toBe(row?.version);
  });

  it("refuses with task.run_active while a run is active unless asked to stop it", async () => {
    const owner = await insertUser();
    await db.executeScript(
      `CREATE TABLE probe_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL) STRICT;
       CREATE TABLE probe_effects (task_id TEXT NOT NULL, note TEXT NOT NULL) STRICT;`,
    );
    const inputs: unknown[] = [];
    const simon: ArchiveContributor = {
      domain: "simon",
      blockingCondition: ({ taskIds }) => ({
        sql: "EXISTS (SELECT 1 FROM probe_runs WHERE task_id IN (:simon_task_ids) AND status IN ('queued', 'running', 'awaiting_approval', 'awaiting_user'))",
        params: { simon_task_ids: taskIds },
      }),
      statements: (input) => {
        inputs.push(input);
        const guard = archiveGuard(input);
        return [
          sql(
            `UPDATE probe_runs SET status = 'stopped' WHERE task_id IN (:ids) AND status IN ('queued', 'running', 'awaiting_approval', 'awaiting_user') AND ${guard.exists}`,
            { ids: input.taskIds, ...guard.params },
          ),
        ];
      },
    };
    const scheduling: ArchiveContributor = {
      domain: "scheduling",
      statements: (input) => {
        const guard = archiveGuard(input);
        return [
          sql(
            `INSERT INTO probe_effects (task_id, note) SELECT :task, 'reminders_cancelled' WHERE ${guard.exists}`,
            { task: input.rootTaskId, ...guard.params },
          ),
        ];
      },
    };
    const tasks = service({ contributors: [simon, scheduling] });
    const parent = await create(tasks, owner, "Parent", { collection: "now" });
    const child = await create(tasks, owner, "Child", { parentId: parent });
    await db.run(
      sql(
        `INSERT INTO probe_runs (id, task_id, status) VALUES ('r1', :task, 'awaiting_approval')`,
        { task: child },
      ),
    );

    const spy = vi.spyOn(db, "batch");
    await expectRefused(
      tasks.complete({ ownerId: owner, taskId: parent, mode: "all", stopRun: false }),
      "task.run_active",
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await db.all(sql(`SELECT * FROM probe_effects`))).toEqual([]);
    expect(await titles(tasks, owner, "now")).toEqual(["Parent", "  Child"]);

    // Only the parent: the child's run is not ended by this completion, so it does not block.
    clock += 1;
    await tasks.complete({ ownerId: owner, taskId: parent, mode: "parent_only", stopRun: false });
    expect(await titles(tasks, owner, "now")).toEqual(["Child"]);

    clock += 1;
    const stopped = await tasks.complete({
      ownerId: owner,
      taskId: child,
      mode: "all",
      stopRun: true,
    });
    expect(stopped.kind).toBe("applied");
    expect(await db.all(sql(`SELECT status FROM probe_runs`))).toEqual([{ status: "stopped" }]);
    expect(await db.all(sql(`SELECT note FROM probe_effects ORDER BY rowid`))).toEqual([
      { note: "reminders_cancelled" },
      { note: "reminders_cancelled" },
    ]);
    expect(inputs.at(-1)).toMatchObject({
      rootTaskId: child,
      taskIds: [child],
      stopRun: true,
      mode: "all",
    });
  });

  it("refuses contributor statements without the archive guard", async () => {
    const owner = await insertUser();
    const bad: ArchiveContributor = {
      domain: "vault",
      statements: () => [sql(`UPDATE users SET role = 'admin'`)],
    };
    const tasks = service({ contributors: [bad] });
    const id = await create(tasks, owner, "Task", { collection: "now" });
    await expect(
      tasks.complete({ ownerId: owner, taskId: id, mode: "all", stopRun: false }),
    ).rejects.toThrow(/writes tasks or users/);
    const unguarded: ArchiveContributor = {
      domain: "vault",
      statements: () => [sql(`DELETE FROM search_intents WHERE 1 = 1`)],
    };
    await expect(
      service({ contributors: [unguarded] }).complete({
        ownerId: owner,
        taskId: id,
        mode: "all",
        stopRun: false,
      }),
    ).rejects.toThrow(/without the archive guard/);
  });
});

describe("restoring (§2.1, P2)", () => {
  it("returns tasks to their collection and parent, falling back to top level", async () => {
    const owner = await insertUser();
    const tasks = service();
    const parent = await create(tasks, owner, "Parent", { collection: "later" });
    const child = await create(tasks, owner, "Child", { parentId: parent });
    const grandchild = await create(tasks, owner, "Grandchild", { parentId: child });
    await create(tasks, owner, "Other", { collection: "later" });
    clock += 1;
    await tasks.complete({ ownerId: owner, taskId: parent, mode: "all", stopRun: false });

    // Restoring a subtask while its parent stays archived makes it top level in its collection.
    clock += 1;
    const partial = applied<Record<string, unknown>>(
      await tasks.restore({ ownerId: owner, taskId: child }),
    );
    expect(partial).toMatchObject({
      taskId: child,
      restoredTaskIds: [child, grandchild],
      collection: "later",
      parentId: null,
      fallback: "parent_unavailable",
    });
    expect(await titles(tasks, owner, "later")).toEqual(["Child", "  Grandchild", "Other"]);

    clock += 1;
    const whole = applied<Record<string, unknown>>(
      await tasks.restore({ ownerId: owner, taskId: parent }),
    );
    expect(whole).toMatchObject({
      restoredTaskIds: [parent],
      collection: "later",
      parentId: null,
      fallback: "none",
    });
    // Child took the first key while Parent was archived, so Parent lands right after it.
    expect(await titles(tasks, owner, "later")).toEqual([
      "Child",
      "  Grandchild",
      "Parent",
      "Other",
    ]);

    // Restoring an active task changes nothing.
    const again = applied<Record<string, unknown>>(
      await tasks.restore({ ownerId: owner, taskId: parent }),
    );
    expect(again).toMatchObject({ restoredTaskIds: [], fallback: "none" });
    await expectRefused(tasks.restore({ ownerId: owner, taskId: uuidv7(clock) }), "not_found");
    expect(restorableCollection("someday")).toEqual({ collection: "now", unavailable: true });
    expect(restorableCollection("later")).toEqual({ collection: "later", unavailable: false });
    await expectCacheExact(tasks, owner);
  });

  it("restores a whole group into its parent and resolves position collisions", async () => {
    const owner = await insertUser();
    const tasks = service({ cache: false });
    const parent = await create(tasks, owner, "Parent", { collection: "now" });
    const a = await create(tasks, owner, "A", { parentId: parent });
    const b = await create(tasks, owner, "B", { parentId: parent });
    const c = await create(tasks, owner, "C", { parentId: parent });
    clock += 1;
    await tasks.complete({ ownerId: owner, taskId: b, mode: "all", stopRun: false });
    // A new subtask between A and C takes exactly B's old key.
    clock += 1;
    await tasks.create({ ownerId: owner, actor: user, title: "New", parentId: parent, afterId: a });
    const stored = await rows(owner);
    const oldB = stored.find((row) => row.id === b)?.position;
    expect(
      stored.find(
        (row) =>
          row.parent_id === parent && row.status === "active" && row.id !== a && row.id !== c,
      )?.position,
    ).toBe(oldB);
    clock += 1;
    applied(await tasks.restore({ ownerId: owner, taskId: b }));
    expect(await titles(tasks, owner, "now")).toEqual(["Parent", "  A", "  New", "  B", "  C"]);
    const positions = (await rows(owner))
      .filter((row) => row.status === "active" && row.parent_id === parent)
      .map((row) => row.position);
    expect(positions).toHaveLength(4);
    expect(new Set(positions).size).toBe(4);
  });

  it("undoes a completion with one request from the cache", async () => {
    const owner = await insertUser();
    const tasks = service();
    const parent = await create(tasks, owner, "Parent", { collection: "now" });
    await create(tasks, owner, "Child", { parentId: parent });
    clock += 1;
    await tasks.complete({ ownerId: owner, taskId: parent, mode: "all", stopRun: false });
    const spy = vi.spyOn(db, "batch");
    clock += 1;
    await tasks.restore({ ownerId: owner, taskId: parent });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await titles(tasks, owner, "now")).toEqual(["Parent", "  Child"]);
  });
});

describe("idempotent writes folded into the batch", () => {
  function fold(owner: string, key: string, input: unknown): TaskWriteFold {
    const store = new IdempotencyStore({ db, keys });
    const request = { scope: "POST /v1/tasks/:id/complete", userId: owner, key, input, now: clock };
    const folded = store.foldedClaim(request);
    return {
      claim: folded.claim,
      statements: folded.statements,
      completion: (response, accountKey) =>
        store.completeStatement({ claim: folded.claim, response, accountKey, now: clock }),
      decide: (results, accountKey, offset) => {
        const decision = store.decideFoldedClaim({ request, folded, results, accountKey, offset });
        if (decision.kind === "replay") return { kind: "replay", body: decision.response.body };
        if (decision.kind === "started") return { kind: "started" };
        throw new Error(decision.kind);
      },
    };
  }

  const authority = {
    sql: "EXISTS (SELECT 1 FROM executor_state WHERE id = 1 AND generation = CAST(:task_auth_generation AS INTEGER))",
    params: { task_auth_generation: "1" },
  };

  it.each(["create", "move"] as const)(
    "fences %s at the deciding batch and refuses recorded replay after revocation",
    async (operation) => {
      const owner = await insertUser();
      const tasks = service();
      const existing = await create(tasks, owner, "Existing", { collection: "now" });
      const id = uuidv7(clock);
      const key = `guarded-${operation}-request`;
      const execute = () =>
        operation === "create"
          ? tasks.create({
              ownerId: owner,
              actor: user,
              title: "Guarded",
              collection: "unclassified",
              taskId: id,
              authorization: authority,
              fold: fold(owner, key, { operation }),
            })
          : tasks.move({
              ownerId: owner,
              actor: user,
              taskId: existing,
              collection: "later",
              authorization: authority,
              fold: fold(owner, key, { operation }),
            });
      const first = await execute();
      expect(first.kind).toBe("applied");
      expect(await execute()).toEqual({ kind: "replay", body: first.body });
      await db.run(sql("UPDATE executor_state SET generation = 2 WHERE id = 1"));
      await expectRefused(execute(), "not_found");
      expect(await db.all(sql("SELECT status FROM idempotency_records"))).toEqual([
        { status: "completed" },
      ]);
    },
  );

  it.each(["create", "move"] as const)(
    "refuses %s when authority changes after the warm tree was read, without a success record",
    async (operation) => {
      const owner = await insertUser();
      const tasks = service();
      const existing = await create(tasks, owner, "Existing", { collection: "now" });
      const before = await rows(owner);
      const original = db.batch.bind(db);
      const spy = vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
        await original([sql("UPDATE executor_state SET generation = 2 WHERE id = 1")]);
        return original(statements);
      });
      const input = {
        ownerId: owner,
        actor: user,
        authorization: authority,
        fold: fold(owner, `race-${operation}-request`, { operation }),
      };
      await expectRefused(
        operation === "create"
          ? tasks.create({ ...input, title: "Refused", collection: "unclassified" })
          : tasks.move({ ...input, taskId: existing, collection: "later" }),
        "not_found",
      );
      spy.mockRestore();
      expect(await rows(owner)).toEqual(before);
      expect(await db.all(sql("SELECT key FROM idempotency_records"))).toEqual([]);
    },
  );

  it("denies an exact archived completion replay after access is relocked", async () => {
    const owner = await insertUser();
    const tasks = service();
    const id = await create(tasks, owner, "Private title", { collection: "now" });
    const execute = () =>
      tasks.complete({
        ownerId: owner,
        taskId: id,
        mode: "all" as const,
        stopRun: false,
        fold: fold(owner, "completion-access-replay", { id }),
      });
    expect((await execute()).kind).toBe("applied");
    await db.run(sql("UPDATE users SET beta_state = 'relocked' WHERE id = :owner", { owner }));
    await expectRefused(execute(), "not_found");
  });

  it("does not let a foreign folded claim record another owner's task", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    await expectRefused(
      service().create({
        ownerId: owner,
        actor: user,
        title: "No",
        fold: fold(other, "foreign-owner-request", {}),
      }),
      "not_found",
    );
    expect(await rows(owner)).toEqual([]);
    expect(await db.all(sql("SELECT key FROM idempotency_records"))).toEqual([]);
  });

  it("rejects guard bind shadowing and borrowing before any write", async () => {
    const owner = await insertUser();
    const guards: TaskAuthorization[] = [
      { sql: ":tree_owner = :tree_owner", params: { tree_owner: owner } },
      { sql: ":task_auth_owner = :task_auth_owner", params: { task_auth_owner: owner } },
      { sql: ":tree_owner = :task_auth_id", params: { task_auth_id: owner } },
    ];
    for (const authorization of guards) {
      await expect(
        service().create({ ownerId: owner, actor: user, title: "No", authorization }),
      ).rejects.toThrow();
    }
    expect(await rows(owner)).toEqual([]);
  });

  it("does not serve a cached task through a revoked authorization", async () => {
    const owner = await insertUser();
    const tasks = service();
    const id = await create(tasks, owner, "Cached title", { collection: "now" });
    expect((await tasks.getTask(owner, id, authority)).task.title).toBe("Cached title");
    await db.run(sql("UPDATE executor_state SET generation = 2 WHERE id = 1"));
    await expectRefused(tasks.getTask(owner, id, authority), "not_found");
  });

  it("does not reveal archived task or hierarchy errors through an unauthorized non-fold plan", async () => {
    const owner = await insertUser();
    const tasks = service();
    const id = await create(tasks, owner, "Archived", { collection: "now" });
    await tasks.complete({ ownerId: owner, taskId: id, mode: "all", stopRun: false });
    const authorization = { sql: "0 = 1", params: {} };
    await expectRefused(
      tasks.create({ ownerId: owner, actor: user, title: "No", parentId: id, authorization }),
      "not_found",
    );
    await expectRefused(
      tasks.move({ ownerId: owner, actor: user, taskId: id, collection: "later", authorization }),
      "not_found",
    );
    await expectRefused(
      tasks.create({
        ownerId: owner,
        actor: user,
        title: "No",
        taskId: id,
        collection: "now",
        authorization,
      }),
      "not_found",
    );
    expect(await rows(owner)).toHaveLength(1);
  });

  it("replays an exact retry of a completion instead of refusing the archived task", async () => {
    const owner = await insertUser();
    const tasks = service();
    const id = await create(tasks, owner, "Task", { collection: "now" });
    const input = { mode: "all", stopRun: false };
    clock += 1;
    const first = await tasks.complete({
      ownerId: owner,
      taskId: id,
      mode: "all",
      stopRun: false,
      fold: fold(owner, "key-aaaaaaaaaaaaaaaa", input),
    });
    expect(first.kind).toBe("applied");
    const retry = await tasks.complete({
      ownerId: owner,
      taskId: id,
      mode: "all",
      stopRun: false,
      fold: fold(owner, "key-aaaaaaaaaaaaaaaa", input),
    });
    expect(retry).toEqual({ kind: "replay", body: applied(first) });
    // Another key for the archived task is refused and leaves no pending record behind.
    await expectRefused(
      tasks.complete({
        ownerId: owner,
        taskId: id,
        mode: "all",
        stopRun: false,
        fold: fold(owner, "key-bbbbbbbbbbbbbbbb", input),
      }),
      "task.archived",
    );
    expect(await db.all(sql(`SELECT key, status FROM idempotency_records ORDER BY key`))).toEqual([
      { key: "key-aaaaaaaaaaaaaaaa", status: "completed" },
    ]);
  });

  it("refuses a no-op restore inside the batch once access is taken away, recording nothing", async () => {
    const owner = await insertUser();
    const tasks = service();
    const id = await create(tasks, owner, "Task", { collection: "now" });
    // The task is active, so a restore changes nothing; the batch must still decide on access.
    await db.run(sql(`UPDATE users SET beta_state = 'relocked' WHERE id = :owner`, { owner }));
    await expectRefused(
      tasks.restore({
        ownerId: owner,
        taskId: id,
        fold: fold(owner, "key-dddddddddddddddd", { id }),
      }),
      "access.relocked",
    );
    // Nothing recorded: a later retry of the same key must not replay a success that never happened.
    expect(await db.all(sql(`SELECT key, status FROM idempotency_records`))).toEqual([]);
    const version = await db.first<{ task_tree_version: number }>(
      sql(`SELECT task_tree_version FROM users WHERE id = :owner`, { owner }),
    );
    expect(version?.task_tree_version).toBe(1);
  });

  it("records a no-op restore of an active task so an exact retry replays it", async () => {
    const owner = await insertUser();
    const tasks = service();
    const id = await create(tasks, owner, "Task", { collection: "now" });
    const before = await db.first<{ task_tree_version: number }>(
      sql(`SELECT task_tree_version FROM users WHERE id = :owner`, { owner }),
    );
    const first = await tasks.restore({
      ownerId: owner,
      taskId: id,
      fold: fold(owner, "key-eeeeeeeeeeeeeeee", { id }),
    });
    expect(applied<{ restoredTaskIds: string[] }>(first).restoredTaskIds).toEqual([]);
    const retry = await tasks.restore({
      ownerId: owner,
      taskId: id,
      fold: fold(owner, "key-eeeeeeeeeeeeeeee", { id }),
    });
    expect(retry).toEqual({ kind: "replay", body: applied(first) });
    // A no-op never moves the tree version, so no client refetches and no cache entry is dropped.
    const after = await db.first<{ task_tree_version: number }>(
      sql(`SELECT task_tree_version FROM users WHERE id = :owner`, { owner }),
    );
    expect(after?.task_tree_version).toBe(before?.task_tree_version);
    await expectCacheExact(tasks, owner);
  });

  it("releases the claim when a stale plan is retried, then completes it", async () => {
    const owner = await insertUser();
    const tasks = service();
    const id = await create(tasks, owner, "Task", { collection: "now" });
    await tasks.listCollection(owner, "now");
    // Another writer moves the tree version behind this service's cache.
    await service({ cache: false }).create({
      ownerId: owner,
      actor: user,
      title: "Other",
      collection: "later",
    });
    clock += 1;
    const result = await tasks.move({
      ownerId: owner,
      actor: user,
      taskId: id,
      collection: "later",
      fold: fold(owner, "key-cccccccccccccccc", { collection: "later" }),
    });
    expect(result.kind).toBe("applied");
    expect(await db.all(sql(`SELECT status FROM idempotency_records`))).toEqual([
      { status: "completed" },
    ]);
  });
});

describe("reads", () => {
  it("returns a task with its breadcrumb, archived or active, and hides other owners' tasks", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const tasks = service();
    const parent = await create(tasks, owner, "Refresh my portfolio", { collection: "now" });
    const child = await create(tasks, owner, "Pick five projects", { parentId: parent });
    const detail = await tasks.getTask(owner, child);
    expect(detail.task).toMatchObject({
      id: child,
      status: "active",
      parentId: parent,
      collection: "now",
    });
    expect(detail.ancestors).toEqual([
      { id: parent, title: "Refresh my portfolio", status: "active" },
    ]);
    clock += 1;
    await tasks.complete({ ownerId: owner, taskId: parent, mode: "all", stopRun: false });
    const archived = await tasks.getTask(owner, child);
    expect(archived.task).toMatchObject({ status: "archived", archivedWithRootId: parent });
    expect(archived.ancestors).toEqual([
      { id: parent, title: "Refresh my portfolio", status: "archived" },
    ]);
    await expectRefused(tasks.getTask(other, child), "not_found");
  });

  it("lists the archive by local completion date with subtasks, search and pages", async () => {
    const owner = await insertUser();
    const tasks = service();
    const titlesByDay: Array<[number, string]> = [
      [Date.UTC(2026, 8, 10, 6, 0), "Book the pottery class"],
      [Date.UTC(2026, 8, 12, 6, 0), "Send the project outline"],
      [Date.UTC(2026, 8, 12, 23, 30), "Choose portfolio photos"],
    ];
    const ids: string[] = [];
    for (const [at, title] of titlesByDay) {
      clock = at;
      const id = await create(tasks, owner, title, { collection: "later" });
      if (title === "Choose portfolio photos") {
        await create(tasks, owner, "Café shortlist", { parentId: id });
      }
      await tasks.complete({ ownerId: owner, taskId: id, mode: "all", stopRun: false });
      ids.push(id);
    }
    // Los Angeles is UTC-7 in September: 06:00 UTC is the evening before, 23:30 UTC the same day.
    const page = await tasks.listArchive({ ownerId: owner, timeZone: "America/Los_Angeles" });
    expect(page.timeZone).toBe("America/Los_Angeles");
    expect(
      page.groups.map((group) => [
        group.date,
        group.tasks.map((task) => `${task.depth}:${task.title}`),
      ]),
    ).toEqual([
      ["2026-09-12", ["0:Choose portfolio photos", "1:Café shortlist"]],
      ["2026-09-11", ["0:Send the project outline"]],
      ["2026-09-09", ["0:Book the pottery class"]],
    ]);
    expect(page.nextCursor).toBeNull();

    const utc = await tasks.listArchive({ ownerId: owner });
    expect(utc.groups.map((group) => group.date)).toEqual(["2026-09-12", "2026-09-10"]);

    const search = await tasks.listArchive({ ownerId: owner, q: "CAFE" });
    expect(search.groups.flatMap((group) => group.tasks.map((task) => task.title))).toEqual([
      "Choose portfolio photos",
      "Café shortlist",
    ]);
    expect((await tasks.listArchive({ ownerId: owner, q: "nothing like it" })).groups).toEqual([]);

    const first = await tasks.listArchive({ ownerId: owner, limit: 2 });
    expect(
      first.groups.flatMap((group) => group.tasks.filter((task) => task.depth === 0)),
    ).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await tasks.listArchive({
      ownerId: owner,
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(second.groups.flatMap((group) => group.tasks.map((task) => task.title))).toEqual([
      "Book the pottery class",
    ]);
    expect(second.nextCursor).toBeNull();

    await expect(
      tasks.listArchive({ ownerId: owner, timeZone: "Mars/Olympus" }),
    ).rejects.toMatchObject({ field: "timeZone" });
    await expect(
      tasks.listArchive({ ownerId: owner, cursor: "bm90LWEtY3Vyc29y" }),
    ).rejects.toMatchObject({ field: "cursor" });
    void ids;
  });

  it("pages a collection's tree in pre-order, from one tree read (§3 D1 budget)", async () => {
    const owner = await insertUser();
    const tasks = service();
    const parent = await create(tasks, owner, "Refresh my portfolio", { collection: "now" });
    await create(tasks, owner, "Pick five projects", { parentId: parent });
    await create(tasks, owner, "Rewrite the about page", { parentId: parent });
    await create(tasks, owner, "Send the project outline", { collection: "now" });

    const whole = await tasks.listCollection(owner, "now");
    expect(whole.nextCursor).toBeNull();
    expect(whole.tasks).toHaveLength(4);

    const first = await tasks.listCollection(owner, "now", { limit: 2 });
    expect(first.tasks.map((task) => task.title)).toEqual([
      "Refresh my portfolio",
      "Pick five projects",
    ]);
    expect(first.nextCursor).not.toBeNull();

    const second = await tasks.listCollection(owner, "now", {
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(second.tasks.map((task) => task.title)).toEqual([
      "Rewrite the about page",
      "Send the project outline",
    ]);
    expect(second.nextCursor).toBeNull();
    // Pre-order across the pages is exactly the unpaged walk, depths included.
    expect([...first.tasks, ...second.tasks]).toEqual(whole.tasks);

    // A page taken after the tree moved reports the new version, which is how a client knows to
    // start again rather than stitch two trees together.
    clock += 1;
    await create(tasks, owner, "Water the plants", { collection: "now" });
    const stale = await tasks.listCollection(owner, "now", {
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(stale.taskTreeVersion).not.toBe(first.taskTreeVersion);

    await expect(
      tasks.listCollection(owner, "now", { cursor: "bm90LWEtY3Vyc29y" }),
    ).rejects.toMatchObject({ field: "cursor" });
  });

  it("bounds the subtasks one archive page reads per completed task (§3 D1 budget)", async () => {
    const owner = await insertUser();
    const tasks = service();
    const parent = await create(tasks, owner, "Clear the studio", { collection: "later" });
    const members = ARCHIVE_MEMBERS_PER_GROUP + 12;
    for (let index = 0; index < members; index += 1) {
      await create(tasks, owner, `Box ${index}`, { parentId: parent });
    }
    clock += 1;
    await tasks.complete({ ownerId: owner, taskId: parent, mode: "all", stopRun: false });

    const page = await tasks.listArchive({ ownerId: owner });
    const shown = page.groups.flatMap((group) => group.tasks);
    // Without the bound this would be every subtask ever completed under one task.
    expect(shown).toHaveLength(ARCHIVE_MEMBERS_PER_GROUP + 1);
    expect(shown[0]?.title).toBe("Clear the studio");
    // The members kept are the first in display order, not an arbitrary slice.
    expect(shown.slice(1).map((task) => task.title)).toEqual(
      Array.from({ length: ARCHIVE_MEMBERS_PER_GROUP }, (_, index) => `Box ${index}`),
    );
  });

  it("evicts a tree cache entry an archive read proves stale (decision WS2)", async () => {
    const owner = await insertUser();
    const cache = new MemoryTaskTreeCache({ now });
    const tasks = new TaskService({
      db,
      keys,
      policy: { betaAccessRequired: true },
      now,
      cache,
      archiveContributors: [],
    });
    const id = await create(tasks, owner, "Book the pottery class", { collection: "later" });
    clock += 1;
    await tasks.complete({ ownerId: owner, taskId: id, mode: "all", stopRun: false });
    const cachedVersion = cache.get(owner)?.version;
    expect(cachedVersion).toBeDefined();

    // A read at the cached version keeps the entry and folds the archived rows into it.
    await tasks.listArchive({ ownerId: owner });
    expect(cache.get(owner)?.version).toBe(cachedVersion);
    expect(cache.get(owner)?.archived.has(id)).toBe(true);

    // Another api instance or the worker moves the version; this process saw no commit.
    await db.batch([
      sql(
        `UPDATE users SET task_tree_version = task_tree_version + 1, task_tree_write_id = :w
         WHERE id = :id`,
        { id: owner, w: uuidv7(clock) },
      ),
    ]);
    expect(cache.get(owner)?.version).toBe(cachedVersion);

    await tasks.listArchive({ ownerId: owner });
    expect(cache.get(owner)).toBeUndefined();
    // The next read is served from D1 at the version the other writer left behind.
    expect((await tasks.state(owner)).version).toBe((cachedVersion as number) + 1);
  });
});

describe("the tree cache budget (§3.3)", () => {
  it("drops least recently stored owners once the task budget is used up", async () => {
    const owners: string[] = [];
    for (let index = 0; index < 3; index += 1) owners.push(await insertUser());
    const cache = new MemoryTaskTreeCache({ now, maxTasks: 4 });
    const tasks = new TaskService({
      db,
      keys,
      policy: { betaAccessRequired: true },
      now,
      cache,
      archiveContributors: [],
    });
    for (const owner of owners) {
      await create(tasks, owner, "One", { collection: "now" });
      await create(tasks, owner, "Two", { collection: "now" });
    }
    // Two owners of two tasks each fit; storing the third evicts the first.
    expect(cache.taskCount).toBeLessThanOrEqual(4);
    expect(cache.get(owners[0] as string)).toBeUndefined();
    expect(cache.get(owners[2] as string)?.tree.byId.size).toBe(2);
    // An owner whose tree alone is over budget is still cached, so its writes stay one D1 request.
    const big = owners[2] as string;
    for (let index = 0; index < 5; index += 1) {
      await create(tasks, big, `Extra ${index}`, { collection: "now" });
    }
    expect(cache.get(big)?.tree.byId.size).toBe(7);
    expect(cache.size).toBe(1);
    // Deleting the entry gives the budget back rather than leaking it.
    cache.delete(big);
    expect(cache.taskCount).toBe(0);
  });
});

describe("the active-task guard helper (§2.1)", () => {
  it("lets other domains fold the guard into their deciding statement", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const tasks = service();
    const id = await create(tasks, owner, "Task", { collection: "now" });
    await db.executeScript(
      `CREATE TABLE probe_heads (task_id TEXT NOT NULL, revision TEXT NOT NULL) STRICT;`,
    );
    const publish = async (ownerId: string) => {
      const guard = activeTaskGuard({ taskId: id, ownerId });
      const results = await db.batch([
        sql(
          `INSERT INTO probe_heads (task_id, revision) SELECT :task, 'r2' WHERE ${guard.exists}`,
          {
            task: id,
            ...guard.params,
          },
        ),
        sql(`SELECT changes() AS changed`),
        guard.statusStatement,
      ]);
      return {
        changed: results[1]?.results[0]?.changed,
        failure:
          Number(results[1]?.results[0]?.changed) === 1
            ? null
            : activeTaskGuardFailure(results[2]?.results[0]),
      };
    };
    expect(await publish(owner)).toEqual({ changed: 1, failure: null });
    expect(await publish(other)).toEqual({ changed: 0, failure: "not_found" });
    await tasks.complete({ ownerId: owner, taskId: id, mode: "all", stopRun: false });
    expect(await publish(owner)).toEqual({ changed: 0, failure: "task.archived" });
    expect(await db.all(sql(`SELECT COUNT(*) AS n FROM probe_heads`))).toEqual([{ n: 1 }]);
  });
});

describe("commit signals and the tree cache", () => {
  it("announces commits to subscribers of the same client only", async () => {
    const owner = await insertUser();
    const tasks = service();
    const seen: TaskTreeCommit[] = [];
    const foreign: TaskTreeCommit[] = [];
    const unsubscribe = onTaskTreeCommitted(db, (commit) => seen.push(commit));
    const otherDb = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
    onTaskTreeCommitted(otherDb, (commit) => foreign.push(commit));
    const id = await create(tasks, owner, "Task", { collection: "now" });
    expect(seen).toEqual([{ ownerId: owner, taskTreeVersion: 1, taskIds: [id] }]);
    unsubscribe();
    await create(tasks, owner, "Another", { collection: "now" });
    expect(seen).toHaveLength(1);
    expect(foreign).toEqual([]);
    otherDb.close();
  });

  it("reads again after its TTL and when a refused plan may come from a stale cache", async () => {
    const owner = await insertUser();
    const tasks = service();
    await tasks.listCollection(owner, "now");
    const elsewhere = service({ cache: false });
    const id = await create(elsewhere, owner, "Created elsewhere", { collection: "now" });
    // Within the TTL the cache still serves the old tree...
    expect(await titles(tasks, owner, "now")).toEqual([]);
    // ...but a write naming the unseen task reads the tree again instead of refusing it.
    clock += 1;
    expect((await tasks.rename({ ownerId: owner, taskId: id, title: "Renamed" })).kind).toBe(
      "applied",
    );
    expect(await titles(tasks, owner, "now")).toEqual(["Renamed"]);
    await create(elsewhere, owner, "Second", { collection: "now" });
    clock += 61_000;
    expect(await titles(tasks, owner, "now")).toEqual(["Renamed", "Second"]);
  });
});
