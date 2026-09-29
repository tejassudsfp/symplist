import { type DbRow, int, type Statement, sql } from "@symplist/db";

/** What a search intent names (§10.1). Chat left the cloud (note 18), so nothing writes `message`. */
export const searchIntentEntities = ["task", "document"] as const;
export type SearchIntentEntity = (typeof searchIntentEntities)[number];

/**
 * What a stored row may name. Rows written before chat left the cloud still say `message`, and the
 * CHECK constraint that permits them cannot be tightened because migrations are expand-only. The
 * parser therefore keeps accepting them: a throw here would leave the owner's first batch unparsed,
 * and because the writer deletes applied intents only after a publication, those rows would never be
 * cleared and that owner's index would stop updating for good. {@link coalesceIntents} drops them.
 */
export const storedSearchIntentEntities = [...searchIntentEntities, "message"] as const;
export type StoredSearchIntentEntity = (typeof storedSearchIntentEntities)[number];

export const searchIntentOps = ["upsert", "delete"] as const;
export type SearchIntentOp = (typeof searchIntentOps)[number];

export interface SearchIntentInput {
  readonly ownerId: string;
  readonly entity: SearchIntentEntity;
  readonly entityId: string;
  /** The task version or document head revision number the change produced. */
  readonly revisionOrSeq: number;
  readonly op: SearchIntentOp;
  readonly now: number;
}

/** A guard fragment such as `WriteGuard.exists` with its named parameters. */
export interface SearchIntentGuard {
  readonly exists: string;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * The statement that records a search intent in the same batch as its source change (§10.1): task
 * create, rename, move, archive or restore; document head publication. Pass the deciding statement's
 * write guard, so the intent exists exactly when the change committed.
 */
export function searchIntentStatement(
  input: SearchIntentInput,
  guard?: SearchIntentGuard,
): Statement {
  if (!searchIntentEntities.includes(input.entity))
    throw new TypeError("Unknown search intent entity");
  if (!searchIntentOps.includes(input.op)) throw new TypeError("Unknown search intent op");
  if (!Number.isSafeInteger(input.revisionOrSeq) || input.revisionOrSeq < 0) {
    throw new TypeError("revisionOrSeq must be a non-negative integer");
  }
  if (guard && Object.hasOwn(guard.params, "owner")) {
    throw new TypeError("Search intent guards must not reuse the :owner parameter name");
  }
  return sql(
    `INSERT INTO search_intents (owner_id, entity, entity_id, revision_or_seq, op, created_at)
     SELECT :owner, :entity, :entity_id, :revision, :op, :now
     WHERE ${guard ? guard.exists : "1"}`,
    {
      owner: input.ownerId,
      entity: input.entity,
      entity_id: input.entityId,
      revision: int(input.revisionOrSeq),
      op: input.op,
      now: int(input.now),
      ...(guard?.params ?? {}),
    },
  );
}

/** One stored intent. */
export interface SearchIntentRow {
  readonly id: number;
  readonly entity: StoredSearchIntentEntity;
  readonly entityId: string;
  readonly revisionOrSeq: number;
  readonly op: SearchIntentOp;
  readonly createdAt: number;
}

function integer(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Unexpected search_intents.${what}`);
  }
  return value;
}

export function searchIntentFromRow(row: DbRow): SearchIntentRow {
  const entity = row.entity;
  const op = row.op;
  if (!storedSearchIntentEntities.includes(entity as StoredSearchIntentEntity)) {
    throw new Error("Unexpected search_intents.entity");
  }
  if (!searchIntentOps.includes(op as SearchIntentOp))
    throw new Error("Unexpected search_intents.op");
  if (typeof row.entity_id !== "string") throw new Error("Unexpected search_intents.entity_id");
  return {
    id: integer(row.id, "id"),
    entity: entity as StoredSearchIntentEntity,
    entityId: row.entity_id,
    revisionOrSeq: integer(row.revision_or_seq, "revision_or_seq"),
    op: op as SearchIntentOp,
    createdAt: integer(row.created_at, "created_at"),
  };
}

/** The applied-through subquery for an owner: 0 before the first publication. */
export const APPLIED_THROUGH_SUBQUERY =
  "COALESCE((SELECT applied_through FROM search_indexes WHERE owner_id = :owner), 0)";

/**
 * The owner's unapplied intents in id order, at most `limit`. Without `range` "unapplied" means after
 * the stored `applied_through`; a reader holding an older published generation passes its own
 * `after` (and the highest id it observed as `through`) so the overlay matches the index it holds.
 */
export function pendingIntentsStatement(
  ownerId: string,
  limit: number,
  range?: { readonly after: number; readonly through: number },
): Statement {
  if (range) {
    return sql(
      `SELECT id, entity, entity_id, revision_or_seq, op, created_at FROM search_intents
       WHERE owner_id = :owner AND id > :after AND id <= :through
       ORDER BY id LIMIT :limit`,
      {
        owner: ownerId,
        after: int(range.after),
        through: int(range.through),
        limit: int(limit),
      },
    );
  }
  return sql(
    `SELECT id, entity, entity_id, revision_or_seq, op, created_at FROM search_intents
     WHERE owner_id = :owner AND id > ${APPLIED_THROUGH_SUBQUERY}
     ORDER BY id LIMIT :limit`,
    { owner: ownerId, limit: int(limit) },
  );
}

/** Count, highest id and oldest creation time of the owner's unapplied intents. */
export function pendingSummaryStatement(ownerId: string): Statement {
  return sql(
    `SELECT COUNT(*) AS pending, COALESCE(MAX(id), 0) AS max_id, MIN(created_at) AS oldest
     FROM search_intents WHERE owner_id = :owner AND id > ${APPLIED_THROUGH_SUBQUERY}`,
    { owner: ownerId },
  );
}

/** The last operation per entity, so a batch applies each task or document once. */
export interface CoalescedIntents {
  readonly tasks: ReadonlyMap<string, SearchIntentOp>;
  readonly documents: ReadonlyMap<string, SearchIntentOp>;
}

/**
 * Collapses intents to the last operation per entity. Every upsert re-reads the current authoritative
 * record, so applying the last operation once is equivalent to applying them all in order. Legacy
 * `message` rows name content the index no longer holds and are dropped here; they still count
 * towards `applied_through`, so the publication that ignores them also deletes them.
 */
export function coalesceIntents(intents: readonly SearchIntentRow[]): CoalescedIntents {
  const tasks = new Map<string, SearchIntentOp>();
  const documents = new Map<string, SearchIntentOp>();
  for (const intent of [...intents].sort((left, right) => left.id - right.id)) {
    if (intent.entity === "message") continue;
    const target = intent.entity === "task" ? tasks : documents;
    target.delete(intent.entityId);
    target.set(intent.entityId, intent.op);
  }
  return { tasks, documents };
}
