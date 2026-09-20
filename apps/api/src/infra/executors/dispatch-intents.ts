import type { ExecutorKind } from "@symplist/core/events";
import {
  type DbClient,
  type DbRow,
  int,
  newWriteId,
  type Statement,
  sql,
  verifiedRow,
} from "@symplist/db";

/** One `dispatch_intents` row (§8.1). */
export interface DispatchIntentRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: string;
  readonly subjectId: string;
  readonly status: "pending" | "dispatched" | "cancelled";
  readonly executor: ExecutorKind | null;
  readonly executorGeneration: number;
  readonly triggerRunId: string | null;
  readonly attempts: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly dispatchedAt: number | null;
  /** When the dispatcher last began running the intent in the api process (local mode), if ever. */
  readonly localStartedAt: number | null;
  readonly writeId: string;
}

/** A successful claim: the write id that proves this attempt owns the intent. */
export interface DispatchClaim {
  readonly intent: DispatchIntentRecord;
  readonly executor: ExecutorKind;
  readonly writeId: string;
}

const columns =
  "id, owner_id, kind, subject_id, status, executor, executor_generation, trigger_run_id, attempts, created_at, updated_at, dispatched_at, local_started_at, write_id";

/** The executor generation inside a feature's accept batch (§8.1). */
export const CURRENT_EXECUTOR_GENERATION_SQL =
  "(SELECT generation FROM executor_state WHERE id = 1)";

function toRecord(row: DbRow): DispatchIntentRecord {
  const status = row.status;
  const executor = row.executor;
  if (status !== "pending" && status !== "dispatched" && status !== "cancelled") {
    throw new Error("dispatch_intents.status holds an unknown value");
  }
  if (executor !== null && executor !== "local" && executor !== "trigger") {
    throw new Error("dispatch_intents.executor holds an unknown value");
  }
  return Object.freeze({
    id: String(row.id),
    ownerId: String(row.owner_id),
    kind: String(row.kind),
    subjectId: String(row.subject_id),
    status,
    executor,
    executorGeneration: Number(row.executor_generation),
    triggerRunId: row.trigger_run_id === null ? null : String(row.trigger_run_id),
    attempts: Number(row.attempts),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    dispatchedAt: row.dispatched_at === null ? null : Number(row.dispatched_at),
    localStartedAt:
      row.local_started_at === null || row.local_started_at === undefined
        ? null
        : Number(row.local_started_at),
    writeId: String(row.write_id),
  });
}

/**
 * The statement a feature folds into its accept batch to record a pending intent at the current
 * executor generation (§8.1). Unique per `(kind, subject_id)`, so a replayed batch inserts nothing.
 */
export function insertDispatchIntentStatement(input: {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: string;
  readonly subjectId: string;
  readonly now: number;
  readonly writeId: string;
  /** An `EXISTS (…)` guard from the deciding statement's write guard, when the intent depends on it. */
  readonly guard?: { readonly exists: string; readonly params: Readonly<Record<string, string>> };
}): Statement {
  return sql(
    `INSERT INTO dispatch_intents
       (id, owner_id, kind, subject_id, status, executor, executor_generation, trigger_run_id, attempts, created_at, updated_at, write_id)
     SELECT :id, :owner, :kind, :subject, 'pending', NULL, ${CURRENT_EXECUTOR_GENERATION_SQL}, NULL, 0, :now, :now, :w
     WHERE ${input.guard?.exists ?? "1 = 1"}
     ON CONFLICT (kind, subject_id) DO NOTHING`,
    {
      id: input.id,
      owner: input.ownerId,
      kind: input.kind,
      subject: input.subjectId,
      now: int(input.now),
      w: input.writeId,
      ...(input.guard?.params ?? {}),
    },
  );
}

/** Claims, dispatches and reconciles `dispatch_intents` with the write-id pattern (§3.2, §8.1). */
export class DispatchIntentRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Pending intents this api may dispatch now: recorded (or rebound) under `generation`, without a
   * Trigger run id, and unclaimed or with a claim older than the lease. Oldest first.
   */
  async listDispatchable(input: {
    readonly generation: number;
    readonly now: number;
    readonly claimLeaseMs: number;
    readonly limit: number;
  }): Promise<readonly DispatchIntentRecord[]> {
    const rows = await this.db.all(
      sql(
        `SELECT ${columns} FROM dispatch_intents
         WHERE status = 'pending' AND trigger_run_id IS NULL AND executor_generation = :generation
           AND (executor IS NULL OR updated_at <= :staleBefore)
         ORDER BY created_at, id
         LIMIT :limit`,
        {
          generation: int(input.generation),
          staleBefore: int(input.now - input.claimLeaseMs),
          limit: int(input.limit),
        },
      ),
    );
    return rows.map(toRecord);
  }

  async findBySubject(kind: string, subjectId: string): Promise<DispatchIntentRecord | null> {
    const row = await this.db.first(
      sql(`SELECT ${columns} FROM dispatch_intents WHERE kind = :kind AND subject_id = :subject`, {
        kind,
        subject: subjectId,
      }),
    );
    return row ? toRecord(row) : null;
  }

  /** Dispatched Trigger runs for subject ids, for cancellation after a restriction (§5.5). */
  async triggerRunsForSubjects(
    subjectIds: readonly string[],
  ): Promise<readonly DispatchIntentRecord[]> {
    const records: DispatchIntentRecord[] = [];
    for (let offset = 0; offset < subjectIds.length; offset += 90) {
      const chunk = subjectIds.slice(offset, offset + 90);
      const rows = await this.db.all(
        sql(
          `SELECT ${columns} FROM dispatch_intents
           WHERE subject_id IN (:subjects) AND executor = 'trigger' AND trigger_run_id IS NOT NULL`,
          { subjects: chunk },
        ),
      );
      records.push(...rows.map(toRecord));
    }
    return records;
  }

  /**
   * Claims one intent for an executor with a fresh write id. The claim holds only while the intent is
   * still pending, has no Trigger run id, belongs to `generation` and has no live claim.
   */
  async claim(
    intent: DispatchIntentRecord,
    input: {
      readonly executor: ExecutorKind;
      readonly generation: number;
      readonly now: number;
      readonly claimLeaseMs: number;
    },
  ): Promise<DispatchClaim | null> {
    const writeId = newWriteId();
    const results = await this.db.batch([
      sql(
        `UPDATE dispatch_intents
         SET executor = :executor, attempts = attempts + 1, updated_at = :now, write_id = :w
         WHERE id = :id AND status = 'pending' AND trigger_run_id IS NULL
           AND executor_generation = :generation
           AND (executor IS NULL OR updated_at <= :staleBefore)`,
        {
          executor: input.executor,
          now: int(input.now),
          w: writeId,
          id: intent.id,
          generation: int(input.generation),
          staleBefore: int(input.now - input.claimLeaseMs),
        },
      ),
      sql(`SELECT ${columns} FROM dispatch_intents WHERE id = :id AND write_id = :w`, {
        id: intent.id,
        w: writeId,
      }),
    ]);
    const row = verifiedRow(results);
    return row ? { intent: toRecord(row), executor: input.executor, writeId } : null;
  }

  /**
   * Records, conditional on a local claim, that the intent is about to run in the api process: the
   * local executor's idempotency guard (§8.1). Returns the claim to continue with (its write id
   * changed), or null when the claim was lost or the intent already carries a start.
   */
  async markLocalStart(
    claim: DispatchClaim,
    input: { readonly now: number },
  ): Promise<DispatchClaim | null> {
    if (claim.executor !== "local") throw new Error("Only a local claim starts in process");
    const writeId = newWriteId();
    const results = await this.db.batch([
      sql(
        `UPDATE dispatch_intents
         SET local_started_at = :now, updated_at = :now, write_id = :w
         WHERE id = :id AND write_id = :claim AND status = 'pending' AND executor = 'local'
           AND trigger_run_id IS NULL AND local_started_at IS NULL`,
        { now: int(input.now), w: writeId, id: claim.intent.id, claim: claim.writeId },
      ),
      sql(`SELECT ${columns} FROM dispatch_intents WHERE id = :id AND write_id = :w`, {
        id: claim.intent.id,
        w: writeId,
      }),
    ]);
    const row = verifiedRow(results);
    return row ? { intent: toRecord(row), executor: "local", writeId } : null;
  }

  /**
   * Clears the start marker of a local claim whose start failed before any job code ran, so a later
   * pass starts the intent. False when the claim moved on (the marker then stays, and the intent is
   * never started in process again).
   */
  async releaseLocalStart(claim: DispatchClaim, input: { readonly now: number }): Promise<boolean> {
    const writeId = newWriteId();
    const results = await this.db.batch([
      sql(
        `UPDATE dispatch_intents
         SET local_started_at = NULL, updated_at = :now, write_id = :w
         WHERE id = :id AND write_id = :claim AND status = 'pending'`,
        { now: int(input.now), w: writeId, id: claim.intent.id, claim: claim.writeId },
      ),
      sql(`SELECT id FROM dispatch_intents WHERE id = :id AND write_id = :w`, {
        id: claim.intent.id,
        w: writeId,
      }),
    ]);
    return verifiedRow(results) !== null;
  }

  /**
   * Marks a claimed intent dispatched and stores its Trigger run id, conditional on the claim's write
   * id. False when another claim took over (the Trigger idempotency key, or the local start marker,
   * keeps that harmless).
   */
  async markDispatched(
    claim: DispatchClaim,
    input: { readonly triggerRunId: string | null; readonly now: number },
  ): Promise<boolean> {
    if (claim.executor === "trigger" && input.triggerRunId === null) {
      throw new Error("A Trigger dispatch must store its Trigger run id");
    }
    if (claim.executor === "local" && input.triggerRunId !== null) {
      throw new Error("A local dispatch has no Trigger run id");
    }
    const writeId = newWriteId();
    const results = await this.db.batch([
      sql(
        `UPDATE dispatch_intents
         SET status = 'dispatched', executor = :executor, trigger_run_id = :run,
             dispatched_at = :now, updated_at = :now, write_id = :w
         WHERE id = :id AND write_id = :claim AND status = 'pending'`,
        {
          executor: claim.executor,
          run: input.triggerRunId,
          now: int(input.now),
          w: writeId,
          id: claim.intent.id,
          claim: claim.writeId,
        },
      ),
      sql(`SELECT id FROM dispatch_intents WHERE id = :id AND write_id = :w`, {
        id: claim.intent.id,
        w: writeId,
      }),
    ]);
    return verifiedRow(results) !== null;
  }

  /**
   * Moves every pending intent without a Trigger run id recorded under an older generation to
   * `generation`, clearing its claim, so the executor of the new mode dispatches it (§8.1).
   */
  async rebindPending(input: {
    readonly generation: number;
    readonly now: number;
  }): Promise<number> {
    const writeId = newWriteId();
    const results = await this.db.batch([
      sql(
        `UPDATE dispatch_intents
         SET executor_generation = :generation, executor = NULL, updated_at = :now, write_id = :w
         WHERE status = 'pending' AND trigger_run_id IS NULL AND executor_generation < :generation`,
        { generation: int(input.generation), now: int(input.now), w: writeId },
      ),
      sql(`SELECT COUNT(*) AS rebound FROM dispatch_intents WHERE write_id = :w`, { w: writeId }),
    ]);
    return Number(verifiedRow(results)?.rebound ?? 0);
  }
}
