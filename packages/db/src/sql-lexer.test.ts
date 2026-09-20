import { describe, expect, it } from "vitest";
import { DbError } from "./errors.ts";
import { analyzeStatement, splitSqlStatements, tokenizeSql } from "./sql-lexer.ts";

describe("tokenizeSql", () => {
  it("never produces parameters or semicolons from strings, quoted identifiers or comments", () => {
    const tokens = tokenizeSql(
      `SELECT ':a; ?', "col:b", [c;d], \`e?\` -- :f; ?\n/* :g ; ? */ FROM t WHERE x = :real AND y = ?`,
    );
    expect(tokens.filter((token) => token.kind === "parameter").map((token) => token.text)).toEqual(
      [":real", "?"],
    );
    expect(tokens.some((token) => token.kind === "semicolon")).toBe(false);
    expect(
      tokens.filter((token) => token.kind === "identifier").map((token) => token.value),
    ).toEqual(["col:b", "c;d", "e?"]);
  });

  it("unescapes doubled quotes and recognizes blob literals and numbers", () => {
    const tokens = tokenizeSql(`SELECT 'it''s', "a""b", x'00ff', 1.5e3, 0x1F, .5`);
    expect(tokens.map((token) => [token.kind, token.value])).toEqual([
      ["word", "SELECT"],
      ["string", "it's"],
      ["punctuation", ","],
      ["identifier", 'a"b'],
      ["punctuation", ","],
      ["blob", "x'00ff'"],
      ["punctuation", ","],
      ["number", "1.5e3"],
      ["punctuation", ","],
      ["number", "0x1F"],
      ["punctuation", ","],
      ["number", ".5"],
    ]);
  });

  it("rejects unterminated strings and quoted identifiers", () => {
    for (const text of ["SELECT 'open", 'SELECT "open', "SELECT [open", "SELECT x'00"]) {
      expect(() => tokenizeSql(text)).toThrow(DbError);
    }
  });

  it("treats an unterminated block comment as running to the end", () => {
    expect(tokenizeSql("SELECT 1 /* trailing").map((token) => token.text)).toEqual(["SELECT", "1"]);
  });
});

describe("splitSqlStatements", () => {
  it("splits at top-level semicolons and drops empty statements and comments", () => {
    const statements = splitSqlStatements("-- lead\nSELECT 1;; SELECT ';' ;\n/* tail */");
    expect(statements.map((statement) => statement.text)).toEqual(["SELECT 1", "SELECT ';'"]);
  });

  it("keeps CREATE TRIGGER bodies, including nested CASE … END, as one statement", () => {
    const script = `CREATE TABLE a (x INTEGER) STRICT;
CREATE TEMP TRIGGER a_guard BEFORE UPDATE ON a WHEN (CASE WHEN 1 THEN 1 END) = 1
BEGIN
  SELECT CASE WHEN NEW.x < 0 THEN RAISE(ABORT, 'negative') END;
  SELECT RAISE(ABORT, 'no; updates');
END;
INSERT INTO a VALUES (1);`;
    const statements = splitSqlStatements(script);
    expect(statements).toHaveLength(3);
    expect(statements[1]?.text.startsWith("CREATE TEMP TRIGGER")).toBe(true);
    expect(statements[1]?.text.endsWith("END")).toBe(true);
    expect(statements[2]?.text).toBe("INSERT INTO a VALUES (1)");
  });
});

describe("analyzeStatement", () => {
  it("counts statements and placeholders", () => {
    expect(analyzeStatement("SELECT ?, ? FROM t;").statementCount).toBe(1);
    expect(analyzeStatement("SELECT ?, ? FROM t;").anonymousParameters).toBe(2);
    expect(analyzeStatement("SELECT 1; SELECT 2").statementCount).toBe(2);
    expect(analyzeStatement("-- nothing").statementCount).toBe(0);
    expect(analyzeStatement("SELECT ?1, :a, @b, $c").otherParameters).toEqual([
      "?1",
      ":a",
      "@b",
      "$c",
    ]);
    // SQLite treats these as named variables too (and would bind NULL to them).
    expect(analyzeStatement("SELECT :1, @2x, $_").otherParameters).toEqual([":1", "@2x", "$_"]);
  });

  it("flags transaction control and ATTACH", () => {
    for (const text of [
      "BEGIN",
      "begin immediate",
      "COMMIT",
      "END",
      "ROLLBACK",
      "SAVEPOINT s",
      "RELEASE s",
      "ATTACH 'x' AS y",
      "DETACH y",
    ]) {
      expect(analyzeStatement(text).transactionControl).toBe(true);
    }
    expect(analyzeStatement("SELECT 'BEGIN'").transactionControl).toBe(false);
  });

  it("classifies only reads as read-only", () => {
    expect(analyzeStatement("SELECT replace(name, 'a', 'b') FROM t").readOnly).toBe(true);
    expect(analyzeStatement("WITH x AS (SELECT 1) SELECT * FROM x").readOnly).toBe(true);
    expect(analyzeStatement("VALUES (1)").readOnly).toBe(true);
    expect(analyzeStatement("SELECT updated_at FROM t").readOnly).toBe(true);
    expect(analyzeStatement("INSERT INTO t VALUES (1)").readOnly).toBe(false);
    expect(analyzeStatement("UPDATE t SET a = 1 RETURNING a").readOnly).toBe(false);
    expect(analyzeStatement("WITH x AS (SELECT 1) DELETE FROM t").readOnly).toBe(false);
    expect(analyzeStatement("PRAGMA journal_mode = WAL").readOnly).toBe(false);
    expect(analyzeStatement("CREATE TABLE t (a TEXT)").readOnly).toBe(false);
  });

  it("finds write targets without mistaking subqueries, functions or trigger clauses", () => {
    const targets = (text: string) => analyzeStatement(text).writeTargets;
    expect(
      targets(
        "UPDATE users SET role = 'admin' WHERE NOT EXISTS (SELECT 1 FROM beta_admin_events WHERE action = 'admin_bootstrap')",
      ),
    ).toEqual([{ operation: "update", name: "users" }]);
    expect(targets(`UPDATE OR IGNORE "Main"."Events" SET a = 1`)).toEqual([
      { operation: "update", name: "events" },
    ]);
    expect(targets("DELETE FROM main.t WHERE id IN (SELECT id FROM beta_admin_events)")).toEqual([
      { operation: "delete", name: "t" },
    ]);
    expect(targets("INSERT OR REPLACE INTO t (a) VALUES (1)")).toEqual([
      { operation: "replace", name: "t" },
    ]);
    expect(targets("REPLACE INTO t (a) VALUES (1)")).toEqual([{ operation: "replace", name: "t" }]);
    expect(
      targets("INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = excluded.a"),
    ).toEqual([
      { operation: "insert", name: "t" },
      { operation: "upsert_update", name: "t" },
    ]);
    expect(targets("INSERT INTO t (a) VALUES (1) ON CONFLICT DO NOTHING")).toEqual([
      { operation: "insert", name: "t" },
    ]);
    expect(targets("SELECT replace(a, 'x', 'y') FROM t")).toEqual([]);
    expect(
      targets("CREATE TABLE c (p TEXT REFERENCES t (id) ON DELETE CASCADE ON UPDATE CASCADE)"),
    ).toEqual([]);
    expect(targets("CREATE TRIGGER g BEFORE DELETE ON t BEGIN SELECT 1; END")).toEqual([]);
    expect(targets("DROP TABLE IF EXISTS t")).toEqual([{ operation: "drop_table", name: "t" }]);
    expect(targets("DROP TRIGGER t_guard")).toEqual([
      { operation: "drop_trigger", name: "t_guard" },
    ]);
    expect(targets("ALTER TABLE t RENAME TO u")).toEqual([{ operation: "alter_table", name: "t" }]);
  });
});
