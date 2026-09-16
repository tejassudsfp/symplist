import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FakeD1Api } from "../../testing/src/contracts/db/fake-d1-api.ts";
import { D1CircuitBreaker } from "./circuit-breaker.ts";
import type { MigrationTarget } from "./client.ts";
import { D1RestClient } from "./d1-rest-client.ts";
import { DbStatementError, DbUnknownOutcomeError } from "./errors.ts";
import { createLocalSqliteClient, type LocalSqliteClient } from "./local-sqlite-client.ts";
import {
  applyMigrations,
  D1_MIGRATIONS_TABLE_SQL,
  loadMigrations,
  MIGRATIONS_DIR,
  type MigrationFile,
  type MigrationLogEvent,
  migrationRequestSql,
} from "./migrations.ts";
import { sql } from "./query.ts";
import { RateLane } from "./rate-limit.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function local(path = ":memory:"): LocalSqliteClient {
  const client = createLocalSqliteClient({ path, env: {} });
  cleanups.push(() => client.close());
  return client;
}

function recordingLogger() {
  const events: Array<{ level: string } & MigrationLogEvent> = [];
  return {
    events,
    logger: {
      info: (event: MigrationLogEvent) => events.push({ level: "info", ...event }),
      warn: (event: MigrationLogEvent) => events.push({ level: "warn", ...event }),
      error: (event: MigrationLogEvent) => events.push({ level: "error", ...event }),
    },
  };
}

function countingScripts(target: MigrationTarget): { target: MigrationTarget; scripts: string[] } {
  const scripts: string[] = [];
  return {
    scripts,
    target: {
      batch: (statements, options) => target.batch(statements, options),
      all: (statement, options) => target.all(statement, options),
      first: (statement, options) => target.first(statement, options),
      run: (statement, options) => target.run(statement, options),
      executeScript: async (text, options) => {
        scripts.push(text);
        await target.executeScript(text, options);
      },
    },
  };
}

const file = (name: string, text: string): MigrationFile => ({ name, sql: text });

describe("loadMigrations", () => {
  it("resolves the packaged migrations directory and loads files in lexical order", async () => {
    expect(MIGRATIONS_DIR).toBe(fileURLToPath(new URL("../migrations/", import.meta.url)));
    const files = await loadMigrations();
    const names = files.map((migration) => migration.name);
    expect(names).toEqual([...names].sort());
    expect(names[0]).toBe("0001_users.sql");
  });

  it("keeps every file inside the foundation range or a feature range (§3.4)", async () => {
    const numbers = (await loadMigrations()).map((migration) => Number(migration.name.slice(0, 4)));
    // Foundation 0001-0019; access 01xx through analytics and consent 10xx.
    const inOwnerRange = (number: number) =>
      (number >= 1 && number <= 19) || (number >= 100 && number <= 1099);
    expect(numbers.filter((number) => !inOwnerRange(number))).toEqual([]);
    expect(inOwnerRange(20)).toBe(false);
    expect(inOwnerRange(99)).toBe(false);
    expect(inOwnerRange(1100)).toBe(false);
  });

  it("keeps every migration expand-only (§3.4)", async () => {
    // Migrations add tables, nullable or defaulted columns, indexes and triggers. Drops, renames and
    // tightened constraints ship in a later release, because the runner applies them while the
    // previous release is still serving: a table copied and swapped in loses every row written
    // between the copy and the drop, and a request that is not atomic can leave no table at all.
    const forbidden =
      /\b(DROP\s+(TABLE|COLUMN|INDEX|TRIGGER|VIEW)|RENAME\s+(TO|COLUMN)|ALTER\s+COLUMN)\b/i;
    const offenders = (await loadMigrations())
      .filter((migration) =>
        forbidden.test(
          // Comments explain why a rule exists; only executable text is checked.
          migration.sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, ""),
        ),
      )
      .map((migration) => migration.name);
    expect(offenders).toEqual([]);
    expect(forbidden.test("DROP TABLE user_preferences;")).toBe(true);
    expect(forbidden.test("ALTER TABLE x RENAME TO y;")).toBe(true);
    expect(forbidden.test("ALTER TABLE tasks ADD COLUMN preview_enc TEXT;")).toBe(false);
  });

  it("rejects badly named and empty files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "symplist-migrations-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "0001_ok.sql"), "CREATE TABLE a (x TEXT) STRICT;");
    writeFileSync(join(dir, "notes.txt"), "ignored");
    writeFileSync(join(dir, "2_Bad-Name.sql"), "SELECT 1;");
    await expect(loadMigrations(dir)).rejects.toMatchObject({ code: "db.migration_failed" });
    rmSync(join(dir, "2_Bad-Name.sql"));
    writeFileSync(join(dir, "0002_empty.sql"), "  \n");
    await expect(loadMigrations(dir)).rejects.toThrow(/0002_empty.sql is empty/);
  });
});

describe("migrationRequestSql", () => {
  it("appends the wrangler-shaped d1_migrations insert to the file", () => {
    expect(migrationRequestSql(file("0001_users.sql", "CREATE TABLE a (x TEXT) STRICT;"))).toBe(
      "CREATE TABLE a (x TEXT) STRICT;\nINSERT INTO \"d1_migrations\" (name)\nvalues ('0001_users.sql');",
    );
    expect(() =>
      migrationRequestSql(file("0001_x'); DROP TABLE users; --.sql", "SELECT 1")),
    ).toThrow(/Invalid migration name/);
  });

  it("creates the migrations table exactly as wrangler does", () => {
    expect(D1_MIGRATIONS_TABLE_SQL).toContain('CREATE TABLE IF NOT EXISTS "d1_migrations"(');
    expect(D1_MIGRATIONS_TABLE_SQL).toContain("id         INTEGER PRIMARY KEY AUTOINCREMENT,");
    expect(D1_MIGRATIONS_TABLE_SQL).toContain("name       TEXT UNIQUE,");
    expect(D1_MIGRATIONS_TABLE_SQL).toContain(
      "applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL",
    );
  });
});

describe("applyMigrations", () => {
  it("applies every foundation migration once, one request per file, and is idempotent", async () => {
    const db = local();
    const { target, scripts } = countingScripts(db);
    const { events, logger } = recordingLogger();
    const files = await loadMigrations();

    const first = await applyMigrations(target, { logger });
    expect(first.applied).toEqual(files.map((migration) => migration.name));
    expect(first.outOfOrder).toEqual([]);
    // One request creates the table, then one per file.
    expect(scripts).toHaveLength(files.length + 1);
    expect(scripts.slice(1)).toEqual(files.map(migrationRequestSql));
    expect(events.filter((event) => event.event === "migration.applied")).toHaveLength(
      files.length,
    );

    const rows = await db.all(sql(`SELECT id, name, applied_at FROM "d1_migrations" ORDER BY id`));
    expect(rows.map((row) => row.name)).toEqual(files.map((migration) => migration.name));
    expect(rows.every((row) => typeof row.applied_at === "string")).toBe(true);

    const second = await applyMigrations(target);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toHaveLength(files.length);
    expect(scripts).toHaveLength(files.length + 2);
  });

  it("logs files applied out of order and warns about unknown applied files", async () => {
    const db = local();
    const { events, logger } = recordingLogger();
    await applyMigrations(db, {
      migrations: [
        file("0001_a.sql", "CREATE TABLE a (x TEXT) STRICT;"),
        file("0003_c.sql", "CREATE TABLE c (x TEXT) STRICT;"),
      ],
    });
    const report = await applyMigrations(db, {
      logger,
      migrations: [
        file("0001_a.sql", "CREATE TABLE a (x TEXT) STRICT;"),
        file("0002_b.sql", "CREATE TABLE b (x TEXT) STRICT;"),
        file("0004_d.sql", "CREATE TABLE d (x TEXT) STRICT;"),
      ],
    });
    expect(report).toEqual({
      applied: ["0002_b.sql", "0004_d.sql"],
      alreadyApplied: ["0001_a.sql"],
      outOfOrder: ["0002_b.sql"],
    });
    expect(events).toContainEqual({
      level: "warn",
      event: "migration.out_of_order",
      name: "0002_b.sql",
      latestApplied: "0003_c.sql",
    });
    expect(events).toContainEqual({
      level: "warn",
      event: "migration.unknown_applied",
      name: "0003_c.sql",
    });
  });

  it("stops at a failing file and rolls back its statements and record", async () => {
    const db = local();
    const { events, logger } = recordingLogger();
    const error = await applyMigrations(db, {
      logger,
      migrations: [
        file("0001_a.sql", "CREATE TABLE a (x TEXT) STRICT;"),
        file(
          "0002_bad.sql",
          "CREATE TABLE b (x TEXT) STRICT;\nINSERT INTO missing_table VALUES (1);",
        ),
        file("0003_c.sql", "CREATE TABLE c (x TEXT) STRICT;"),
      ],
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DbStatementError);
    expect(events).toContainEqual({
      level: "error",
      event: "migration.failed",
      name: "0002_bad.sql",
      code: "db.statement_failed",
    });
    const tables = await db.all(
      sql(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('a', 'b', 'c') ORDER BY name",
      ),
    );
    expect(tables).toEqual([{ name: "a" }]);
    await expect(db.all(sql(`SELECT name FROM "d1_migrations"`))).resolves.toEqual([
      { name: "0001_a.sql" },
    ]);
  });

  it("skips a file another runner recorded first", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "symplist-concurrent-")), "d1.sqlite");
    cleanups.push(() => rmSync(join(path, ".."), { recursive: true, force: true }));
    const runnerA = local(path);
    const runnerB = local(path);
    const migrations = [
      file("0001_a.sql", "CREATE TABLE a (x TEXT) STRICT;"),
      file("0002_b.sql", "CREATE TABLE b (x TEXT) STRICT;"),
    ];
    // Runner B read the applied list before runner A applied anything.
    let staleRead = true;
    const staleB: MigrationTarget = {
      batch: (statements, options) => runnerB.batch(statements, options),
      first: (statement, options) => runnerB.first(statement, options),
      run: (statement, options) => runnerB.run(statement, options),
      executeScript: (text, options) => runnerB.executeScript(text, options),
      all: async (statement, options) => {
        if (staleRead && statement.sql.includes("d1_migrations")) {
          staleRead = false;
          await applyMigrations(runnerA, { migrations });
          return [];
        }
        return runnerB.all(statement, options);
      },
    };
    const { events, logger } = recordingLogger();
    const report = await applyMigrations(staleB, { migrations, logger });
    expect(report.applied).toEqual([]);
    expect(
      events
        .filter((event) => event.event === "migration.applied_concurrently")
        .map((event) => event.name),
    ).toEqual(["0001_a.sql", "0002_b.sql"]);
    await expect(runnerA.all(sql(`SELECT name FROM "d1_migrations" ORDER BY id`))).resolves.toEqual(
      [{ name: "0001_a.sql" }, { name: "0002_b.sql" }],
    );
  });

  it("counts a file whose response was lost as applied once its record is found, and fails when it is not", async () => {
    const db = local();
    const migrations = [
      file("0001_a.sql", "CREATE TABLE a (x TEXT) STRICT;"),
      file("0002_b.sql", "CREATE TABLE b (x TEXT) STRICT;"),
    ];
    let mode: "commit_then_lose" | "lose_before_commit" = "commit_then_lose";
    const lossy: MigrationTarget = {
      batch: (statements, options) => db.batch(statements, options),
      all: (statement, options) => db.all(statement, options),
      first: (statement, options) => db.first(statement, options),
      run: (statement, options) => db.run(statement, options),
      executeScript: async (text, options) => {
        if (!text.includes("0001_a.sql")) return db.executeScript(text, options);
        if (mode === "commit_then_lose") await db.executeScript(text, options);
        throw new DbUnknownOutcomeError("timeout");
      },
    };

    mode = "lose_before_commit";
    const { events, logger } = recordingLogger();
    await expect(applyMigrations(lossy, { migrations, logger })).rejects.toMatchObject({
      code: "db.unknown_outcome",
    });
    expect(events).toContainEqual({
      level: "error",
      event: "migration.failed",
      name: "0001_a.sql",
      code: "db.unknown_outcome",
    });
    // The runner stopped: nothing after the unresolved file was applied.
    await expect(db.all(sql(`SELECT name FROM "d1_migrations"`))).resolves.toEqual([]);

    mode = "commit_then_lose";
    const report = await applyMigrations(lossy, { migrations });
    expect(report.applied).toEqual(["0001_a.sql", "0002_b.sql"]);
    await expect(db.all(sql(`SELECT name FROM "d1_migrations" ORDER BY id`))).resolves.toEqual([
      { name: "0001_a.sql" },
      { name: "0002_b.sql" },
    ]);
  });

  it("rejects duplicate names", async () => {
    await expect(
      applyMigrations(local(), {
        migrations: [file("0001_a.sql", "SELECT 1;"), file("0001_a.sql", "SELECT 2;")],
      }),
    ).rejects.toMatchObject({ code: "db.migration_failed" });
  });

  it("sends the same wrangler-shaped requests through the REST client", async () => {
    const database = local();
    const api = new FakeD1Api({ database });
    const client = new D1RestClient({
      accountId: "0123456789abcdef0123456789abcdef",
      databaseId: "01234567-89ab-4cde-8f01-23456789abcd",
      apiToken: "fake-d1-token-for-tests",
      lane: new RateLane({ name: "migrations", ratePerSecond: 1_000, burst: 1, maxWaitMs: 5_000 }),
      circuit: new D1CircuitBreaker(),
      fetch: api.fetch,
    });
    const files = await loadMigrations();
    const report = await applyMigrations(client);
    expect(report.applied).toHaveLength(files.length);
    // Create table, applied-list read, then one request per file.
    expect(api.requests).toHaveLength(files.length + 2);
    expect(api.requests[0]?.body).toEqual({ sql: D1_MIGRATIONS_TABLE_SQL });
    expect(api.requests.slice(2).map((request) => request.body)).toEqual(
      files.map((migration) => ({ sql: migrationRequestSql(migration) })),
    );
    await expect(applyMigrations(client)).resolves.toMatchObject({ applied: [] });
    expect(api.requests).toHaveLength(files.length + 4);
  });
});
