import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  FAKE_D1_ACCOUNT_ID,
  FAKE_D1_API_TOKEN,
  FAKE_D1_DATABASE_ID,
  FakeD1Api,
} from "../../testing/src/contracts/db/fake-d1-api.ts";
import { createLocalSqliteClient } from "./local-sqlite-client.ts";
import { readMigrateConfig, runMigrateCli } from "./migrate-cli.ts";
import { loadMigrations, MIGRATIONS_DIR } from "./migrations.ts";
import { sql } from "./query.ts";
import { RateLane } from "./rate-limit.ts";

const run = promisify(execFile);
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "symplist-migrate-cli-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { log: (line: string) => out.push(line), error: (line: string) => err.push(line) },
  };
}

const d1Env = {
  DATA_DRIVER: "d1",
  CLOUDFLARE_ACCOUNT_ID: FAKE_D1_ACCOUNT_ID,
  D1_DATABASE_ID: FAKE_D1_DATABASE_ID,
};

describe("readMigrateConfig", () => {
  it("requires an explicit driver", () => {
    expect(() => readMigrateConfig([], {}, "/repo")).toThrow(/DATA_DRIVER/);
    expect(() => readMigrateConfig([], { DATA_DRIVER: "postgres" }, "/repo")).toThrow(
      /DATA_DRIVER/,
    );
  });

  it("resolves the local database path and refuses production", () => {
    expect(readMigrateConfig([], { DATA_DRIVER: "local" }, "/repo")).toEqual({
      driver: "local",
      migrationsDir: MIGRATIONS_DIR,
      databasePath: "/repo/.local-data/d1.sqlite",
    });
    expect(
      readMigrateConfig(
        ["--driver", "local", "--database", "tmp/x.sqlite", "--dir", "m"],
        {},
        "/repo",
      ),
    ).toEqual({
      driver: "local",
      migrationsDir: "/repo/m",
      databasePath: "/repo/tmp/x.sqlite",
    });
    expect(() =>
      readMigrateConfig([], { DATA_DRIVER: "local", NODE_ENV: "production" }, "/repo"),
    ).toThrow(/production/);
  });

  it("prefers the migrate token, falls back to the api token and never accepts the worker token", () => {
    expect(
      readMigrateConfig(
        [],
        { ...d1Env, CLOUDFLARE_D1_MIGRATE_API_TOKEN: "migrate", CLOUDFLARE_D1_API_TOKEN: "api" },
        "/repo",
      ),
    ).toMatchObject({
      driver: "d1",
      apiToken: "migrate",
      tokenVariable: "CLOUDFLARE_D1_MIGRATE_API_TOKEN",
    });
    expect(
      readMigrateConfig([], { ...d1Env, CLOUDFLARE_D1_API_TOKEN: "api" }, "/repo"),
    ).toMatchObject({
      apiToken: "api",
      tokenVariable: "CLOUDFLARE_D1_API_TOKEN",
    });
    expect(() =>
      readMigrateConfig([], { ...d1Env, CLOUDFLARE_D1_WORKER_API_TOKEN: "worker" }, "/repo"),
    ).toThrow(/CLOUDFLARE_D1_MIGRATE_API_TOKEN or CLOUDFLARE_D1_API_TOKEN/);
    expect(() =>
      readMigrateConfig([], { DATA_DRIVER: "d1", CLOUDFLARE_D1_API_TOKEN: "api" }, "/repo"),
    ).toThrow(/CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID/);
    expect(() =>
      readMigrateConfig(["--database", "x"], { ...d1Env, CLOUDFLARE_D1_API_TOKEN: "api" }, "/repo"),
    ).toThrow(/only to the local driver/);
  });

  it("rejects unknown arguments", () => {
    expect(() => readMigrateConfig(["--force"], { DATA_DRIVER: "local" }, "/repo")).toThrow();
    expect(() => readMigrateConfig(["positional"], { DATA_DRIVER: "local" }, "/repo")).toThrow();
  });
});

describe("runMigrateCli", () => {
  it("applies migrations to a local database and reports structured JSON lines", async () => {
    const dir = tempDir();
    const { out, err, io } = captureIo();
    const files = await loadMigrations();
    await expect(
      runMigrateCli(["--database", "d1.sqlite"], { DATA_DRIVER: "local" }, io, dir),
    ).resolves.toBe(0);
    expect(err).toEqual([]);
    const events = out.map((line) => JSON.parse(line) as { event: string; applied?: number });
    expect(events[0]).toEqual({ level: "info", event: "migrate.start", driver: "local" });
    expect(events.at(-1)).toMatchObject({
      event: "migrate.done",
      applied: files.length,
      alreadyApplied: 0,
    });

    await expect(
      runMigrateCli(["--database", "d1.sqlite"], { DATA_DRIVER: "local" }, captureIo().io, dir),
    ).resolves.toBe(0);
    const database = createLocalSqliteClient({ path: join(dir, "d1.sqlite"), env: {} });
    cleanups.push(() => database.close());
    await expect(
      database.first(sql(`SELECT COUNT(*) AS count FROM "d1_migrations"`)),
    ).resolves.toEqual({ count: files.length });
  });

  it("applies migrations to D1 over REST without logging the token", async () => {
    const database = createLocalSqliteClient({ path: ":memory:", env: {} });
    cleanups.push(() => database.close());
    const api = new FakeD1Api({ database });
    const { out, err, io } = captureIo();
    const code = await runMigrateCli(
      [],
      { ...d1Env, CLOUDFLARE_D1_MIGRATE_API_TOKEN: FAKE_D1_API_TOKEN },
      {
        ...io,
        fetch: api.fetch,
        lane: new RateLane({
          name: "migrations",
          ratePerSecond: 1_000,
          burst: 1,
          maxWaitMs: 5_000,
        }),
      },
    );
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(
      api.requests.every((request) => request.authorization === `Bearer ${FAKE_D1_API_TOKEN}`),
    ).toBe(true);
    expect(out.join("\n")).not.toContain(FAKE_D1_API_TOKEN);
    expect(JSON.parse(out[0] as string)).toEqual({
      level: "info",
      event: "migrate.start",
      driver: "d1",
      token: "CLOUDFLARE_D1_MIGRATE_API_TOKEN",
    });
    await expect(database.first(sql("SELECT generation FROM executor_state"))).resolves.toEqual({
      generation: 1,
    });
  });

  it("exits 1 with the error name and code on failure, without secrets or provider text", async () => {
    const database = createLocalSqliteClient({ path: ":memory:", env: {} });
    cleanups.push(() => database.close());
    const api = new FakeD1Api({ database, apiToken: "the-right-token" });
    const { err, io } = captureIo();
    const code = await runMigrateCli(
      [],
      { ...d1Env, CLOUDFLARE_D1_API_TOKEN: "a-wrong-token" },
      { ...io, fetch: api.fetch },
    );
    expect(code).toBe(1);
    expect(err).toHaveLength(1);
    expect(JSON.parse(err[0] as string)).toEqual({
      level: "error",
      event: "migrate.failed",
      name: "DbError",
      code: "db.unauthorized",
    });
    expect(err[0]).not.toContain("a-wrong-token");

    const failing = tempDir();
    writeFileSync(join(failing, "0001_bad.sql"), "INSERT INTO missing_table VALUES (1);");
    const local = captureIo();
    await expect(
      runMigrateCli(
        ["--database", "d1.sqlite", "--dir", failing],
        { DATA_DRIVER: "local" },
        local.io,
        failing,
      ),
    ).resolves.toBe(1);
    const events = local.err.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toContainEqual({
      level: "error",
      event: "migration.failed",
      name: "0001_bad.sql",
      code: "db.statement_failed",
    });
    expect(local.err.join("\n")).not.toContain("missing_table");

    const usage = captureIo();
    await expect(runMigrateCli([], {}, usage.io)).resolves.toBe(1);
    expect(JSON.parse(usage.err[0] as string)).toMatchObject({ code: "db.config_invalid" });
  });

  it("prints usage for --help", async () => {
    const { out, io } = captureIo();
    await expect(runMigrateCli(["--help"], {}, io)).resolves.toBe(0);
    expect(out[0]).toContain("pnpm db:migrate");
  });

  it("runs from source as the pnpm db:migrate entry point", async () => {
    const dir = tempDir();
    const entry = fileURLToPath(new URL("./cli/migrate.ts", import.meta.url));
    const { stdout, stderr } = await run(
      process.execPath,
      [entry, "--driver", "local", "--database", join(dir, "d1.sqlite")],
      {
        env: { PATH: process.env.PATH ?? "" },
      },
    );
    expect(stderr).toBe("");
    const last = JSON.parse(stdout.trim().split("\n").at(-1) as string) as {
      event: string;
      applied: number;
    };
    expect(last.event).toBe("migrate.done");
    expect(last.applied).toBeGreaterThan(0);
    const failed = await run(process.execPath, [entry], {
      env: { PATH: process.env.PATH ?? "" },
    }).catch((error: { code: number; stderr: string }) => error);
    expect(failed).toMatchObject({ code: 1 });
  });
});
