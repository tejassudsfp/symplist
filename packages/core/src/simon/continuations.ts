import { int, type Statement, sql } from "@symplist/db";
import type { SimonRepository } from "./repository.ts";

export type PauseTable = "approvals" | "user_asks";

/** The decision owns the conversation only while its original run is still the active pause. */
export function pauseGuard(repository: SimonRepository, table: PauseTable): string {
  const status = table === "approvals" ? "awaiting_approval" : "awaiting_user";
  return `EXISTS (SELECT 1 FROM runs JOIN conversations c ON c.id = runs.conversation_id
    WHERE runs.id = ${table}.run_id AND runs.owner_id = ${table}.owner_id
    AND runs.status = '${status}' AND c.active_run_id = runs.id AND runs.cancel_requested_at IS NULL
    AND ${repository.activeTask("runs")} AND (c.expires_at IS NULL OR c.expires_at > :now))
    AND EXISTS (SELECT 1 FROM executor_state WHERE id = 1 AND mode IS NOT NULL)`;
}

/** No queued chat message can get between a pause and the continuation that resolves it. */
export function continuationStatements(
  repository: SimonRepository,
  input: {
    readonly table: PauseTable;
    readonly pauseId: string;
    readonly ownerId: string;
    readonly runId: string;
    readonly nextRunId: string;
    readonly writeId: string;
    readonly now: number;
  },
): Statement[] {
  const { table } = input;
  const guard = `EXISTS (SELECT 1 FROM ${table} WHERE id = :pause AND owner_id = :owner AND run_id = :run AND write_id = :w)`;
  const p = { pause: input.pauseId, owner: input.ownerId, run: input.runId, w: input.writeId };
  const pausedStatus = table === "approvals" ? "awaiting_approval" : "awaiting_user";
  return [
    sql(
      `UPDATE runs SET status = 'completed', finished_at = :now, write_id = :w
      WHERE id = :run AND owner_id = :owner AND status = :paused_status AND ${guard}`,
      {
        ...p,
        run: input.runId,
        now: int(input.now),
        paused_status: pausedStatus,
      },
    ),
    sql(
      `UPDATE conversations SET active_run_id = :next, updated_at = :now, write_id = :w
      WHERE active_run_id = :run AND owner_id = :owner AND ${guard}`,
      {
        ...p,
        next: input.nextRunId,
        run: input.runId,
        now: int(input.now),
      },
    ),
    sql(
      `INSERT INTO runs (id, owner_id, conversation_id, task_id, kind, continues_run_id, approval_id, ask_id,
      executor, executor_generation, tier, created_at, write_id)
      SELECT :next, previous.owner_id, previous.conversation_id, previous.task_id, 'continuation', previous.id,
      ${table === "approvals" ? ":pause, NULL" : "NULL, :pause"},
      CASE e.mode WHEN 'durable' THEN 'trigger' ELSE 'local' END, e.generation, previous.tier, :now, :w
      FROM runs previous JOIN conversations c ON c.id = previous.conversation_id CROSS JOIN executor_state e
      WHERE previous.id = :run AND previous.write_id = :w AND c.active_run_id = :next AND e.id = 1 AND ${guard}`,
      {
        ...p,
        next: input.nextRunId,
        run: input.runId,
        now: int(input.now),
      },
    ),
    ...repository.dispatchStatements(input.nextRunId, input.now),
  ];
}
