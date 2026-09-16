import { int, type Statement, sql } from "@symplist/db";
import type { SimonRepository } from "../simon/repository.ts";

/**
 * Set-based counterpart of SimonApprovals.expireStatements for a connection change. No approval
 * list, variable bind count or per-row D1 work. The deciding connection write fences every effect.
 * Each approval's UUIDv7 is reused in the run/dispatch table namespaces as its continuation id.
 */
export function connectionApprovalExpiryStatements(
  repository: SimonRepository,
  input: {
    ownerId: string;
    connectionId: string;
    writeId: string;
    now: number;
  },
): Statement[] {
  const common = { owner: input.ownerId, connection: input.connectionId, w: input.writeId };
  const effect = `EXISTS (SELECT 1 FROM connections WHERE id = :connection AND owner_id = :owner AND write_id = :w)`;
  const expired = `EXISTS (SELECT 1 FROM approvals a WHERE a.run_id = runs.id AND a.owner_id = :owner AND a.connection_id = :connection AND a.status = 'expired' AND a.write_id = :w)`;
  return [
    sql(
      `UPDATE approvals SET status = 'expired', decided_at = :now, write_id = :w
      WHERE owner_id = :owner AND connection_id = :connection AND status = 'pending' AND ${effect}`,
      { ...common, now: int(input.now) },
    ),
    sql(
      `UPDATE runs SET status = 'completed', finished_at = :now, write_id = :w
      WHERE owner_id = :owner AND status = 'awaiting_approval' AND cancel_requested_at IS NULL
      AND ${expired} AND ${effect} AND ${repository.access()} AND ${repository.activeTask("runs")}
      AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = runs.conversation_id AND c.owner_id = :owner
        AND c.active_run_id = runs.id AND (c.expires_at IS NULL OR c.expires_at > :now))
      AND EXISTS (SELECT 1 FROM executor_state WHERE id = 1 AND mode IS NOT NULL)`,
      { ...common, now: int(input.now) },
    ),
    sql(
      `INSERT INTO runs (id, owner_id, conversation_id, task_id, kind, continues_run_id, approval_id,
      executor, executor_generation, tier, created_at, write_id)
      SELECT a.id, previous.owner_id, previous.conversation_id, previous.task_id, 'continuation', previous.id, a.id,
        CASE e.mode WHEN 'durable' THEN 'trigger' ELSE 'local' END, e.generation, previous.tier, :now, :w
      FROM approvals a JOIN runs previous ON previous.id = a.run_id AND previous.owner_id = a.owner_id
      JOIN conversations c ON c.id = previous.conversation_id AND c.active_run_id = previous.id
      CROSS JOIN executor_state e
      WHERE a.owner_id = :owner AND a.connection_id = :connection AND a.status = 'expired' AND a.write_id = :w
        AND previous.status = 'completed' AND previous.write_id = :w AND e.id = 1 AND e.mode IS NOT NULL AND ${effect}
      ON CONFLICT (id) DO NOTHING`,
      { ...common, now: int(input.now) },
    ),
    sql(
      `UPDATE conversations SET active_run_id = (
        SELECT next.id FROM runs next WHERE next.conversation_id = conversations.id AND next.owner_id = :owner
        AND next.kind = 'continuation' AND next.write_id = :w AND next.continues_run_id = conversations.active_run_id
      ), updated_at = :now, write_id = :w WHERE owner_id = :owner AND ${effect}
      AND EXISTS (SELECT 1 FROM runs next WHERE next.conversation_id = conversations.id AND next.owner_id = :owner
        AND next.kind = 'continuation' AND next.write_id = :w AND next.continues_run_id = conversations.active_run_id)`,
      { ...common, now: int(input.now) },
    ),
    sql(
      `INSERT INTO dispatch_intents (id, owner_id, kind, subject_id, executor_generation, created_at, updated_at, write_id)
      SELECT runs.id, runs.owner_id, 'simon_run', runs.id, runs.executor_generation, :now, :now, :w FROM runs
      JOIN conversations c ON c.id = runs.conversation_id AND c.active_run_id = runs.id
      WHERE runs.owner_id = :owner AND runs.write_id = :w AND runs.kind = 'continuation' AND runs.status = 'queued' AND ${effect}
      ON CONFLICT (kind, subject_id) DO NOTHING`,
      { ...common, now: int(input.now) },
    ),
  ];
}
