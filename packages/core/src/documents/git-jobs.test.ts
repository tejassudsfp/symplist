import { type DocumentGitPayload, documentsTools } from "@symplist/contracts";
import { int, sql, uuidv7 } from "@symplist/db";
import { DocumentError, jobObjectKey } from "@symplist/docs";
import { createLocalObjectStore } from "@symplist/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountPurgeRunner } from "../account/purge.ts";
import { accountPurgeContributor } from "../account/purge-contributors/account.ts";
import { documentsPurgeContributor } from "../account/purge-contributors/documents.ts";
import type { PurgeContributor } from "../account/purge-contributors/types.ts";
import {
  type DocumentGitJobActor,
  DurableDocumentGit,
  executorGenerationGuard,
  runDocumentGitJob,
} from "./git-jobs.ts";
import { DocumentMaintenance } from "./maintenance.ts";
import { createDocumentsTestEnvironment, type DocumentsTestEnvironment } from "./test-support.ts";

let env: DocumentsTestEnvironment;
let owner: string;
let task: string;

beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
  owner = await env.createUser();
  task = await env.createTask(owner);
});

afterEach(async () => {
  await env.close();
});

const runId = "0192f0a0-0000-7000-8000-000000000601";

function jobActor(
  toolCallId: string,
  overrides: Partial<DocumentGitJobActor> = {},
): DocumentGitJobActor {
  return {
    conversationId: "0192f0a0-0000-7000-8000-000000000501",
    runId,
    toolCallId,
    contextEpoch: 0,
    mode: "task",
    taskId: task,
    executorGeneration: 1,
    ...overrides,
  };
}

describe("document-git jobs (§9.1, §8.3)", () => {
  it("runs Git tools through encrypted job objects with ids-only payloads and cleans up", async () => {
    const triggered: Array<{ payload: DocumentGitPayload; idempotencyKey: string }> = [];
    const worker = (payload: unknown) =>
      runDocumentGitJob({
        payload,
        db: env.db,
        accountKeys: env.repository.accountKeys,
        artifacts: env.repository.artifacts,
        tools: env.tools,
        now: () => env.clock,
      });
    const durable = new DurableDocumentGit({
      artifacts: env.repository.artifacts,
      now: () => env.clock,
      triggerAndWait: async (_taskId, payload, options) => {
        triggered.push({ payload, idempotencyKey: options.idempotencyKey });
        const result = await worker(payload);
        return { ok: result.status === "completed" };
      },
    });
    const marker = "MARKER-document-git-payload";
    const accountKey = await env.repository.accountKeys.require(owner);
    const published = await durable.run({
      ownerId: owner,
      taskId: task,
      accountKey,
      actor: jobActor("call_publish"),
      op: "update_section",
      args: {
        taskId: task,
        expectedRevision: null,
        placement: "end",
        markdown: `## Notes\n${marker}`,
      },
      remainingBudgetBytes: 50_000,
    });
    expect(published.result).toMatchObject({ status: "published", generation: 1 });
    expect(triggered).toEqual([
      {
        payload: { runId, toolCallId: "call_publish", taskId: task, op: "update_section" },
        idempotencyKey: "call_publish",
      },
    ]);
    expect(JSON.stringify(triggered)).not.toContain(marker);
    expect((await env.objects.list({ prefix: `u/${owner}/jobs/` })).objects).toEqual([]);

    const history = await durable.run({
      ownerId: owner,
      taskId: task,
      accountKey,
      actor: jobActor("call_history"),
      op: "history",
      args: { taskId: task },
      remainingBudgetBytes: 50_000,
    });
    expect(history.result).toMatchObject({ items: [{ author: "simon", kind: "create" }] });

    const conflict = await durable
      .run({
        ownerId: owner,
        taskId: task,
        accountKey,
        actor: jobActor("call_conflict"),
        op: "update_section",
        args: { taskId: task, expectedRevision: null, placement: "end", markdown: "## Late" },
        remainingBudgetBytes: 50_000,
      })
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(DocumentError);
    expect((conflict as DocumentError).code).toBe("document.conflict");
    expect(Object.keys(documentsTools)).toContain("task_document_update_section");
  });

  it("reuses a completed output on a retried attempt and refuses mismatched or missing input", async () => {
    const accountKey = await env.repository.accountKeys.require(owner);
    const payload = {
      runId,
      toolCallId: "call_retry",
      taskId: task,
      op: "update_section" as const,
    };
    const input = {
      v: 1,
      op: "update_section",
      actor: jobActor("call_retry"),
      args: { taskId: task, expectedRevision: null, placement: "end", markdown: "## Retry" },
      remainingBudgetBytes: 1_000,
    };
    await env.repository.artifacts.putJob(
      accountKey,
      { ownerId: owner, runId, toolCallId: "call_retry", direction: "in" },
      input,
      uuidv7(env.clock),
    );
    const job = () =>
      runDocumentGitJob({
        payload,
        db: env.db,
        accountKeys: env.repository.accountKeys,
        artifacts: env.repository.artifacts,
        tools: env.tools,
        now: () => env.clock,
      });
    expect(await job()).toEqual({ status: "completed", code: null });
    expect(await job()).toEqual({ status: "completed", code: null });
    expect(await env.count("doc_commits")).toBe(1);

    const run = (value: unknown) =>
      runDocumentGitJob({
        payload: value,
        db: env.db,
        accountKeys: env.repository.accountKeys,
        artifacts: env.repository.artifacts,
        tools: env.tools,
        now: () => env.clock,
      });
    expect(await run({ ...payload, markdown: "x" })).toEqual({
      status: "failed",
      code: "document_git.payload_invalid",
    });
    expect(await run({ ...payload, toolCallId: "call_missing" })).toEqual({
      status: "failed",
      code: "document_git.input_invalid",
    });
    await env.repository.artifacts.putJob(
      accountKey,
      { ownerId: owner, runId, toolCallId: "call_other", direction: "in" },
      { ...input, actor: jobActor("call_forged") },
      uuidv7(env.clock),
    );
    expect(await run({ ...payload, toolCallId: "call_other" })).toEqual({
      status: "failed",
      code: "document_git.input_invalid",
    });
    expect(await run({ ...payload, taskId: "0192f0a0-0000-7000-8000-00000000dead" })).toEqual({
      status: "failed",
      code: "not_found",
    });
    expect(
      jobObjectKey({ ownerId: owner, runId, toolCallId: "call_retry", direction: "out" }),
    ).toContain("/jobs/");
  });

  it("refuses to write after the executor generation moved", async () => {
    await env.db.run(sql(`UPDATE executor_state SET generation = 2 WHERE id = 1`));
    const actor = { ...env.simon(owner, task), guards: [executorGenerationGuard(1)] };
    const error = await env.tools
      .updateSection(actor, {
        taskId: task,
        expectedRevision: null,
        placement: "end",
        markdown: "## Retired",
      })
      .catch((failure: unknown) => failure);
    expect((error as DocumentError).code).toBe("document.read_only");
    expect(await env.count("doc_commits")).toBe(0);
  });
});

describe("maintenance and purge (§5.6, §9.2)", () => {
  it("sweeps expired requests and old receipts in bounded batches", async () => {
    const seeded = await env.tools.updateSection(env.simon(owner, task), {
      taskId: task,
      expectedRevision: null,
      placement: "end",
      markdown: "## A\nx",
    });
    const outline = await env.tools.outline(env.simon(owner, task), { taskId: task });
    const read = await env.tools.readSection(env.simon(owner, task), {
      taskId: task,
      sectionId: outline.entries[0]?.sectionId as string,
      revision: seeded.revision as string,
    });
    if (read.receipt) await env.tools.recordReceipts([read.receipt]);
    const maintenance = new DocumentMaintenance({
      db: env.db,
      objects: env.objects,
      git: env.git,
      orphans: { graceMs: 1_000 },
    });
    const early = await maintenance.run({ now: env.clock });
    expect(early).toMatchObject({ expiredRequests: 0, expiredReceipts: 0 });
    const late = await maintenance.run({ now: env.clock + 31 * 24 * 60 * 60 * 1000 });
    expect(late).toMatchObject({ expiredRequests: 1, expiredReceipts: 1 });
  });

  it("purges document rows and artifacts of a deleted account in bounded batches and keeps other accounts", async () => {
    const other = await env.createUser();
    const otherTask = await env.createTask(other);
    let head: string | null = null;
    for (let n = 0; n < 3; n += 1) {
      const result = await env.tools.updateSection(env.simon(owner, task), {
        taskId: task,
        expectedRevision: head,
        placement: "end",
        markdown: `## S${n}\ntext`,
      });
      head = result.revision;
      env.clock += 1_000;
    }
    await env.tools.updateSection(env.simon(other, otherTask), {
      taskId: otherTask,
      expectedRevision: null,
      placement: "end",
      markdown: "## Kept",
    });
    const outline = await env.tools.outline(env.simon(owner, task), { taskId: task });
    const read = await env.tools.readSection(env.simon(owner, task), {
      taskId: task,
      sectionId: outline.entries[0]?.sectionId as string,
      revision: head as string,
    });
    if (read.receipt) await env.tools.recordReceipts([read.receipt]);
    env.clock += 3_000;
    await env.service.putDraft(env.user(owner), {
      taskId: task,
      baseRevision: head,
      clientSeq: 1,
      markdown: "draft",
    });

    await env.db.batch([
      sql(
        `UPDATE users SET deletion_state = 'deleting', deletion_requested_at = :now WHERE id = :user`,
        { now: int(env.clock), user: owner },
      ),
      sql(
        `INSERT INTO account_deletions (user_id, email_digest, email_digest_version, composio_user_id, r2_prefix, requested_at, updated_at, write_id)
         VALUES (:user, 'digest', 1, :user, :prefix, :now, :now, 'w')`,
        { user: owner, prefix: `u/${owner}/`, now: int(env.clock) },
      ),
    ]);
    const tasksContributor: PurgeContributor = {
      domain: "tasks",
      statements: ({ userId }) => [
        sql(`DELETE FROM tasks WHERE owner_id = :user`, { user: userId }),
      ],
      remaining: ({ userId }) => [
        sql(`SELECT EXISTS (SELECT 1 FROM tasks WHERE owner_id = :user) AS remaining`, {
          user: userId,
        }),
      ],
    };
    // The search domain owns search_intents; its purge body is not part of this feature.
    const searchContributor: PurgeContributor = {
      domain: "search",
      statements: ({ userId }) => [
        sql(`DELETE FROM search_intents WHERE owner_id = :user`, { user: userId }),
      ],
      remaining: ({ userId }) => [
        sql(`SELECT EXISTS (SELECT 1 FROM search_intents WHERE owner_id = :user) AS remaining`, {
          user: userId,
        }),
      ],
    };
    const runner = new AccountPurgeRunner({
      db: env.db,
      store: createLocalObjectStore({ root: `${env.dir}/objects`, env: {} }),
      now: () => env.clock,
      runs: { run: async () => "done" },
      composio: { run: async () => "done" },
      contributors: [
        documentsPurgeContributor,
        searchContributor,
        tasksContributor,
        accountPurgeContributor,
      ],
      batchLimit: 1,
      maxBatches: 3,
      maxObjectDeletes: 3,
    });
    let result = await runner.run(owner);
    let invocations = 1;
    while (result.status === "incomplete" && invocations < 40) {
      result = await runner.run(owner);
      invocations += 1;
    }
    expect(result.status).toBe("done");
    // Each invocation was bounded (3 object deletes, 3 batches of one row per statement).
    expect(invocations).toBeGreaterThanOrEqual(3);
    for (const table of [
      "doc_repos",
      "doc_commits",
      "doc_publish_requests",
      "doc_drafts",
      "read_receipts",
    ]) {
      const rows = await env.db.all(sql(`SELECT owner_id FROM ${table}`));
      expect(
        rows.every((row) => row.owner_id === other),
        table,
      ).toBe(true);
    }
    expect(await env.count("doc_commits")).toBe(1);
    expect((await env.objects.list({ prefix: `u/${owner}/` })).objects).toEqual([]);
    expect((await env.objects.list({ prefix: `u/${other}/` })).objects.length).toBeGreaterThan(0);
  });
});
