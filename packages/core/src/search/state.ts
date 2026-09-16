import { type DbRow, type Statement, sql } from "@symplist/db";

/** A `search_indexes` row (§10.1). */
export interface SearchIndexRow {
  readonly generation: number;
  readonly appliedThrough: number;
  readonly indexFormatVersion: number;
  readonly tokenizerFingerprint: string;
  readonly objectKey: string;
  readonly includeChat: boolean;
  readonly truncated: boolean;
  readonly byteSize: number;
  readonly writeId: string;
}

/** The owner's unapplied intents at a glance. */
export interface PendingSummary {
  readonly pending: number;
  /** The highest unapplied intent id, or 0. */
  readonly maxId: number;
  /** When the oldest unapplied intent was created, or null. */
  readonly oldestAt: number | null;
}

function safeInteger(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Unexpected ${what}`);
  }
  return value;
}

export function searchIndexRowStatement(ownerId: string): Statement {
  return sql(
    `SELECT generation, applied_through, index_format_version, tokenizer_fingerprint, object_key,
            include_chat, truncated, byte_size, write_id
     FROM search_indexes WHERE owner_id = :owner`,
    { owner: ownerId },
  );
}

export function searchIndexRowFromDb(row: DbRow | undefined): SearchIndexRow | null {
  if (!row) return null;
  if (
    typeof row.tokenizer_fingerprint !== "string" ||
    typeof row.object_key !== "string" ||
    typeof row.write_id !== "string"
  ) {
    throw new Error("Unexpected search_indexes row");
  }
  return Object.freeze({
    generation: safeInteger(row.generation, "search_indexes.generation"),
    appliedThrough: safeInteger(row.applied_through, "search_indexes.applied_through"),
    indexFormatVersion: safeInteger(
      row.index_format_version,
      "search_indexes.index_format_version",
    ),
    tokenizerFingerprint: row.tokenizer_fingerprint,
    objectKey: row.object_key,
    includeChat: row.include_chat === 1,
    truncated: row.truncated === 1,
    byteSize: safeInteger(row.byte_size, "search_indexes.byte_size"),
    writeId: row.write_id,
  });
}

export function pendingSummaryFromDb(row: DbRow | undefined): PendingSummary {
  if (!row) return { pending: 0, maxId: 0, oldestAt: null };
  return Object.freeze({
    pending: safeInteger(row.pending, "pending intent count"),
    maxId: safeInteger(row.max_id, "pending intent id"),
    oldestAt: row.oldest === null ? null : safeInteger(row.oldest, "pending intent time"),
  });
}
