import type { DbRow, Statement } from "@symplist/db";
import { sql } from "@symplist/db";
import type { DocumentAuthorKind, DocumentCommitKind } from "../artifacts/snapshot.ts";
import { DOCUMENT_AUTHOR_KINDS, DOCUMENT_COMMIT_KINDS } from "../artifacts/snapshot.ts";

/** A `doc_repos` row: the published head of a task's document (§9.2). */
export interface RepoRecord {
  readonly taskId: string;
  readonly ownerId: string;
  readonly headCommitId: string;
  readonly generation: number;
  readonly commitCount: number;
  readonly bundleKey: string;
  readonly bundleWriteId: string;
  readonly bundleBytes: number;
  readonly snapshotKey: string;
  readonly documentBytes: number;
  readonly headAuthor: DocumentAuthorKind;
  readonly updatedAt: number;
  readonly writeId: string;
}

/** A `doc_commits` row. */
export interface CommitRecord {
  readonly taskId: string;
  readonly commitId: string;
  readonly parentCommitId: string | null;
  readonly generation: number;
  readonly author: DocumentAuthorKind;
  readonly kind: DocumentCommitKind;
  readonly restoredFrom: string | null;
  readonly bundleKey: string;
  readonly snapshotKey: string;
  readonly documentBytes: number;
  readonly committedAt: number;
  readonly publishedAt: number;
}

/** A `doc_publish_requests` row. */
export interface RequestRecord {
  readonly scope: string;
  readonly requestId: string;
  readonly taskId: string;
  readonly fingerprintEnc: string;
  readonly baseCommitId: string | null;
  readonly commitId: string;
  readonly generation: number;
  readonly changedSectionIds: readonly string[];
}

/** A D1 row of a documents table did not have the shape its schema guarantees. */
export class DocumentRowError extends Error {
  readonly code = "document.row_invalid";
  constructor(table: string) {
    super(`Unexpected ${table} row`);
    this.name = "DocumentRowError";
  }
}

function text(row: DbRow, column: string, table: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new DocumentRowError(table);
  return value;
}

function nullableText(row: DbRow, column: string, table: string): string | null {
  const value = row[column];
  if (value === null) return null;
  if (typeof value !== "string") throw new DocumentRowError(table);
  return value;
}

function integer(row: DbRow, column: string, table: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new DocumentRowError(table);
  return value;
}

function oneOf<const Value extends string>(
  row: DbRow,
  column: string,
  table: string,
  values: readonly Value[],
): Value {
  const value = row[column];
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new DocumentRowError(table);
  }
  return value as Value;
}

export const REPO_COLUMNS =
  "task_id, owner_id, head_commit_id, generation, commit_count, bundle_key, bundle_write_id, bundle_bytes, snapshot_key, document_bytes, head_author, updated_at, write_id";

export function repoFromRow(row: DbRow): RepoRecord {
  const table = "doc_repos";
  return Object.freeze({
    taskId: text(row, "task_id", table),
    ownerId: text(row, "owner_id", table),
    headCommitId: text(row, "head_commit_id", table),
    generation: integer(row, "generation", table),
    commitCount: integer(row, "commit_count", table),
    bundleKey: text(row, "bundle_key", table),
    bundleWriteId: text(row, "bundle_write_id", table),
    bundleBytes: integer(row, "bundle_bytes", table),
    snapshotKey: text(row, "snapshot_key", table),
    documentBytes: integer(row, "document_bytes", table),
    headAuthor: oneOf(row, "head_author", table, DOCUMENT_AUTHOR_KINDS),
    updatedAt: integer(row, "updated_at", table),
    writeId: text(row, "write_id", table),
  });
}

export const COMMIT_COLUMNS =
  "task_id, commit_id, parent_commit_id, generation, author, kind, restored_from_commit_id, bundle_key, snapshot_key, document_bytes, committed_at, published_at";

export function commitFromRow(row: DbRow): CommitRecord {
  const table = "doc_commits";
  return Object.freeze({
    taskId: text(row, "task_id", table),
    commitId: text(row, "commit_id", table),
    parentCommitId: nullableText(row, "parent_commit_id", table),
    generation: integer(row, "generation", table),
    author: oneOf(row, "author", table, DOCUMENT_AUTHOR_KINDS),
    kind: oneOf(row, "kind", table, DOCUMENT_COMMIT_KINDS),
    restoredFrom: nullableText(row, "restored_from_commit_id", table),
    bundleKey: text(row, "bundle_key", table),
    snapshotKey: text(row, "snapshot_key", table),
    documentBytes: integer(row, "document_bytes", table),
    committedAt: integer(row, "committed_at", table),
    publishedAt: integer(row, "published_at", table),
  });
}

export const REQUEST_COLUMNS =
  "scope, request_id, task_id, fingerprint_enc, base_commit_id, commit_id, generation, changed_section_ids";

export function requestFromRow(row: DbRow): RequestRecord {
  const table = "doc_publish_requests";
  let changed: unknown;
  try {
    changed = JSON.parse(text(row, "changed_section_ids", table));
  } catch {
    throw new DocumentRowError(table);
  }
  if (!Array.isArray(changed) || changed.some((id) => typeof id !== "string")) {
    throw new DocumentRowError(table);
  }
  return Object.freeze({
    scope: text(row, "scope", table),
    requestId: text(row, "request_id", table),
    taskId: text(row, "task_id", table),
    fingerprintEnc: text(row, "fingerprint_enc", table),
    baseCommitId: nullableText(row, "base_commit_id", table),
    commitId: text(row, "commit_id", table),
    generation: integer(row, "generation", table),
    changedSectionIds: Object.freeze(changed as string[]),
  });
}

/** The head row of a task, only when it belongs to the owner. */
export function selectRepoStatement(ownerId: string, taskId: string): Statement {
  return sql(`SELECT ${REPO_COLUMNS} FROM doc_repos WHERE task_id = :task AND owner_id = :owner`, {
    task: taskId,
    owner: ownerId,
  });
}

/** One published commit of a task, only when it belongs to the owner. */
export function selectCommitStatement(
  ownerId: string,
  taskId: string,
  commitId: string,
): Statement {
  return sql(
    `SELECT ${COMMIT_COLUMNS} FROM doc_commits
     WHERE task_id = :task AND owner_id = :owner AND commit_id = :commit`,
    { task: taskId, owner: ownerId, commit: commitId },
  );
}

/** The recorded request with a scoped id. */
export function selectRequestStatement(
  ownerId: string,
  scope: string,
  requestId: string,
): Statement {
  return sql(
    `SELECT ${REQUEST_COLUMNS} FROM doc_publish_requests
     WHERE owner_id = :owner AND scope = :scope AND request_id = :request`,
    { owner: ownerId, scope, request: requestId },
  );
}
