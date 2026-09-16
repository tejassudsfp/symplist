import { randomBytes } from "node:crypto";
import { createKeyProvider, keyFamilies, type ManagedKeyProvider } from "@symplist/crypto";
import {
  applyMigrations,
  createLocalSqliteClient,
  int,
  type LocalSqliteClient,
  sql,
  uuidv7,
  verifiedRow,
} from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountKeyStore } from "../account/keys.ts";
import { AccountPurgeRunner } from "../account/purge.ts";
import { accountPurgeContributor } from "../account/purge-contributors/account.ts";
import { preferencesPurgeContributor } from "../account/purge-contributors/preferences.ts";
import { tasksPurgeContributor } from "../account/purge-contributors/tasks.ts";
import { archiveBlockingCondition } from "./archive-runner.ts";
import { TaskOperationError } from "./errors.ts";
import { normalizeTaskPreview, taskPreviewWrite } from "./preview.ts";
import { TaskService } from "./service.ts";
import { announceTaskTreeCommitted, onTaskTreeCommitted } from "./signals.ts";
import { MemoryTaskTreeCache } from "./state.ts";
import { taskCreateTool, taskMoveTool } from "./tools.ts";

let clock = Date.UTC(2026, 8, 15, 9);
const now = () => clock;
let db: LocalSqliteClient;
let keys: ManagedKeyProvider;
const grantId = "0192f0a0-0000-7000-8000-000000000901";

async function insertUser(): Promise<string> {
  const id = uuidv7(clock);
  await db.batch([
    sql(
      `INSERT INTO users (id, email, email_verified_at, beta_state, onboarding_step, created_at, updated_at, write_id)
       VALUES (:id, :email, :now, 'unlocked', 'done', :now, :now, :w)`,
      { id, email: `${id}@example.test`, now: int(clock), w: uuidv7(clock) },
    ),
    new AccountKeyStore({ db, keys }).provisionStatement({ userId: id, now: clock }),
  ]);
  return id;
}

function service() {
  return new TaskService({
    db,
    keys,
    policy: { betaAccessRequired: true },
    now,
    cache: new MemoryTaskTreeCache({ now }),
    archiveContributors: [],
  });
}

beforeEach(async () => {
  clock = Date.UTC(2026, 8, 15, 9);
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
  vi.restoreAllMocks();
  db.close();
  keys.destroy();
});

describe("task_create and task_move for Simon and MCP (§8.7, §14.6)", () => {
  it("does not claim a no-op when the task moves between detail and subtree reads", async () => {
    const owner = await insertUser();
    const tasks = new TaskService({
      db,
      keys,
      now,
      policy: { betaAccessRequired: true },
      archiveContributors: [],
    });
    const taskId = uuidv7(clock);
    await tasks.create({
      ownerId: owner,
      actor: { kind: "user" },
      taskId,
      title: "Concurrent move",
      collection: "now",
    });
    const original = tasks.getTask.bind(tasks);
    vi.spyOn(tasks, "getTask").mockImplementationOnce(async (...args) => {
      const detail = await original(...args);
      await service().move({
        ownerId: owner,
        actor: { kind: "user" },
        taskId,
        collection: "later",
      });
      return detail;
    });
    await expect(
      taskMoveTool(tasks, {
        ownerId: owner,
        actor: { kind: "simon" },
        arguments: { taskId, collection: "now" },
        authorization: { sql: "1 = 1", params: {} },
      }),
    ).rejects.toMatchObject({ code: "task.conflict" });
    expect(await db.all(sql("SELECT collection FROM tasks"))).toEqual([{ collection: "later" }]);
  });
  it("returns the whole no-op subtree beyond a public list page and rejects stale cache versions", async () => {
    const owner = await insertUser();
    const tasks = service();
    const parent = uuidv7(clock);
    await tasks.create({
      ownerId: owner,
      actor: { kind: "user" },
      title: "Parent",
      collection: "now",
      taskId: parent,
    });
    const children: string[] = [];
    for (let index = 0; index < 55; index++) {
      const id = uuidv7(clock);
      children.push(id);
      await tasks.create({
        ownerId: owner,
        actor: { kind: "user" },
        title: `Child ${index}`,
        parentId: parent,
        taskId: id,
      });
    }
    const input = {
      ownerId: owner,
      actor: { kind: "simon" as const },
      arguments: { taskId: parent, collection: "now" as const },
    };
    expect((await taskMoveTool(tasks, input)).movedTaskIds).toEqual([parent, ...children]);
    const child = children[0];
    if (!child) throw new Error("expected seeded child");
    await service().move({
      ownerId: owner,
      actor: { kind: "simon" },
      taskId: child,
      collection: "later",
    });
    await expect(taskMoveTool(tasks, input)).rejects.toMatchObject({ code: "not_found" });
    expect((await taskMoveTool(tasks, input)).movedTaskIds).toEqual([parent, ...children.slice(1)]);
  });
  it("refuses an already-created tool result after its grant or run is revoked", async () => {
    const owner = await insertUser();
    const tasks = service();
    const input = {
      ownerId: owner,
      actor: { kind: "simon" as const },
      taskId: uuidv7(clock),
      arguments: { title: "Existing result" },
      authorization: {
        sql: "EXISTS (SELECT 1 FROM executor_state WHERE id = 1 AND generation = CAST(:task_auth_generation AS INTEGER))",
        params: { task_auth_generation: "1" },
      },
    };
    expect((await taskCreateTool(tasks, input)).created).toBe(true);
    expect((await taskCreateTool(tasks, input)).created).toBe(false);
    await db.run(sql("UPDATE executor_state SET generation = 2 WHERE id = 1"));
    await expect(taskCreateTool(tasks, input)).rejects.toBeInstanceOf(TaskOperationError);
    expect(await db.all(sql("SELECT COUNT(*) AS n FROM tasks"))).toEqual([{ n: 1 }]);
  });

  it("rechecks authority after a no-op move reads its cached subtree", async () => {
    const owner = await insertUser();
    const tasks = service();
    const taskId = uuidv7(clock);
    await taskCreateTool(tasks, {
      ownerId: owner,
      actor: { kind: "simon" },
      taskId,
      arguments: { title: "Keep here", collection: "now" },
    });
    const original = tasks.state.bind(tasks);
    vi.spyOn(tasks, "state").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await db.run(sql("UPDATE executor_state SET generation = 2 WHERE id = 1"));
      return result;
    });
    await expect(
      taskMoveTool(tasks, {
        ownerId: owner,
        actor: { kind: "simon" },
        arguments: { taskId, collection: "now" },
        authorization: {
          sql: "EXISTS (SELECT 1 FROM executor_state WHERE id = 1 AND generation = CAST(:task_auth_generation AS INTEGER))",
          params: { task_auth_generation: "1" },
        },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await db.all(sql("SELECT collection FROM tasks"))).toEqual([{ collection: "now" }]);
  });
  it("lands a connected agent's task in Unclassified with its grant as source, once per call", async () => {
    const owner = await insertUser();
    const tasks = service();
    const taskId = uuidv7(clock);
    const output = await taskCreateTool(tasks, {
      ownerId: owner,
      actor: { kind: "mcp", grantId },
      arguments: { title: "Review the outline", collection: "now" },
      taskId,
    });
    expect(output).toEqual({
      taskId,
      collection: "unclassified",
      parentTaskId: null,
      created: true,
    });
    const retry = await taskCreateTool(tasks, {
      ownerId: owner,
      actor: { kind: "mcp", grantId },
      arguments: { title: "Review the outline" },
      taskId,
    });
    expect(retry.created).toBe(false);
    const stored = await db.all(sql(`SELECT source, collection FROM tasks`));
    expect(stored).toEqual([{ source: `mcp:${grantId}`, collection: "unclassified" }]);
    const tree = await tasks.listCollection(owner, "unclassified");
    expect(tree.tasks[0]?.source).toBe("mcp");
    expect(JSON.stringify(tree)).not.toContain(grantId);

    const simon = await taskCreateTool(tasks, {
      ownerId: owner,
      actor: { kind: "simon" },
      arguments: { title: "Subtask", collection: "later", parentTaskId: taskId },
      taskId: uuidv7(clock),
    });
    expect(simon).toMatchObject({
      collection: "unclassified",
      parentTaskId: taskId,
      created: true,
    });
    const later = await taskCreateTool(tasks, {
      ownerId: owner,
      actor: { kind: "simon" },
      arguments: { title: "For later", collection: "later" },
      taskId: uuidv7(clock),
    });
    expect(later.collection).toBe("later");
  });

  it("creates in one D1 request with a warm tree, and still answers a retry (§3 D1 budget)", async () => {
    const owner = await insertUser();
    const tasks = service();
    // Warm the owner's tree, as any read of the workspace leaves it.
    await tasks.listCollection(owner, "unclassified");

    let batches = 0;
    const counted = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "batch") {
          return (statements: Parameters<typeof db.batch>[0]) => {
            batches += 1;
            return db.batch(statements);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const counting = new TaskService({
      db: counted,
      keys,
      policy: { betaAccessRequired: true },
      now,
      cache: (tasks as unknown as { cache: MemoryTaskTreeCache }).cache,
      archiveContributors: [],
    });

    const taskId = uuidv7(clock);
    const output = await taskCreateTool(counting, {
      ownerId: owner,
      actor: { kind: "mcp", grantId },
      arguments: { title: "Review the outline" },
      taskId,
    });
    expect(output.created).toBe(true);
    // The write alone. Probing for the tool's own id first made this two.
    expect(batches).toBe(1);

    // The same tool call again still answers with the task it created, not a conflict.
    const retry = await taskCreateTool(counting, {
      ownerId: owner,
      actor: { kind: "mcp", grantId },
      arguments: { title: "Review the outline" },
      taskId,
    });
    expect(retry).toEqual({
      taskId,
      collection: "unclassified",
      parentTaskId: null,
      created: false,
    });
    expect(await db.all(sql(`SELECT COUNT(*) AS n FROM tasks`))).toEqual([{ n: 1 }]);
  });

  it("moves a task with its subtasks and refuses archived and foreign tasks", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const tasks = service();
    const parent = uuidv7(clock);
    await taskCreateTool(tasks, {
      ownerId: owner,
      actor: { kind: "simon" },
      arguments: { title: "Parent", collection: "now" },
      taskId: parent,
    });
    const child = uuidv7(clock + 1);
    await taskCreateTool(tasks, {
      ownerId: owner,
      actor: { kind: "simon" },
      arguments: { title: "Child", parentTaskId: parent },
      taskId: child,
    });
    expect(
      await taskMoveTool(tasks, {
        ownerId: owner,
        actor: { kind: "simon" },
        arguments: { taskId: parent, collection: "later" },
      }),
    ).toEqual({
      taskId: parent,
      collection: "later",
      parentTaskId: null,
      movedTaskIds: [parent, child],
    });
    expect(
      await taskMoveTool(tasks, {
        ownerId: owner,
        actor: { kind: "simon" },
        arguments: { taskId: parent, collection: "later" },
      }),
    ).toEqual({
      taskId: parent,
      collection: "later",
      parentTaskId: null,
      movedTaskIds: [parent, child],
    });
    const promoted = await taskMoveTool(tasks, {
      ownerId: owner,
      actor: { kind: "mcp", grantId },
      arguments: { taskId: child, collection: "later" },
    });
    expect(promoted).toMatchObject({
      collection: "later",
      parentTaskId: null,
      movedTaskIds: [child],
    });
    await expect(
      taskMoveTool(tasks, {
        ownerId: other,
        actor: { kind: "mcp", grantId },
        arguments: { taskId: parent, collection: "now" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await tasks.complete({ ownerId: owner, taskId: parent, mode: "all", stopRun: false });
    await expect(
      taskMoveTool(tasks, {
        ownerId: owner,
        actor: { kind: "simon" },
        arguments: { taskId: parent, collection: "now" },
      }),
    ).rejects.toBeInstanceOf(TaskOperationError);
  });
});

describe("task previews", () => {
  it("normalizes preview text", () => {
    expect(normalizeTaskPreview("  \n\t ")).toBeNull();
    expect(normalizeTaskPreview("## Overview\nA lighter,\u0000 quieter portfolio.")).toBe(
      "## Overview A lighter, quieter portfolio.",
    );
    const long = normalizeTaskPreview("word ".repeat(80)) as string;
    expect(Array.from(long).length).toBeLessThanOrEqual(160);
    expect(long.endsWith("…")).toBe(true);
    expect(long).not.toContain("  ");
  });

  it("writes an encrypted preview in another domain's batch and moves the tree version", async () => {
    const owner = await insertUser();
    const tasks = service();
    const created = await tasks.create({
      ownerId: owner,
      actor: { kind: "user" },
      title: "Refresh my portfolio",
      collection: "now",
    });
    if (created.kind !== "applied") throw new Error("expected a task");
    const taskId = created.body.task.id;
    const key = await new AccountKeyStore({ db, keys }).require(owner);
    const write = taskPreviewWrite({
      ownerId: owner,
      taskId,
      text: "A lighter, quieter portfolio.",
      key,
      now: clock,
    });
    const results = await db.batch([...write.statements, write.verify]);
    const row = verifiedRow<{ task_tree_version: number }>(results);
    expect(row?.task_tree_version).toBe(2);
    const stored = await db.first<{ preview_enc: string }>(
      sql(`SELECT preview_enc FROM tasks WHERE id = :id`, { id: taskId }),
    );
    expect(stored?.preview_enc.startsWith("sym1.")).toBe(true);
    expect(stored?.preview_enc).not.toContain("quieter");
    const seen: number[] = [];
    onTaskTreeCommitted(db, (commit) => seen.push(commit.taskTreeVersion));
    announceTaskTreeCommitted(db, { ownerId: owner, taskTreeVersion: 2, taskIds: [taskId] });
    expect(seen).toEqual([2]);
    tasks.invalidate(owner);
    expect((await tasks.listCollection(owner, "now")).tasks[0]?.preview).toBe(
      "A lighter, quieter portfolio.",
    );
  });
});

describe("archive blocking conditions", () => {
  it("requires domain-prefixed, read-only conditions", () => {
    const input = {
      ownerId: "o",
      rootTaskId: "t",
      taskIds: ["t"],
      now: 1,
      taskIdsQuery: { sql: "SELECT :block_ids_root AS id", params: { block_ids_root: "t" } },
    };
    expect(archiveBlockingCondition([], input)).toBeNull();
    const shared = archiveBlockingCondition(
      [
        {
          domain: "simon",
          statements: () => [],
          blockingCondition: ({ taskIdsQuery }) => ({
            sql: `EXISTS (${taskIdsQuery.sql})`,
            params: taskIdsQuery.params,
          }),
        },
        {
          domain: "scheduling",
          statements: () => [],
          blockingCondition: ({ taskIdsQuery }) => ({
            sql: `1 = (SELECT COUNT(*) FROM (${taskIdsQuery.sql}))`,
            params: { ...taskIdsQuery.params, scheduling_unused: "x" },
          }),
        },
      ],
      input,
    );
    expect(shared?.params).toEqual({ block_ids_root: "t", scheduling_unused: "x" });
    expect(() =>
      archiveBlockingCondition(
        [
          {
            domain: "simon",
            statements: () => [],
            blockingCondition: () => ({ sql: "1", params: { block_ids_root: "other" } }),
          },
        ],
        input,
      ),
    ).toThrow(/rebound a shared parameter/);
    expect(() =>
      archiveBlockingCondition(
        [
          {
            domain: "simon",
            statements: () => [],
            blockingCondition: () => ({ sql: "1 = :task_ids", params: { task_ids: "x" } }),
          },
        ],
        input,
      ),
    ).toThrow(/outside its domain prefix/);
    expect(() =>
      archiveBlockingCondition(
        [
          {
            domain: "simon",
            statements: () => [],
            blockingCondition: () => ({
              sql: "(DELETE FROM runs) IS NULL",
              params: {},
            }),
          },
        ],
        input,
      ),
    ).toThrow(/writes/);
  });
});

describe("tasks and preferences purge contributors (§5.6)", () => {
  it("deletes a deep tree leaves first within the batch bound, and every preference row", async () => {
    const owner = await insertUser();
    const kept = await insertUser();
    const tasks = service();
    let parent: string | undefined;
    for (let depth = 0; depth < 6; depth += 1) {
      const result = await tasks.create({
        ownerId: owner,
        actor: { kind: "user" },
        title: `Level ${depth}`,
        ...(parent === undefined ? { collection: "now" as const } : { parentId: parent }),
      });
      if (result.kind !== "applied") throw new Error("expected a task");
      parent = result.body.task.id;
      clock += 1;
    }
    await tasks.create({
      ownerId: kept,
      actor: { kind: "user" },
      title: "Kept",
      collection: "now",
    });
    // One row per preference table: the foundation table and the additive `panels` table (0202).
    for (const [table, group] of [
      ["user_preferences", "appearance"],
      ["user_preferences_panels", "panels"],
    ] as const) {
      await db.run(
        sql(
          `INSERT INTO ${table} (owner_id, "group", version, data_enc, updated_at, write_id)
           VALUES (:owner, :group, 1, 'sym1.1.x.y', :now, 'w')`,
          { owner, group, now: int(clock) },
        ),
      );
    }
    await db.run(
      sql(
        `UPDATE users SET deletion_state = 'deleting', deletion_requested_at = :now WHERE id = :owner`,
        { now: int(clock), owner },
      ),
    );
    await db.run(sql(`DELETE FROM account_keys WHERE owner_id = :owner`, { owner }));
    await db.run(sql(`DELETE FROM search_intents WHERE owner_id = :owner`, { owner }));
    await db.run(
      sql(
        `INSERT INTO account_deletions (user_id, analytics_id, email_digest, email_digest_version,
           composio_user_id, r2_prefix, requested_at, status, steps_done, updated_at, write_id)
         VALUES (:owner, NULL, 'digest', 1, :owner, :prefix, :now, 'pending', '["runs","composio","r2"]', :now, 'w')`,
        { owner, prefix: `u/${owner}/`, now: int(clock) },
      ),
    );
    const statements: string[] = [];
    const recording = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (batch: Parameters<LocalSqliteClient["batch"]>[0]) => {
            for (const statement of batch) statements.push(statement.sql);
            return target.batch(batch);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const runner = new AccountPurgeRunner({
      db: recording,
      store: { list: async () => ({ objects: [] }), delete: async () => undefined } as never,
      now,
      runs: { run: async () => "done" },
      composio: { run: async () => "done" },
      contributors: [preferencesPurgeContributor, tasksPurgeContributor, accountPurgeContributor],
      batchLimit: 2,
    });
    const result = await runner.run(owner);
    expect(result).toEqual({ status: "done" });
    expect(await db.all(sql(`SELECT id FROM tasks WHERE owner_id = :owner`, { owner }))).toEqual(
      [],
    );
    expect(
      await db.all(sql(`SELECT * FROM user_preferences WHERE owner_id = :owner`, { owner })),
    ).toEqual([]);
    expect(
      await db.all(sql(`SELECT * FROM user_preferences_panels WHERE owner_id = :owner`, { owner })),
    ).toEqual([]);
    expect(await db.all(sql(`SELECT owner_id FROM tasks`))).toEqual([{ owner_id: kept }]);
    // Six levels with at most one leaf per level: one pass per level.
    expect(statements.filter((text) => text.startsWith("DELETE FROM tasks")).length).toBe(6);
  });
});
