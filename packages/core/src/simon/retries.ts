import { zeroize } from "@symplist/crypto";
import { int, sql } from "@symplist/db";
import {
  assertFoldOwner,
  guardedCompletion,
  releaseUnapplied,
  type SimonWriteFold,
} from "./fold.ts";
import type { SimonRepository } from "./repository.ts";
import { SimonError } from "./types.ts";

/** Explicit Retry continues persisted history. It does not reopen or copy external-action intents. */
export class SimonRetries {
  constructor(readonly repository: SimonRepository) {}

  async create(
    ownerId: string,
    previousRunId: string,
    fold?: SimonWriteFold,
  ): Promise<{ runId: string }> {
    assertFoldOwner(fold, ownerId);
    const { repository: repo } = this;
    const key = await repo.accountKeys.require(ownerId);
    try {
      const now = repo.options.now();
      const runId = repo.nextId();
      const writeId = repo.nextId();
      const authority = sql(
        `EXISTS (SELECT 1 FROM runs previous JOIN conversations c ON c.id = previous.conversation_id
        WHERE previous.id = :previous AND previous.owner_id = :owner AND c.owner_id = :owner
        AND ${repo.access()} AND (c.expires_at IS NULL OR c.expires_at > :now)
        AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner))
        ${fold?.authorization ? `AND (${fold.authorization.sql})` : ""}`,
        { previous: previousRunId, owner: ownerId, now: int(now), ...fold?.authorization?.params },
      );
      const applied = sql(
        "EXISTS (SELECT 1 FROM runs WHERE id = :next AND owner_id = :owner AND write_id = :w)",
        { next: runId, owner: ownerId, w: writeId },
      );
      const response = { runId };
      const result = await repo.options.db.batch([
        ...(fold?.statements ?? []),
        sql(
          `UPDATE conversations AS c SET active_run_id = :next, updated_at = :now, write_id = :w
          WHERE owner_id = :owner AND active_run_id IS NULL AND ${repo.access()} AND ${repo.activeTask("c")}
          AND (expires_at IS NULL OR expires_at > :now)
          AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :owner)
          AND EXISTS (SELECT 1 FROM executor_state WHERE id = 1 AND mode IS NOT NULL)
          AND EXISTS (SELECT 1 FROM runs previous WHERE previous.id = :previous AND previous.owner_id = :owner
            AND previous.conversation_id = c.id AND previous.status IN ('stopped', 'interrupted', 'failed'))
          AND NOT EXISTS (SELECT 1 FROM runs WHERE continues_run_id = :previous)
          ${fold ? `AND ${fold.claim.guard.exists}` : ""}
          ${fold?.authorization ? `AND (${fold.authorization.sql})` : ""}`,
          {
            next: runId,
            owner: ownerId,
            previous: previousRunId,
            now: int(now),
            w: writeId,
            ...(fold?.claim.guard.params ?? {}),
            ...fold?.authorization?.params,
          },
        ),
        sql(
          `INSERT INTO runs (id, owner_id, conversation_id, task_id, kind, continues_run_id, approval_id, ask_id,
          executor, executor_generation, tier, created_at, write_id)
          SELECT :next, :owner, c.id, c.task_id, 'retry', previous.id,
          CASE WHEN a.id IS NOT NULL THEN a.id WHEN q.id IS NOT NULL THEN NULL ELSE previous.approval_id END,
          CASE WHEN q.id IS NOT NULL THEN q.id WHEN a.id IS NOT NULL THEN NULL ELSE previous.ask_id END,
          CASE e.mode WHEN 'durable' THEN 'trigger' ELSE 'local' END, e.generation, previous.tier, :now, :w
          FROM runs previous JOIN conversations c ON c.id = previous.conversation_id
          LEFT JOIN approvals a ON a.id = (SELECT id FROM approvals WHERE run_id = previous.id
            AND owner_id = previous.owner_id AND status != 'superseded' ORDER BY created_at DESC, id DESC LIMIT 1)
          LEFT JOIN user_asks q ON q.id = (SELECT id FROM user_asks WHERE run_id = previous.id
            AND owner_id = previous.owner_id ORDER BY created_at DESC, id DESC LIMIT 1)
          CROSS JOIN executor_state e
          WHERE previous.id = :previous AND previous.owner_id = :owner AND e.id = 1
          AND c.active_run_id = :next AND c.write_id = :w`,
          { next: runId, owner: ownerId, previous: previousRunId, now: int(now), w: writeId },
        ),
        ...repo.dispatchStatements(runId, now),
        ...(fold
          ? [
              releaseUnapplied(fold, applied),
              guardedCompletion(fold.completion({ status: 202, body: response }, key), applied),
            ]
          : []),
        {
          sql: `SELECT (${authority.sql}) AS allowed, (${applied.sql}) AS applied`,
          params: [...authority.params, ...applied.params],
        },
      ]);
      const row = result.at(-1)?.results[0];
      if (row?.allowed !== 1) throw new SimonError("not_found");
      if (fold) {
        const decision = fold.decide(result, key, 0);
        if (decision.kind === "replay") return decision.body as typeof response;
      }
      if (row.applied !== 1) throw new SimonError("simon.stale");
      return response;
    } finally {
      zeroize(key.key);
    }
  }
}
