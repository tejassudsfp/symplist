import { type DbClient, int, type Statement, sql, uuidv7 } from "@symplist/db";
import type { AccessPolicy } from "../access/evaluate.ts";
import { accessCondition } from "../access/sql.ts";
import type {
  ActiveExecution,
  ExecutionOutcomeCode,
  ExecutionTracker,
  ExecutorKind,
  RunRelaySource,
  RunRelayState,
} from "../events/execution.ts";
import { SimonError } from "./types.ts";

export function dispatchSimonStatements(runId: string, now: number): Statement[] {
  return [
    sql(
      `INSERT INTO dispatch_intents (id, owner_id, kind, subject_id, executor_generation, created_at, updated_at, write_id)
    SELECT :intent, owner_id, 'simon_run', id, executor_generation, :now, :now, :intent FROM runs
    WHERE id = :run AND status = 'queued' ON CONFLICT (kind, subject_id) DO NOTHING`,
      {
        intent: uuidv7(now),
        run: runId,
        now: int(now),
      },
    ),
  ];
}

/** Identical queue advancement for a normal finish, Stop, process loss and an executor switch. */
export function releaseSimonStatements(
  runId: string,
  writeId: string,
  now: number,
  policy: AccessPolicy,
): Statement[] {
  const nextRun = uuidv7(now);
  const access = accessCondition({
    level: "admitted",
    policy,
    userParam: "simon_owner",
  }).replaceAll(":simon_owner", "c.owner_id");
  return [
    sql(
      `UPDATE conversations SET active_run_id = NULL, write_id = :w WHERE active_run_id = :run
      AND EXISTS (SELECT 1 FROM runs WHERE id = :run AND write_id = :w AND status IN ('completed', 'stopped', 'interrupted', 'failed'))`,
      { run: runId, w: writeId },
    ),
    sql(
      `UPDATE conversations AS c SET active_run_id = :next WHERE write_id = :w AND active_run_id IS NULL
      AND (c.task_id IS NULL OR EXISTS (SELECT 1 FROM tasks t WHERE t.id = c.task_id AND t.owner_id = c.owner_id AND t.status = 'active'))
      AND ${access} AND (expires_at IS NULL OR expires_at > :now)
      AND EXISTS (SELECT 1 FROM executor_state WHERE id = 1 AND mode IS NOT NULL)
      AND EXISTS (SELECT 1 FROM messages WHERE conversation_id = c.id AND status = 'queued')`,
      { next: nextRun, w: writeId, now: int(now) },
    ),
    sql(
      `INSERT INTO runs (id, owner_id, conversation_id, task_id, kind, executor, executor_generation, tier, created_at, write_id)
      SELECT :next, c.owner_id, c.id, c.task_id, 'turn', CASE e.mode WHEN 'durable' THEN 'trigger' ELSE 'local' END,
      e.generation, (SELECT tier FROM messages WHERE conversation_id = c.id AND status = 'queued' ORDER BY seq LIMIT 1), :now, :w
      FROM conversations c CROSS JOIN executor_state e WHERE c.active_run_id = :next AND c.write_id = :w AND e.id = 1`,
      {
        next: nextRun,
        w: writeId,
        now: int(now),
      },
    ),
    sql(
      `UPDATE messages SET status = 'accepted', run_id = :next, write_id = :w
      WHERE id = (SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.active_run_id = :next AND c.write_id = :w AND m.status = 'queued' ORDER BY m.seq LIMIT 1)`,
      { next: nextRun, w: writeId },
    ),
    ...dispatchSimonStatements(nextRun, now),
  ];
}

export class SimonExecutionTracker implements ExecutionTracker {
  constructor(
    readonly db: DbClient,
    readonly policy: AccessPolicy = { betaAccessRequired: true },
  ) {}

  async listActive(query: {
    executor: ExecutorKind;
    limit: number;
    after?: string;
    ownerId?: string;
  }): Promise<readonly ActiveExecution[]> {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 500)
      throw new SimonError("validation");
    const rows = await this.db.all(
      sql(
        `SELECT * FROM runs WHERE executor = :executor AND status IN ('queued', 'running')
      ${query.after ? "AND id > :after" : ""} ${query.ownerId ? "AND owner_id = :owner" : ""}
      ORDER BY id LIMIT :limit`,
        {
          executor: query.executor,
          limit: int(query.limit),
          ...(query.after ? { after: query.after } : {}),
          ...(query.ownerId ? { owner: query.ownerId } : {}),
        },
      ),
    );
    return rows.map((row) => ({
      subjectId: String(row.id),
      ownerId: String(row.owner_id),
      executor: row.executor as ExecutorKind,
      executorGeneration: Number(row.executor_generation),
      triggerRunId: row.trigger_run_id as string | null,
      heartbeatAt: row.heartbeat_at as number | null,
      startedAt: row.started_at as number | null,
      createdAt: Number(row.created_at),
      cancelRequestedAt: row.cancel_requested_at as number | null,
    }));
  }

  async recordDispatch(
    subjectId: string,
    dispatch: {
      executor: ExecutorKind;
      triggerRunId: string | null;
      generation: number;
      now: number;
    },
  ): Promise<void> {
    if (dispatch.executor === "local" && dispatch.triggerRunId !== null)
      throw new SimonError("validation");
    await this.db.run(
      sql(
        `UPDATE runs SET executor = :executor, executor_generation = :generation,
      trigger_run_id = COALESCE(trigger_run_id, :trigger), heartbeat_at = COALESCE(heartbeat_at, :now), write_id = :w
      WHERE id = :id AND status IN ('queued', 'running')
      AND (status = 'queued' OR (executor = :executor AND executor_generation = :generation))
      AND (trigger_run_id IS NULL OR (trigger_run_id = :trigger AND executor = :executor))
      AND EXISTS (SELECT 1 FROM executor_state WHERE id = 1 AND generation = :generation
        AND mode = :mode)`,
        {
          id: subjectId,
          executor: dispatch.executor,
          trigger: dispatch.triggerRunId,
          generation: int(dispatch.generation),
          now: int(dispatch.now),
          w: uuidv7(dispatch.now),
          mode: dispatch.executor === "trigger" ? "durable" : "local",
        },
      ),
    );
  }

  async recordHeartbeat(subjectIds: readonly string[], now: number): Promise<void> {
    if (!subjectIds.length) return;
    // Each statement stays under D1's 100 parameters, even for a burst of 100+ active chats.
    const statements: Statement[] = [];
    for (let start = 0; start < subjectIds.length; start += 90) {
      statements.push(
        sql(
          `UPDATE runs SET heartbeat_at = :now, write_id = :w
        WHERE id IN (:ids) AND executor = 'local' AND status = 'running'
        AND EXISTS (SELECT 1 FROM executor_state e WHERE e.id = 1 AND e.mode = 'local' AND e.generation = runs.executor_generation)`,
          {
            ids: subjectIds.slice(start, start + 90),
            now: int(now),
            w: uuidv7(now),
          },
        ),
      );
    }
    await this.db.batch(statements);
  }

  async markInterrupted(
    subjectId: string,
    outcome: { outcomeCode: ExecutionOutcomeCode; now: number },
  ): Promise<boolean> {
    return this.end(subjectId, "interrupted", outcome.outcomeCode, outcome.now);
  }

  async markStopped(subjectId: string, outcome: { now: number }): Promise<boolean> {
    return this.end(subjectId, "stopped", "stopped", outcome.now);
  }

  private async end(
    subjectId: string,
    status: "interrupted" | "stopped",
    outcomeCode: string,
    now: number,
  ): Promise<boolean> {
    const writeId = uuidv7(now);
    const result = await this.db.batch([
      sql(
        `UPDATE runs SET status = CASE WHEN cancel_requested_at IS NOT NULL THEN 'stopped' ELSE :status END,
        outcome_code = CASE WHEN cancel_requested_at IS NOT NULL THEN COALESCE(outcome_code, 'stopped') ELSE :code END,
        finished_at = :now, write_id = :w WHERE id = :id AND status IN ('queued', 'running')
        ${status === "stopped" ? "AND cancel_requested_at IS NOT NULL" : ""}`,
        { id: subjectId, status, code: outcomeCode, now: int(now), w: writeId },
      ),
      sql(
        `UPDATE dispatch_intents SET status = 'cancelled', cancelled_at = :now, updated_at = :now, write_id = :w
        WHERE subject_id = :id AND kind = 'simon_run' AND status = 'pending'
        AND EXISTS (SELECT 1 FROM runs WHERE id = :id AND write_id = :w)`,
        { id: subjectId, now: int(now), w: writeId },
      ),
      ...releaseSimonStatements(subjectId, writeId, now, this.policy),
      sql("SELECT id FROM runs WHERE id = :id AND write_id = :w", { id: subjectId, w: writeId }),
    ]);
    return Boolean(result.at(-1)?.results[0]);
  }
}

export class SimonRunRelaySource implements RunRelaySource {
  constructor(readonly db: DbClient) {}
  async ownership(runId: string) {
    const row = await this.db.first(
      sql("SELECT id, owner_id, conversation_id FROM runs WHERE id = :id", { id: runId }),
    );
    return row
      ? {
          runId: String(row.id),
          ownerId: String(row.owner_id),
          conversationId: String(row.conversation_id),
        }
      : null;
  }
  async state(runId: string): Promise<RunRelayState | null> {
    const row = await this.db.first(
      sql("SELECT status, executor_generation FROM runs WHERE id = :id", { id: runId }),
    );
    return row
      ? {
          status: row.status as RunRelayState["status"],
          executorGeneration: Number(row.executor_generation),
        }
      : null;
  }
}
