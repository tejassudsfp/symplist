import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountKeyStore } from "@symplist/core/account";
import { type DocumentGitJobActor, DurableDocumentGit } from "@symplist/core/documents";
import { SimonRepository } from "@symplist/core/simon";
import { createKeyProvider, type ManagedKeyProvider } from "@symplist/crypto";
import {
  applyMigrations,
  createLocalSqliteClient,
  int,
  type LocalSqliteClient,
  sql,
  uuidv7,
} from "@symplist/db";
import { createLocalObjectStore } from "@symplist/storage";
import { resourceCatalog } from "@trigger.dev/core/v3";
import { AbortTaskRunError } from "@trigger.dev/sdk";
import { runInMockTaskContext } from "@trigger.dev/sdk/ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkerLogger } from "../../infra/logger.ts";
import { documentGit } from "./document-git.ts";
import { documentsMaintenance } from "./documents-maintenance.ts";
import {
  createDocumentWorker,
  type DocumentWorker,
  runDocumentGitTask,
  runDocumentsMaintenanceTask,
} from "./documents-runtime.ts";

describe("document-git task declaration (§8.8)", () => {
  it("runs on the d1-git queue, small-1x, with one OOM retry on medium-1x", () => {
    expect(resourceCatalog.getTaskManifest(documentGit.id)).toMatchObject({
      id: "document-git",
      queue: { name: "d1-git" },
      machine: { preset: "small-1x" },
      maxDuration: 300,
      retry: { maxAttempts: 2, outOfMemory: { machine: "medium-1x" } },
    });
    expect(resourceCatalog.getTaskManifest(documentsMaintenance.id)).toMatchObject({
      id: "documents-maintenance",
      queue: { name: "d1" },
      retry: { maxAttempts: 2 },
    });
  });

  it("ends a run with an invalid payload at once, without content in the error", async () => {
    const run = resourceCatalog.getTask(documentGit.id)?.fns.run;
    await runInMockTaskContext(
      async ({ ctx }) => {
        const attempt = run?.(
          { runId: "x", toolCallId: "y", taskId: "z", op: "update_section", markdown: "secret" },
          {
            ctx,
            signal: new AbortController().signal,
          } as never,
        );
        await expect(attempt).rejects.toBeInstanceOf(AbortTaskRunError);
        await expect(attempt).rejects.toMatchObject({ message: "document_git.payload_invalid" });
      },
      { ctx: { run: { id: "run_docgittest" }, attempt: { number: 1 } } as never },
    );
  });
});

describe("document-git body with local drivers (§9.1, §8.3)", () => {
  let dir: string;
  let db: LocalSqliteClient;
  let worker: DocumentWorker;
  let accountKeys: AccountKeyStore;
  let keys: ManagedKeyProvider;
  const logLines: string[] = [];
  const announced: unknown[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "symplist-worker-docs-"));
    db = createLocalSqliteClient({ path: join(dir, "d1.sqlite"), env: {} });
    await applyMigrations(db);
    keys = createKeyProvider(
      { CONTENT_KEK: { current: 1, versions: new Map([[1, randomBytes(32)]]) } },
      { required: ["CONTENT_KEK"] },
    );
    accountKeys = new AccountKeyStore({ db, keys });
    logLines.length = 0;
    announced.length = 0;
    worker = createDocumentWorker({
      db,
      objects: createLocalObjectStore({ root: join(dir, "objects"), env: {} }),
      keys,
      logger: createWorkerLogger({
        info: (message, properties) => logLines.push(JSON.stringify({ message, properties })),
        warn: (message, properties) => logLines.push(JSON.stringify({ message, properties })),
        error: (message, properties) => logLines.push(JSON.stringify({ message, properties })),
      }),
      events: {
        announce: async (event) => {
          announced.push(event);
          return "delivered";
        },
      },
      config: {
        GIT_TMP_DIR: join(dir, "git"),
        DOC_MAX_BYTES: 1_048_576,
        BETA_ACCESS_REQUIRED: true,
      },
    });
  });

  afterEach(() => {
    db.close();
    keys.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it("publishes through encrypted job objects, announces ids only, and keeps content out of every Trigger sink", async () => {
    const now = Date.UTC(2026, 8, 15, 9);
    const owner = uuidv7(now);
    const taskId = uuidv7(now);
    await db.batch([
      sql(
        `INSERT INTO users (id, email, email_verified_at, beta_state, onboarding_step, created_at, updated_at, write_id)
         VALUES (:id, :email, :now, 'unlocked', 'done', :now, :now, :w)`,
        { id: owner, email: `${owner}@example.test`, now: int(now), w: uuidv7(now) },
      ),
      accountKeys.provisionStatement({ userId: owner, now }),
      sql(
        `INSERT INTO tasks (id, owner_id, collection, position, source, write_id, title_enc, created_at, updated_at)
         VALUES (:id, :owner, 'now', 'a0', 'user', :w, 'sym1.1.x.y', :now, :now)`,
        { id: taskId, owner, w: uuidv7(now), now: int(now) },
      ),
    ]);
    const marker = "MARKER-worker-document-git";
    await db.run(sql("UPDATE executor_state SET mode = 'durable'"));
    const simon = new SimonRepository({
      db,
      keys,
      now: () => now,
      policy: { betaAccessRequired: true },
      quickChatTtlHours: 24,
    });
    const conversationId = await simon.createConversation(owner, taskId);
    const accepted = await simon.acceptMessage(owner, conversationId, "document-job", {
      text: "Edit page",
      tier: "fast",
    });
    const claim = await simon.claim(String(accepted.runId), "trigger");
    if (!claim) throw new Error("missing claim");
    simon.releaseClaim(claim);
    const payloads: unknown[] = [];
    const results: unknown[] = [];
    const durable = new DurableDocumentGit({
      artifacts: worker.repository.artifacts,
      now: () => now,
      triggerAndWait: async (_task, payload, options) => {
        payloads.push({ payload, options });
        const result = await runDocumentGitTask(payload, worker);
        results.push(result);
        return { ok: result.status === "completed" };
      },
    });
    const actor: DocumentGitJobActor = {
      conversationId,
      runId: claim.run.id,
      toolCallId: "call_worker_1",
      contextEpoch: 0,
      mode: "task",
      taskId,
      executorGeneration: 1,
    };
    const accountKey = await accountKeys.require(owner);
    const outcome = await durable.run({
      ownerId: owner,
      taskId,
      accountKey,
      actor,
      op: "update_section",
      args: { taskId, expectedRevision: null, placement: "end", markdown: `## Notes\n${marker}` },
      remainingBudgetBytes: 10_000,
    });
    expect(outcome.result).toMatchObject({ status: "published", generation: 1 });
    expect(announced).toEqual([
      expect.objectContaining({
        type: "document.head_changed",
        ownerId: owner,
        payload: expect.objectContaining({ taskId, generation: 1, author: "simon" }),
      }),
    ]);
    for (const sink of [payloads, results, announced, logLines]) {
      expect(JSON.stringify(sink)).not.toContain(marker);
    }
    expect(await worker.git.tempRoot.list()).toEqual([]);
    const maintenance = await runDocumentsMaintenanceTask(worker);
    expect(maintenance).toMatchObject({ complete: true, passes: 1 });
  });
});
