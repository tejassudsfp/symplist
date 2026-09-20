import { encryptFieldText, zeroize } from "@symplist/crypto";
import { int, type Statement, sql, uuidv7 } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { SimonRepository, simonField } from "../simon/repository.ts";
import { connectionApprovalExpiryStatements } from "./approval-expiry.ts";

let env: DocumentsTestEnvironment;
let repository: SimonRepository;
let owner: string;
let connection: string;
beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
  owner = await env.createUser();
  connection = uuidv7();
  repository = new SimonRepository({
    db: env.db,
    keys: env.keys,
    policy: { betaAccessRequired: true },
    now: () => env.clock,
    quickChatTtlHours: 24,
  });
  await env.db.batch([
    sql("UPDATE executor_state SET mode = 'local' WHERE id = 1"),
    sql(
      `INSERT INTO connections (id, owner_id, toolkit, connected_account_id, status, confirmed_at, created_at, updated_at, write_id) VALUES (:id,:owner,'mail',:account,'active',:now,:now,:now,:id)`,
      { id: connection, owner, account: `ca_${connection}`, now: int(env.clock) },
    ),
  ]);
});
afterEach(async () => env.close());

async function pauses(count: number, task: string | null = null) {
  const key = await repository.accountKeys.require(owner);
  const items: { approval: string; run: string; conversation: string }[] = [];
  const statements: Statement[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const a = { approval: uuidv7(), run: uuidv7(), conversation: uuidv7() };
      items.push(a);
      statements.push(
        sql(
          `INSERT INTO conversations (id,owner_id,kind,task_id,active_run_id,expires_at,created_at,updated_at,write_id) VALUES (:id,:owner,:kind,${task ? ":task" : "NULL"},:run,${task ? "NULL" : ":expiry"},:now,:now,:id)`,
          {
            id: a.conversation,
            owner,
            kind: task ? "task" : "quick",
            ...(task ? { task } : { expiry: int(env.clock + 86400000) }),
            run: a.run,
            now: int(env.clock),
          },
        ),
        sql(
          `INSERT INTO runs (id,conversation_id,owner_id,task_id,kind,status,executor,executor_generation,tier,created_at,write_id) VALUES (:id,:conversation,:owner,${task ? ":task" : "NULL"},'turn','awaiting_approval','local',1,'fast',:now,:id)`,
          {
            id: a.run,
            conversation: a.conversation,
            owner,
            ...(task ? { task } : {}),
            now: int(env.clock),
          },
        ),
        sql(
          `INSERT INTO approvals (id,owner_id,conversation_id,task_id,run_id,tool_call_id,tool_slug,connection_id,connected_account_id,arguments_enc,arg_digest,preview_enc,policy_version,expires_at,created_at,write_id) VALUES (:id,:owner,:conversation,${task ? ":task" : "NULL"},:run,'call','MAIL_SEND',:connection,:account,:arguments,'digest',:preview,'policy',:expiry,:now,:id)`,
          {
            id: a.approval,
            owner,
            conversation: a.conversation,
            ...(task ? { task } : {}),
            run: a.run,
            connection,
            account: `ca_${connection}`,
            arguments: encryptFieldText(
              key,
              simonField(owner, "approvals", a.approval, "arguments_enc"),
              "{}",
            ),
            preview: encryptFieldText(
              key,
              simonField(owner, "approvals", a.approval, "preview_enc"),
              "{}",
            ),
            expiry: int(env.clock + 86400000),
            now: int(env.clock),
          },
        ),
      );
    }
    await env.db.batch(statements);
    return items;
  } finally {
    zeroize(key.key);
  }
}

async function change(apply = true) {
  const write = uuidv7();
  await env.db.batch([
    sql(
      `UPDATE connections SET status = 'disconnected', generation = generation + 1, write_id = :w WHERE id = :connection AND owner_id = :owner AND ${apply ? "1" : "0"}`,
      { w: write, connection, owner },
    ),
    ...connectionApprovalExpiryStatements(repository, {
      ownerId: owner,
      connectionId: connection,
      writeId: write,
      now: env.clock,
    }),
  ]);
  return write;
}

describe("set-based connection approval expiry", () => {
  it("expires and continues more than 64 approvals in a constant five statements with fixed bind counts", async () => {
    const items = await pauses(100);
    const write = await change();
    const statements = connectionApprovalExpiryStatements(repository, {
      ownerId: owner,
      connectionId: connection,
      writeId: write,
      now: env.clock,
    });
    expect(statements).toHaveLength(5);
    expect(statements.every((statement) => statement.params.length < 30)).toBe(true);
    const [approvals, runs, conversations, intents] = await env.db.batch([
      sql("SELECT status, count(*) AS count FROM approvals GROUP BY status"),
      sql("SELECT kind, status, count(*) AS count FROM runs GROUP BY kind,status"),
      sql("SELECT active_run_id FROM conversations ORDER BY active_run_id"),
      sql("SELECT subject_id FROM dispatch_intents ORDER BY subject_id"),
    ]);
    expect(approvals?.results).toEqual([{ status: "expired", count: 100 }]);
    expect(runs?.results).toEqual([
      { kind: "continuation", status: "queued", count: 100 },
      { kind: "turn", status: "completed", count: 100 },
    ]);
    const ids = items.map((item) => item.approval).sort();
    expect(conversations?.results.map((row) => row.active_run_id)).toEqual(ids);
    expect(intents?.results.map((row) => row.subject_id)).toEqual(ids);
    await env.db.batch(statements);
    expect(await env.count("runs")).toBe(200);
    expect(await env.count("dispatch_intents")).toBe(100);
  });

  it("does nothing when the deciding connection CAS loses", async () => {
    await pauses(2);
    await change(false);
    expect(await env.db.all(sql("SELECT status FROM approvals"))).toEqual([
      { status: "pending" },
      { status: "pending" },
    ]);
    expect(await env.count("runs")).toBe(2);
    expect(await env.count("dispatch_intents")).toBe(0);
  });

  it.each(["relock", "archive", "stop", "expired_chat", "executor_unset"])(
    "expires without starting an unauthorized continuation after %s",
    async (reason) => {
      const task = reason === "archive" ? await env.createTask(owner) : null;
      const [item] = await pauses(1, task);
      if (reason === "relock") await env.relock(owner);
      if (reason === "archive") await env.archiveTask(task ?? "");
      if (reason === "stop")
        await env.db.run(
          sql("UPDATE runs SET cancel_requested_at = :now WHERE id = :id", {
            now: int(env.clock),
            id: item?.run ?? "",
          }),
        );
      if (reason === "expired_chat")
        await env.db.run(
          sql("UPDATE conversations SET expires_at = :now", { now: int(env.clock) }),
        );
      if (reason === "executor_unset")
        await env.db.run(sql("UPDATE executor_state SET mode = NULL"));
      await change();
      expect(await env.db.all(sql("SELECT status FROM approvals"))).toEqual([
        { status: "expired" },
      ]);
      expect(await env.count("runs")).toBe(1);
      expect(await env.count("dispatch_intents")).toBe(0);
    },
  );

  it("adopts the current executor generation for continuation, not the paused run's old generation", async () => {
    const [item] = await pauses(1);
    await env.db.run(sql("UPDATE executor_state SET mode = 'durable', generation = 9"));
    await change();
    expect(
      await env.db.first(
        sql(
          "SELECT executor, executor_generation, approval_id, continues_run_id FROM runs WHERE kind = 'continuation'",
        ),
      ),
    ).toEqual({
      executor: "trigger",
      executor_generation: 9,
      approval_id: item?.approval,
      continues_run_id: item?.run,
    });
  });
});
