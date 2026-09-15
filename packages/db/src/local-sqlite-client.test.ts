import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { describeDbClientContract } from "../../testing/src/contracts/db/db-client-contract.ts";
import { DbError, DbStatementError } from "./errors.ts";
import { createLocalSqliteClient, type LocalSqliteClient } from "./local-sqlite-client.ts";
import { int, sql } from "./query.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "symplist-db-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function open(
  options: { path?: string; appendOnlyTables?: readonly string[]; busyTimeoutMs?: number } = {},
): LocalSqliteClient {
  const client = createLocalSqliteClient({ path: options.path ?? ":memory:", env: {}, ...options });
  cleanups.push(() => client.close());
  return client;
}

describe("LocalSqliteClient", () => {
  it("refuses NODE_ENV=production", () => {
    expect(() =>
      createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "production" } }),
    ).toThrow(expect.objectContaining({ code: "db.production_refused" }));
  });

  it("creates parent directories and uses WAL for file databases", () => {
    const path = join(tempDir(), "nested", "d1.sqlite");
    const client = open({ path });
    expect(existsSync(path)).toBe(true);
    expect(client.journalMode()).toBe("wal");
  });

  it("binds every parameter as TEXT, as D1 receives them over REST", async () => {
    const client = open();
    await expect(
      client.first(sql("SELECT typeof(:n) AS kind, :n + 1 AS next", { n: int(41) })),
    ).resolves.toEqual({
      kind: "text",
      next: 42,
    });
  });

  it("returns plain REST-shaped rows and numeric meta", async () => {
    const client = open();
    const [created, inserted, selected] = await client.batch([
      sql("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER) STRICT"),
      sql("INSERT INTO t VALUES ('a', 1), ('b', 2)"),
      sql("SELECT id, n FROM t ORDER BY id"),
    ]);
    expect(created?.success).toBe(true);
    expect(inserted?.meta.changes).toBe(2);
    expect(typeof inserted?.meta.last_row_id).toBe("number");
    expect(typeof selected?.meta.duration).toBe("number");
    expect(selected?.results).toEqual([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);
    expect(Object.getPrototypeOf(selected?.results[0])).toBe(Object.prototype);
  });

  it("wraps each batch in BEGIN IMMEDIATE and reports a held write lock as unavailable", async () => {
    const path = join(tempDir(), "locked.sqlite");
    const client = open({ path, busyTimeoutMs: 50 });
    await client.run(sql("CREATE TABLE t (id TEXT PRIMARY KEY) STRICT"));
    const other = new DatabaseSync(path, { timeout: 0 });
    cleanups.push(() => other.close());
    other.exec("BEGIN IMMEDIATE");
    await expect(client.first(sql("SELECT id FROM t"))).rejects.toMatchObject({
      code: "db.unavailable",
    });
    other.exec("ROLLBACK");
    await expect(client.run(sql("INSERT INTO t VALUES ('x')"))).resolves.toMatchObject({
      success: true,
    });
  });

  it("denies transaction control inside migration scripts through the authorizer", async () => {
    const client = open();
    const error = await client
      .executeScript("CREATE TABLE a (x TEXT) STRICT; BEGIN; INSERT INTO a VALUES ('y'); COMMIT;")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DbStatementError);
    expect((error as DbStatementError).kind).toBe("authorization");
    await expect(
      client.first(sql("SELECT name FROM sqlite_schema WHERE name = 'a'")),
    ).resolves.toBeNull();
  });

  it("denies writes to append-only tables even when they come from a trigger", async () => {
    const client = open({ appendOnlyTables: ["audit_log"] });
    await client.executeScript(`
      CREATE TABLE audit_log (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE notes (id TEXT PRIMARY KEY) STRICT;
      INSERT INTO audit_log VALUES ('kept');
      CREATE TRIGGER notes_sneaky AFTER INSERT ON notes BEGIN DELETE FROM audit_log; END;
    `);
    const error = await client
      .run(sql("INSERT INTO notes VALUES ('n1')"))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DbStatementError);
    expect((error as DbStatementError).kind).toBe("authorization");
    await expect(client.all(sql("SELECT id FROM audit_log"))).resolves.toEqual([{ id: "kept" }]);
    await expect(client.run(sql("UPDATE audit_log SET id = 'x'"))).rejects.toMatchObject({
      code: "db.append_only",
    });
    await expect(client.run(sql("INSERT INTO audit_log VALUES ('added')"))).resolves.toMatchObject({
      success: true,
    });
  });

  it("rolls back every statement of a failed batch", async () => {
    const client = open();
    await client.run(sql("CREATE TABLE t (id TEXT PRIMARY KEY) STRICT"));
    await expect(
      client.batch([
        sql("INSERT INTO t VALUES ('a')"),
        sql("INSERT INTO t VALUES ('b')"),
        sql("INSERT INTO t VALUES ('a')"),
      ]),
    ).rejects.toMatchObject({ code: "db.statement_failed", statementIndex: 2 });
    await expect(client.all(sql("SELECT id FROM t"))).resolves.toEqual([]);
  });

  it("reports SQL errors from prepare with the statement index", async () => {
    const client = open();
    await expect(
      client.batch([sql("SELECT 1"), sql("SELECT * FROM missing_table")]),
    ).rejects.toMatchObject({
      code: "db.statement_failed",
      kind: "syntax",
      statementIndex: 1,
    });
  });

  it("rejects work after close", async () => {
    const client = createLocalSqliteClient({ path: ":memory:", env: {} });
    client.close();
    client.close();
    await expect(client.first(sql("SELECT 1"))).rejects.toBeInstanceOf(DbError);
  });
});

describeDbClientContract("local node:sqlite client", async () => {
  const client = createLocalSqliteClient({ path: ":memory:", env: {} });
  return { client, close: () => client.close() };
});
