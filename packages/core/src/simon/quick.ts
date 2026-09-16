import {
  simonQuickClosedSchema,
  simonQuickSavedSchema,
  type simonQuickSaveInputSchema,
} from "@symplist/contracts";
import { zeroize } from "@symplist/crypto";
import { int, sql } from "@symplist/db";
import { TaskOperationError } from "../tasks/errors.ts";
import { TaskService, type TaskWriteFold } from "../tasks/service.ts";
import {
  assertFoldOwner,
  guardedCompletion,
  releaseUnapplied,
  type SimonWriteFold,
} from "./fold.ts";
import { quickDeleteStatements } from "./quick-delete.ts";
import type { SimonRepository } from "./repository.ts";
import { SimonError } from "./types.ts";

/** Owner-only quick-chat lifecycle; never registered as an MCP or model tool. */
export class SimonQuickChats {
  constructor(
    readonly repository: SimonRepository,
    readonly onSaved?: (
      ownerId: string,
      collection: typeof simonQuickSaveInputSchema._output.collection,
      eventId: string,
    ) => Promise<void>,
  ) {}

  async close(ownerId: string, conversationId: string, fold?: SimonWriteFold) {
    assertFoldOwner(fold, ownerId);
    if (fold?.authorization) throw new SimonError("not_found");
    const repo = this.repository;
    const loaded = await repo.options.db.batch([
      repo.accountKeys.selectStatement(ownerId),
      sql(
        "SELECT active_run_id FROM conversations WHERE id=:id AND owner_id=:owner AND kind='quick'",
        { id: conversationId, owner: ownerId },
      ),
    ]);
    const keyRow = loaded[0]?.results[0];
    if (!keyRow) throw new SimonError("not_found");
    const key = repo.accountKeys.unwrapRow(keyRow);
    try {
      const runId = loaded[1]?.results[0]?.active_run_id;
      const response = { conversationId, runId: typeof runId === "string" ? runId : null };
      const writeId = repo.nextId();
      const authority = `${repo.access()} AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id=:owner)`;
      const marker = { sql: "write_id=:qd_write", params: { qd_write: writeId } };
      const applied = sql(
        "EXISTS (SELECT 1 FROM conversations WHERE id=:id AND owner_id=:owner AND write_id=:write)",
        { id: conversationId, owner: ownerId, write: writeId },
      );
      const before = [
        ...(fold?.statements ?? []),
        sql(
          `UPDATE conversations SET write_id=:write WHERE id=:id AND owner_id=:owner AND kind='quick' AND active_run_id IS :run AND (${authority}) ${fold ? `AND ${fold.claim.guard.exists}` : ""}`,
          {
            id: conversationId,
            owner: ownerId,
            write: writeId,
            run: response.runId,
            ...fold?.claim.guard.params,
          },
        ),
        { sql: `SELECT (${applied.sql}) AS applied`, params: applied.params },
      ];
      const appliedAt = before.length - 1;
      const results = await repo.options.db.batch([
        ...before,
        ...(fold
          ? [
              releaseUnapplied(fold, applied),
              guardedCompletion(fold.completion({ status: 200, body: response }, key), applied),
            ]
          : []),
        ...quickDeleteStatements(conversationId, ownerId, repo.options.now(), marker),
        sql(`SELECT (${authority}) AS allowed`, { owner: ownerId }),
      ]);
      if (results.at(-1)?.results[0]?.allowed !== 1) throw new SimonError("not_found");
      const decision = fold?.decide(results, key, 0);
      if (decision?.kind === "replay") return simonQuickClosedSchema.parse(decision.body);
      if (results[appliedAt]?.results[0]?.applied !== 1) throw new SimonError("not_found");
      return response;
    } finally {
      zeroize(key.key);
    }
  }

  async save(
    ownerId: string,
    conversationId: string,
    input: typeof simonQuickSaveInputSchema._output,
    fold?: SimonWriteFold,
  ) {
    assertFoldOwner(fold, ownerId);
    // Incoming agent authorization is deliberately not an alternate route into an owner action.
    if (fold?.authorization) throw new SimonError("not_found");
    const repo = this.repository;
    const taskId = conversationId; // Separate primary-key namespaces, stable even after a lost reply.
    const response = { conversationId, taskId, collection: input.collection };
    const taskFold: TaskWriteFold | undefined = fold
      ? {
          ...fold,
          completion: (_result, key) => fold.completion({ status: 201, body: response }, key),
        }
      : undefined;
    try {
      const result = await new TaskService(repo.options).create({
        ownerId,
        actor: { kind: "user" },
        title: input.title,
        collection: input.collection,
        taskId,
        ...(taskFold ? { fold: taskFold } : {}),
        authorization: {
          sql: `EXISTS (SELECT 1 FROM conversations WHERE id=:task_auth_conversation AND owner_id=:task_auth_quick_owner AND ((kind='quick' AND active_run_id IS NULL AND expires_at>CAST(:task_auth_now AS INTEGER)) OR (kind='task' AND task_id=:task_auth_conversation)))`,
          params: {
            task_auth_conversation: conversationId,
            task_auth_quick_owner: ownerId,
            task_auth_now: int(repo.options.now()),
          },
        },
        attach: (context) => [
          sql(
            `UPDATE conversations SET kind='task',task_id=:quick_task,expires_at=NULL,context_epoch=context_epoch+1,updated_at=:quick_now,write_id=:quick_write WHERE id=:quick_conversation AND owner_id=:quick_owner AND kind='quick' AND active_run_id IS NULL AND ${context.guard}`,
            {
              ...context.guardParams,
              quick_task: taskId,
              quick_conversation: conversationId,
              quick_owner: ownerId,
              quick_now: int(context.now),
              quick_write: context.writeId,
            },
          ),
          sql(
            `UPDATE runs SET task_id=:quick_task WHERE conversation_id=:quick_conversation AND owner_id=:quick_owner AND EXISTS (SELECT 1 FROM conversations WHERE id=:quick_conversation AND owner_id=:quick_owner AND write_id=:quick_write)`,
            {
              quick_task: taskId,
              quick_conversation: conversationId,
              quick_owner: ownerId,
              quick_write: context.writeId,
            },
          ),
        ],
      });
      if (result.kind === "replay") return simonQuickSavedSchema.parse(result.body);
      try {
        await this.onSaved?.(ownerId, input.collection, result.analytics?.eventId ?? repo.nextId());
      } catch {
        // Consent telemetry never changes a confirmed save's outcome.
      }
      return response;
    } catch (error) {
      if (error instanceof TaskOperationError) throw new SimonError(error.code);
      throw error;
    }
  }
}
