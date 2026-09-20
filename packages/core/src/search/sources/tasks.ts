import { type AccountDataKey, decryptFieldText } from "@symplist/crypto";
import { type DbClient, type DbRow, int, type Statement, sql } from "@symplist/db";
import type { SearchTaskRecord } from "@symplist/search";
import { taskTitleContext } from "../../tasks/sql.ts";
import { type SearchLog, searchErrorCode } from "../log.ts";
import type { SearchPage, SearchTaskSource } from "./types.ts";

/** D1 caps a statement at 100 parameters (§3.2); the owner takes one. */
export const TASK_READ_CHUNK = 90;

/*
 * The binding of `tasks.title_enc` comes from the module that writes it (`tasks/sql.ts`), and is
 * re-exported here only so this source's callers keep one import.
 *
 * It used to be declared again in this file with purpose `title`, while the writer used
 * `task_title`. AAD is authenticated, so every task title written by the workspace failed to
 * decrypt here — search saw `crypto.decryption_failed` for every task an account owned. Nothing
 * caught it because each side's tests sealed *and* opened with its own copy of the context, so
 * neither suite ever crossed the boundary. One definition, imported, is what keeps that honest.
 */
export { taskTitleContext };

const collections = new Set(["now", "later", "unclassified"]);

function recordFromRow(ownerId: string, row: DbRow, key: AccountDataKey): SearchTaskRecord | null {
  const { id, parent_id: parentId, collection, status, version, updated_at: updatedAt } = row;
  if (typeof id !== "string" || typeof row.title_enc !== "string") return null;
  if (row.owner_id !== ownerId) return null;
  if (typeof collection !== "string" || !collections.has(collection)) return null;
  if (status !== "active" && status !== "archived") return null;
  if (typeof version !== "number" || typeof updatedAt !== "number") return null;
  const title = decryptFieldText(key, taskTitleContext(ownerId, id), row.title_enc);
  return {
    id,
    title,
    collection: collection as SearchTaskRecord["collection"],
    parentId: typeof parentId === "string" ? parentId : null,
    archived: status === "archived",
    updatedAt,
    version,
  };
}

const columns = "id, owner_id, parent_id, collection, status, version, updated_at, title_enc";

/**
 * Reads task titles and metadata from `tasks` (§2.1) and decrypts titles with the owner's key. Rows
 * whose title cannot be decrypted are skipped and logged by id, never indexed with partial text.
 */
export class D1SearchTaskSource implements SearchTaskSource {
  constructor(
    private readonly db: DbClient,
    private readonly log?: SearchLog,
  ) {}

  async readTasks(
    ownerId: string,
    taskIds: readonly string[],
    key: AccountDataKey,
  ): Promise<ReadonlyMap<string, SearchTaskRecord>> {
    const unique = [...new Set(taskIds)];
    const found = new Map<string, SearchTaskRecord>();
    if (unique.length === 0) return found;
    const statements: Statement[] = [];
    for (let start = 0; start < unique.length; start += TASK_READ_CHUNK) {
      statements.push(
        sql(`SELECT ${columns} FROM tasks WHERE owner_id = :owner AND id IN (:ids)`, {
          owner: ownerId,
          ids: unique.slice(start, start + TASK_READ_CHUNK),
        }),
      );
    }
    const results = await this.db.batch(statements);
    for (const result of results) {
      for (const [id, record] of this.decode(ownerId, result.results, key)) found.set(id, record);
    }
    return found;
  }

  async listTasks(
    ownerId: string,
    page: SearchPage,
    key: AccountDataKey,
  ): Promise<readonly SearchTaskRecord[]> {
    const rows = await this.db.all(
      sql(
        `SELECT ${columns} FROM tasks WHERE owner_id = :owner AND id > :after ORDER BY id LIMIT :limit`,
        { owner: ownerId, after: page.after ?? "", limit: int(page.limit) },
      ),
    );
    return [...this.decode(ownerId, rows, key).values()];
  }

  renderStatements(ownerId: string, taskIds: readonly string[]): readonly Statement[] {
    const ids = [...new Set(taskIds)];
    const statements: Statement[] = [];
    for (let start = 0; start < ids.length; start += TASK_READ_CHUNK) {
      const chunk = ids.slice(start, start + TASK_READ_CHUNK);
      statements.push(
        sql(`SELECT ${columns} FROM tasks WHERE owner_id = :owner AND id IN (:ids)`, {
          owner: ownerId,
          ids: chunk,
        }),
        sql(
          `SELECT ${columns} FROM tasks
           WHERE owner_id = :owner
             AND id IN (SELECT parent_id FROM tasks WHERE owner_id = :child_owner AND id IN (:ids))`,
          { owner: ownerId, child_owner: ownerId, ids: chunk },
        ),
      );
    }
    return statements;
  }

  tasksFromRows(
    ownerId: string,
    rows: readonly DbRow[],
    key: AccountDataKey,
  ): ReadonlyMap<string, SearchTaskRecord> {
    return this.decode(ownerId, rows, key);
  }

  private decode(
    ownerId: string,
    rows: readonly DbRow[],
    key: AccountDataKey,
  ): Map<string, SearchTaskRecord> {
    const records = new Map<string, SearchTaskRecord>();
    for (const row of rows) {
      try {
        const record = recordFromRow(ownerId, row, key);
        if (record) records.set(record.id, record);
      } catch (error) {
        this.log?.warn("search.task_unreadable", {
          taskId: typeof row.id === "string" ? row.id : null,
          code: searchErrorCode(error),
        });
      }
    }
    return records;
  }
}
