import { randomBytes } from "node:crypto";
import { createKeyProvider, type ManagedKeyProvider } from "@symplist/crypto";
import { int, sql, uuidv7 } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { TaskService } from "../tasks/service.ts";
import { McpGrants, type McpOwner } from "./grants.ts";
import { McpTaskTools } from "./task-tools.ts";
import type { McpIdentity } from "./types.ts";

let env: DocumentsTestEnvironment;
let keys: ManagedKeyProvider;
let grants: McpGrants;
let tasks: TaskService;
let tools: McpTaskTools;
let actor: McpOwner;
beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
  keys = createKeyProvider(
    {
      CONTENT_KEK: { current: 1, versions: new Map([[1, env.keys.current("CONTENT_KEK").key]]) },
      MCP_TOKEN_DIGEST_SECRET: { current: 1, versions: new Map([[1, randomBytes(32)]]) },
      IDEMPOTENCY_SECRET: { current: 1, versions: new Map([[1, randomBytes(32)]]) },
    },
    { required: ["CONTENT_KEK", "MCP_TOKEN_DIGEST_SECRET", "IDEMPOTENCY_SECRET"] },
  );
  actor = { ownerId: await env.createUser(), sessionId: uuidv7() };
  await env.db.run(
    sql(
      "INSERT INTO auth_sessions (id,user_id,token_digest,digest_version,created_at,last_seen_at,expires_at,write_id) VALUES (:id,:owner,:id,1,:now,:now,:expiry,:id)",
      {
        id: actor.sessionId,
        owner: actor.ownerId,
        now: int(env.clock),
        expiry: int(env.clock + 86400_000),
      },
    ),
  );
  grants = new McpGrants({
    db: env.db,
    keys,
    now: () => env.clock,
    policy: { betaAccessRequired: true },
  });
  tasks = new TaskService(grants.options);
  tools = new McpTaskTools(grants, tasks);
});
afterEach(async () => {
  vi.restoreAllMocks();
  keys.destroy();
  await env.close();
});
async function identity(taskIds: string[] | null = null, write = true): Promise<McpIdentity> {
  const minted = await grants.createKey(actor, {
    name: "test agent",
    scopes: [write ? "tasks:write" : "tasks:read"],
    taskIds,
  });
  return grants.authenticateKey(minted.key ?? "");
}
async function create(title: string, parentId?: string) {
  const result = await tasks.create({
    ownerId: actor.ownerId,
    actor: { kind: "user" },
    title,
    collection: "unclassified",
    ...(parentId ? { parentId } : {}),
  });
  if (result.kind !== "applied") throw new Error("test task did not apply");
  return result.body.task.id;
}

describe("MCP task scope at the read, write and replay decision", () => {
  it("emits confirmed server events once, without failing a committed write on analytics failure", async () => {
    const confirmed = vi.fn(async () => {
      throw new Error("analytics unavailable");
    });
    const service = new McpTaskTools(grants, tasks, confirmed);
    const grant = await identity();
    const input = { title: "Private analytics marker", requestId: uuidv7() };
    const created = await service.create(grant, input);
    await service.create(grant, input);
    expect(confirmed).toHaveBeenCalledTimes(1);
    const event = confirmed.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      analytics: { event: { event: "task_created", properties: { source: "mcp" } } },
    });
    expect(JSON.stringify(created)).not.toContain("analytics");
  });
  it("lists only selected tasks and masks ungranted ancestors and child counts in context", async () => {
    const parent = await create("private parent");
    const child = await create("selected child", parent);
    await create("private sibling", parent);
    await create("private grandchild", child);
    const grant = await identity([child]);
    const context = await tools.context(grant, child);
    expect(context.ancestors).toEqual([]);
    expect(context.task.parentId).toBeNull();
    expect(context.task).not.toHaveProperty("childCount");
    expect(JSON.stringify(context)).not.toContain("private");
    const list = await tools.list(grant, {});
    expect(list.tasks.map((t) => t.id)).toEqual([child]);
    expect(list.tasks[0]?.parentId).toBeNull();
    await expect(tools.context(grant, parent)).rejects.toThrow();
  });
  it("creates exactly once in Unclassified and never leaks analytics or grant IDs in its response", async () => {
    const grant = await identity();
    const input = { title: "MCP private task", collection: "now" as const, requestId: uuidv7() };
    const first = await tools.create(grant, input);
    expect(first).toMatchObject({ collection: "unclassified", parentTaskId: null, created: true });
    expect(await tools.create(grant, input)).toEqual({ ...first, created: false });
    expect(await env.count("tasks")).toBe(1);
    expect(JSON.stringify(first)).not.toContain(grant.id);
    expect(JSON.stringify(first)).not.toContain("analytics");
    expect(
      await env.db.first(sql("SELECT source FROM tasks WHERE id = :id", { id: first.taskId })),
    ).toEqual({ source: `mcp:${grant.id}` });
    await expect(tools.create(grant, { ...input, title: "changed" })).rejects.toThrow();
  });
  it("refuses read-only and selected-task creation rather than expanding a grant", async () => {
    const task = await create("selected");
    for (const grant of [await identity(null, false), await identity([task])])
      await expect(
        tools.create(grant, { title: "outside scope", requestId: uuidv7() }),
      ).rejects.toThrow();
    expect(await env.count("tasks")).toBe(1);
  });
  it("requires every descendant in a move and allows a fully selected subtree", async () => {
    const root = await create("root");
    const child = await create("child", root);
    const limited = await identity([root]);
    await expect(
      tools.move(limited, { taskId: root, collection: "now", requestId: uuidv7() }),
    ).rejects.toThrow();
    expect((await tasks.getTask(actor.ownerId, child)).task.collection).toBe("unclassified");
    const all = await identity([root, child]);
    const moved = await tools.move(all, { taskId: root, collection: "later", requestId: uuidv7() });
    expect(moved.movedTaskIds).toEqual([root, child]);
    expect((await tasks.getTask(actor.ownerId, child)).task.collection).toBe("later");
  });
  it("prevents a retried move from undoing a subsequent owner move", async () => {
    const task = await create("task");
    const grant = await identity();
    const input = { taskId: task, collection: "now" as const, requestId: uuidv7() };
    const first = await tools.move(grant, input);
    await tasks.move({
      ownerId: actor.ownerId,
      actor: { kind: "user" },
      taskId: task,
      collection: "later",
    });
    expect(await tools.move(grant, input)).toEqual(first);
    expect((await tasks.getTask(actor.ownerId, task)).task.collection).toBe("later");
  });
  it("checks revocation before replay and during the actual create batch", async () => {
    const grant = await identity();
    const input = { title: "task", requestId: uuidv7() };
    await tools.create(grant, input);
    await grants.revoke(actor, grant.id);
    await expect(tools.create(grant, input)).rejects.toThrow();
    const fresh = await identity();
    const batch = env.db.batch.bind(env.db);
    let revoked = false;
    vi.spyOn(env.db, "batch").mockImplementation(async (statements) => {
      if (!revoked && statements.some((s) => s.sql.includes("INSERT INTO tasks"))) {
        revoked = true;
        await env.db.run(
          sql(
            "UPDATE mcp_grants SET revoked_at = :now, generation = generation + 1 WHERE id = :id",
            { now: int(env.clock), id: fresh.id },
          ),
        );
      }
      return batch(statements);
    });
    await expect(
      tools.create(fresh, { title: "must not exist", requestId: uuidv7() }),
    ).rejects.toThrow();
    expect(await env.count("tasks")).toBe(1);
  });
  it("rejects archived, foreign and locked-account reads", async () => {
    const task = await create("task");
    const grant = await identity();
    const other = await env.createTask(await env.createUser());
    await expect(tools.context(grant, other)).rejects.toThrow();
    await env.archiveTask(task);
    await expect(tools.context(grant, task)).rejects.toThrow();
    await env.relock(actor.ownerId);
    await expect(tools.list(grant, {})).rejects.toThrow();
  });
});
