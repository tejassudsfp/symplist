import { describe, expect, it } from "vitest";
import { DbError } from "./errors.ts";
import { assertIdentifier, bool, int, json, sql } from "./query.ts";

describe("sql", () => {
  it("compiles named parameters to positional ? in order, repeating repeated names", () => {
    expect(
      sql("UPDATE t SET a = :value, write_id = :w WHERE id = :id AND other_id = :id", {
        value: "v",
        w: "write",
        id: "row",
      }),
    ).toEqual({
      sql: "UPDATE t SET a = ?, write_id = ? WHERE id = ? AND other_id = ?",
      params: ["v", "write", "row", "row"],
    });
  });

  it("writes null and undefined as NULL literals, never bound nulls", () => {
    const statement = sql("INSERT INTO t (a, b, c) VALUES (:a, :b, :c)", {
      a: null,
      b: undefined,
      c: "x",
    });
    expect(statement).toEqual({
      sql: "INSERT INTO t (a, b, c) VALUES (NULL, NULL, ?)",
      params: ["x"],
    });
  });

  it("expands string arrays into placeholder lists and empty arrays into NULL", () => {
    expect(sql("SELECT 1 FROM t WHERE id IN (:ids)", { ids: ["a", "b", "c"] })).toEqual({
      sql: "SELECT 1 FROM t WHERE id IN (?, ?, ?)",
      params: ["a", "b", "c"],
    });
    expect(sql("SELECT 1 FROM t WHERE id IN (:ids)", { ids: [] })).toEqual({
      sql: "SELECT 1 FROM t WHERE id IN (NULL)",
      params: [],
    });
  });

  it("ignores names inside strings, quoted identifiers and comments", () => {
    const statement = sql(
      `SELECT ':literal', "col:x" FROM t -- :comment\nWHERE json_extract(doc, '$.a:b') = :value /* :block */`,
      { value: "1" },
    );
    expect(statement.params).toEqual(["1"]);
    expect(statement.sql).toContain("':literal'");
    expect(statement.sql).toContain("-- :comment");
    expect(statement.sql).toContain("= ? /* :block */");
  });

  it("rejects missing, unused and malformed parameters", () => {
    expect(() => sql("SELECT :a", {})).toThrow(/Missing value for parameter :a/);
    expect(() => sql("SELECT 1", { extra: "x" })).toThrow(/not used/);
    expect(() => sql("SELECT :a", { a: 1 as unknown as string })).toThrow(/int\(\)/);
    expect(() => sql("SELECT :a", { a: [1] as unknown as string[] })).toThrow(
      /must contain strings/,
    );
    expect(() => sql("SELECT ?", {})).toThrow(/Use :name parameters/);
    expect(() => sql("SELECT @a", { a: "x" })).toThrow(DbError);
    expect(() => sql("SELECT $a", { a: "x" })).toThrow(DbError);
    expect(() => sql("SELECT :a", { "a-b": "x" } as Record<string, string>)).toThrow(
      /Invalid parameter name/,
    );
  });

  it("never places parameter values in error messages", () => {
    try {
      sql("SELECT :a", { a: "secret-value", b: "other-secret" });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("secret");
      return;
    }
    throw new Error("expected sql() to throw");
  });
});

describe("encoders", () => {
  it("int encodes safe integers and bigints and rejects everything else", () => {
    expect(int(42)).toBe("42");
    expect(int(-7)).toBe("-7");
    expect(int(-0)).toBe("0");
    expect(int(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
    expect(int(2n ** 62n)).toBe("4611686018427387904");
    for (const value of [
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
      "1" as unknown as number,
    ]) {
      expect(() => int(value)).toThrow(DbError);
    }
  });

  it("bool encodes '1' and '0'", () => {
    expect(bool(true)).toBe("1");
    expect(bool(false)).toBe("0");
    expect(() => bool(1 as unknown as boolean)).toThrow(DbError);
  });

  it("json encodes values as strings", () => {
    expect(json({ a: [1, null, "x"] })).toBe('{"a":[1,null,"x"]}');
    expect(json(null)).toBe("null");
    expect(() => json(undefined)).toThrow(DbError);
  });

  it("assertIdentifier accepts plain lower-case identifiers only", () => {
    expect(assertIdentifier("beta_admin_events")).toBe("beta_admin_events");
    for (const name of ["Users", "users; DROP TABLE x", "1abc", "a-b", "", '"x"']) {
      expect(() => assertIdentifier(name)).toThrow(DbError);
    }
  });
});
