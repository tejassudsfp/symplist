import { afterEach, describe, expect, it } from "vitest";
import { DbError } from "./errors.ts";
import { createLocalSqliteClient, type LocalSqliteClient } from "./local-sqlite-client.ts";
import { sql } from "./query.ts";
import {
  newWriteId,
  reconcileWrite,
  uuidv7,
  verifiedRow,
  verifyInsert,
  writeGuard,
} from "./write-id.ts";

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidv7", () => {
  it("encodes version 7, the variant bits and the millisecond timestamp", () => {
    const id = uuidv7(0x0123_4567_89ab);
    expect(id).toMatch(uuidV7Pattern);
    expect(id.startsWith("01234567-89ab-7")).toBe(true);
    expect(newWriteId()).toMatch(uuidV7Pattern);
  });

  it("is unique and sorts by creation time across milliseconds", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newWriteId()));
    expect(ids.size).toBe(1000);
    expect(uuidv7(1_000) < uuidv7(2_000)).toBe(true);
  });

  it("rejects timestamps outside 48 bits", () => {
    expect(() => uuidv7(-1)).toThrow(RangeError);
    expect(() => uuidv7(2 ** 48)).toThrow(RangeError);
  });
});

describe("writeGuard", () => {
  it("builds the dependent-statement guard and the verification SELECT", () => {
    const guard = writeGuard({ table: "users", id: "user-1", writeId: "w-1" });
    expect(guard.exists).toBe(
      "EXISTS (SELECT 1 FROM users WHERE id = :guard_id AND write_id = :guard_write_id)",
    );
    expect(guard.params).toEqual({ guard_id: "user-1", guard_write_id: "w-1" });
    expect(guard.verify()).toEqual({
      sql: "SELECT id, write_id FROM users WHERE id = ? AND write_id = ?",
      params: ["user-1", "w-1"],
    });
    expect(guard.verify(["id", "deletion_state"]).sql).toBe(
      "SELECT id, deletion_state FROM users WHERE id = ? AND write_id = ?",
    );
    expect(
      writeGuard({ table: "account_keys", id: "u", idColumn: "owner_id", paramPrefix: "key" })
        .exists,
    ).toBe(
      "EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :key_id AND write_id = :key_write_id)",
    );
    expect(writeGuard({ table: "users", id: "u" }).writeId).toMatch(uuidV7Pattern);
  });

  it("rejects identifiers that could inject SQL", () => {
    expect(() => writeGuard({ table: "users; DROP TABLE users", id: "u" })).toThrow(DbError);
    expect(() => writeGuard({ table: "users", id: "u", idColumn: "id OR 1=1" })).toThrow(DbError);
    expect(() => writeGuard({ table: "users", id: "u" }).verify(["*"])).toThrow(DbError);
    expect(() => writeGuard({ table: "users", id: "" })).toThrow(DbError);
    expect(() => verifyInsert({ table: "t", column: "request_id) OR (1", value: "x" })).toThrow(
      DbError,
    );
  });

  it("verifiedRow reads the last result by default and refuses ambiguous verification", () => {
    const meta = {};
    expect(
      verifiedRow([
        { success: true, results: [], meta },
        { success: true, results: [{ id: "a" }], meta },
      ]),
    ).toEqual({ id: "a" });
    expect(
      verifiedRow([
        { success: true, results: [{ id: "a" }], meta },
        { success: true, results: [], meta },
      ]),
    ).toBeNull();
    expect(
      verifiedRow(
        [
          { success: true, results: [{ id: "a" }], meta },
          { success: true, results: [], meta },
        ],
        0,
      ),
    ).toEqual({ id: "a" });
    expect(() =>
      verifiedRow([{ success: true, results: [{ id: "a" }, { id: "b" }], meta }]),
    ).toThrow(DbError);
    expect(() => verifiedRow([], 0)).toThrow(DbError);
  });
});

describe("conditional writes against SQLite", () => {
  let db: LocalSqliteClient | undefined;
  afterEach(() => db?.close());

  it("commits exactly one of two racing guarded updates and reconciles unknown outcomes by write id", async () => {
    db = createLocalSqliteClient({ path: ":memory:", env: {} });
    await db.batch([
      sql(
        "CREATE TABLE doc (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, write_id TEXT NOT NULL) STRICT",
      ),
      sql("CREATE TABLE doc_log (request_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL) STRICT"),
      sql("INSERT INTO doc VALUES ('d', 1, 'w0')"),
    ]);
    const attempt = (requestId: string) => {
      const guard = writeGuard({ table: "doc", id: "d" });
      return {
        guard,
        statements: [
          sql(
            "UPDATE doc SET revision = revision + 1, write_id = :w WHERE id = :id AND revision = 1",
            {
              w: guard.writeId,
              id: "d",
            },
          ),
          sql(`INSERT INTO doc_log (request_id, doc_id) SELECT :req, :id WHERE ${guard.exists}`, {
            req: requestId,
            id: "d",
            ...guard.params,
          }),
          guard.verify(["revision"]),
        ],
      };
    };
    const first = attempt("r1");
    const second = attempt("r2");
    const [firstResults, secondResults] = await Promise.all([
      db.batch(first.statements),
      db.batch(second.statements),
    ]);
    expect(verifiedRow(firstResults)).toEqual({ revision: 2 });
    expect(verifiedRow(secondResults)).toBeNull();
    await expect(db.all(sql("SELECT request_id FROM doc_log"))).resolves.toEqual([
      { request_id: "r1" },
    ]);

    await expect(
      reconcileWrite(db, { table: "doc", id: "d", writeId: first.guard.writeId }),
    ).resolves.toBe(true);
    await expect(
      reconcileWrite(db, { table: "doc", id: "d", writeId: second.guard.writeId }),
    ).resolves.toBe(false);
    await expect(reconcileWrite(db, { table: "doc", id: "missing", writeId: "w" })).resolves.toBe(
      false,
    );
  });
});
