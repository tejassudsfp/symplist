import { int, type Statement, sql } from "@symplist/db";

/** Shared stop-without-continuation used inside restriction and task-archive batches (§8.1). */
export function quiesceSimon(input: {
  readonly ownerId: string;
  readonly now: number;
  readonly writeId: string;
  readonly reason: "restricted" | "task_archived";
  readonly guard: { readonly exists: string; readonly params: Readonly<Record<string, string>> };
  readonly tasks?: { readonly sql: string; readonly params: Readonly<Record<string, string>> };
}): Statement[] {
  const scope = `owner_id = :simon_owner${input.tasks ? ` AND task_id IN (${input.tasks.sql})` : ""}`;
  const scoped = { simon_owner: input.ownerId, ...input.tasks?.params, ...input.guard.params };
  const guard = input.guard.exists;
  return [
    sql(
      `UPDATE runs SET cancel_requested_at = COALESCE(cancel_requested_at, :simon_now),
      status = CASE WHEN status = 'running' THEN 'running' ELSE 'stopped' END,
      finished_at = CASE WHEN status = 'running' THEN finished_at ELSE :simon_now END,
      outcome_code = :simon_reason, write_id = :simon_w
      WHERE ${scope} AND status IN ('queued', 'running', 'awaiting_approval', 'awaiting_user') AND ${guard}`,
      {
        ...scoped,
        simon_now: int(input.now),
        simon_reason: input.reason,
        simon_w: input.writeId,
      },
    ),
    ...["approvals", "user_asks"].map((table) =>
      sql(
        `UPDATE ${table} SET status = 'expired', write_id = :simon_w
      WHERE ${scope} AND status = 'pending' AND ${guard}`,
        { ...scoped, simon_w: input.writeId },
      ),
    ),
    sql(
      `UPDATE messages SET status = 'cancelled', write_id = :simon_w WHERE status = 'queued'
      AND conversation_id IN (SELECT id FROM conversations WHERE ${scope}) AND ${guard}`,
      { ...scoped, simon_w: input.writeId },
    ),
    sql(
      `UPDATE dispatch_intents SET status = 'cancelled', cancelled_at = :simon_now, updated_at = :simon_now, write_id = :simon_w
      WHERE kind = 'simon_run' AND status = 'pending' AND subject_id IN (SELECT id FROM runs WHERE ${scope}) AND ${guard}`,
      {
        ...scoped,
        simon_now: int(input.now),
        simon_w: input.writeId,
      },
    ),
    sql(
      `UPDATE conversations SET active_run_id = NULL, write_id = :simon_w
      WHERE ${scope} AND active_run_id IN (SELECT id FROM runs WHERE status = 'stopped' AND write_id = :simon_w) AND ${guard}`,
      { ...scoped, simon_w: input.writeId },
    ),
  ];
}
