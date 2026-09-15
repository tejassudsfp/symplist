import type { AccountDataKey, FieldEnvelopeContext } from "@symplist/crypto";
import { decryptFieldText, encryptFieldText, type RandomOptions } from "@symplist/crypto";
import type { DbRow, Statement } from "@symplist/db";
import { assertIdentifier, sql } from "@symplist/db";
import { isTaskCollection, type TaskRecord, type TaskSource } from "./model.ts";

/* ------------------------------------------------------------------------------------------------
 * Encrypted fields (§4.1, §4.4)
 * --------------------------------------------------------------------------------------------- */

/** Field envelope purpose of `tasks.title_enc`. */
export const TASK_TITLE_PURPOSE = "task_title";
/** Field envelope purpose of `tasks.preview_enc`. */
export const TASK_PREVIEW_PURPOSE = "task_preview";

/** The envelope binding of a task title: owner, table `tasks`, the task id and column `title_enc`. */
export function taskTitleContext(ownerId: string, taskId: string): FieldEnvelopeContext {
  return Object.freeze({
    purpose: TASK_TITLE_PURPOSE,
    ownerId,
    table: "tasks",
    rowId: taskId,
    column: "title_enc",
  });
}

/** The envelope binding of a task preview (column `preview_enc`). */
export function taskPreviewContext(ownerId: string, taskId: string): FieldEnvelopeContext {
  return Object.freeze({
    purpose: TASK_PREVIEW_PURPOSE,
    ownerId,
    table: "tasks",
    rowId: taskId,
    column: "preview_enc",
  });
}

export function encryptTaskTitle(
  key: AccountDataKey,
  ownerId: string,
  taskId: string,
  title: string,
  random?: RandomOptions,
): string {
  return encryptFieldText(key, taskTitleContext(ownerId, taskId), title, random);
}

export function encryptTaskPreview(
  key: AccountDataKey,
  ownerId: string,
  taskId: string,
  preview: string,
  random?: RandomOptions,
): string {
  return encryptFieldText(key, taskPreviewContext(ownerId, taskId), preview, random);
}

/* ------------------------------------------------------------------------------------------------
 * Rows
 * --------------------------------------------------------------------------------------------- */

/** Every `tasks` column a service reads, in a fixed order. */
export const TASK_COLUMNS =
  "id, owner_id, parent_id, collection, position, status, archived_at, archived_with_root_id, source, version, title_enc, preview_enc, created_at, updated_at";

/** The task columns qualified by a table alias. */
export function taskColumnsOf(alias: string): string {
  const table = assertIdentifier(alias);
  return TASK_COLUMNS.split(", ")
    .map((column) => `${table}.${column}`)
    .join(", ");
}

/** A row read from D1 did not have the shape the schema guarantees. */
export class TaskRowError extends Error {
  readonly code = "tasks.row_invalid";
  constructor(column: string) {
    super(`Unexpected value in tasks.${column}`);
    this.name = "TaskRowError";
  }
}

function text(row: DbRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new TaskRowError(column);
  return value;
}

function nullableText(row: DbRow, column: string): string | null {
  return row[column] === null ? null : text(row, column);
}

function integer(row: DbRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TaskRowError(column);
  }
  return value;
}

function nullableInteger(row: DbRow, column: string): number | null {
  return row[column] === null ? null : integer(row, column);
}

/** Decrypts one `tasks` row read with {@link TASK_COLUMNS}. */
export function taskRecordFromRow(row: DbRow, key: AccountDataKey): TaskRecord {
  const id = text(row, "id");
  const ownerId = text(row, "owner_id");
  const collection = text(row, "collection");
  if (!isTaskCollection(collection)) throw new TaskRowError("collection");
  const status = text(row, "status");
  if (status !== "active" && status !== "archived") throw new TaskRowError("status");
  const source = text(row, "source");
  if (source !== "user" && source !== "simon" && !source.startsWith("mcp:")) {
    throw new TaskRowError("source");
  }
  const titleEnc = text(row, "title_enc");
  const previewEnc = nullableText(row, "preview_enc");
  return Object.freeze({
    id,
    ownerId,
    parentId: nullableText(row, "parent_id"),
    collection,
    position: text(row, "position"),
    status,
    archivedAt: nullableInteger(row, "archived_at"),
    archivedWithRootId: nullableText(row, "archived_with_root_id"),
    source: source as TaskSource,
    version: integer(row, "version"),
    title: decryptFieldText(key, taskTitleContext(ownerId, id), titleEnc),
    preview:
      previewEnc === null
        ? null
        : decryptFieldText(key, taskPreviewContext(ownerId, id), previewEnc),
    createdAt: integer(row, "created_at"),
    updatedAt: integer(row, "updated_at"),
  });
}

/* ------------------------------------------------------------------------------------------------
 * The active-task guard (§2.1)
 * --------------------------------------------------------------------------------------------- */

/**
 * The §2.1 active-task guard. Every write that targets a task (message accept, the dispatcher, run
 * steps and external actions, approval decisions, document head updates, schedule mutations,
 * artifact snapshots and share release, every MCP write) puts this condition in its deciding
 * conditional statement.
 */
export const ACTIVE_TASK_GUARD_SQL =
  "EXISTS (SELECT 1 FROM tasks WHERE id = :active_task AND owner_id = :active_owner AND status = 'active')";

export interface ActiveTaskGuard {
  /** {@link ACTIVE_TASK_GUARD_SQL}, to add to the deciding statement's `WHERE` clause. */
  readonly exists: string;
  /** The named parameters `exists` references; spread them into the statement's parameters. */
  readonly params: Readonly<{ active_task: string; active_owner: string }>;
  /**
   * A read to append to the same batch. When the deciding statement did not apply, pass its row to
   * {@link activeTaskGuardFailure} to learn whether the task is archived or unknown.
   */
  readonly statusStatement: Statement;
}

/** The active-task guard for one task and owner. */
export function activeTaskGuard(input: {
  readonly taskId: string;
  readonly ownerId: string;
}): ActiveTaskGuard {
  if (typeof input.taskId !== "string" || input.taskId.length === 0) {
    throw new TypeError("The active-task guard needs a task id");
  }
  if (typeof input.ownerId !== "string" || input.ownerId.length === 0) {
    throw new TypeError("The active-task guard needs an owner id");
  }
  return Object.freeze({
    exists: ACTIVE_TASK_GUARD_SQL,
    params: Object.freeze({ active_task: input.taskId, active_owner: input.ownerId }),
    statusStatement: sql(`SELECT status FROM tasks WHERE id = :task AND owner_id = :owner`, {
      task: input.taskId,
      owner: input.ownerId,
    }),
  });
}

/**
 * Why the active-task guard failed, from the row its `statusStatement` returned: `task.archived`
 * (HTTP 409) for an archived task, `not_found` for an unknown task or another owner's (the same
 * shape, without names), or null when the task is active and something else refused the write.
 */
export function activeTaskGuardFailure(
  row: DbRow | null | undefined,
): "task.archived" | "not_found" | null {
  if (!row) return "not_found";
  if (row.status === "archived") return "task.archived";
  if (row.status === "active") return null;
  throw new TaskRowError("status");
}

/* ------------------------------------------------------------------------------------------------
 * The task tree version (§3.3, §7)
 * --------------------------------------------------------------------------------------------- */

/** Reads the owner's tree version (0 before any task write). */
export function taskTreeVersionStatement(ownerId: string): Statement {
  return sql(`SELECT task_tree_version FROM users WHERE id = :owner`, { owner: ownerId });
}

/** The version from {@link taskTreeVersionStatement}'s row; null when the user does not exist. */
export function taskTreeVersionFromRow(row: DbRow | null | undefined): number | null {
  if (!row) return null;
  const value = row.task_tree_version;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TaskRowError("users.task_tree_version");
  }
  return value;
}
