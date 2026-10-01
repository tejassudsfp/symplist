import type { BugReportReceipt } from "@symplist/contracts";
import { BUG_REPORT_MAX_LENGTH } from "@symplist/contracts";
import { bugReportContext, bugReportKey, decryptFieldText, zeroize } from "@symplist/crypto";
import type { DbRow } from "@symplist/db";
import { sql } from "@symplist/db";
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApp, type TestApp } from "../../../test/harness.ts";
import { ipRequestBuckets } from "../../infra/limits/ip-limits.ts";

const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function boot(): Promise<TestApp> {
  const app = await bootTestApp();
  apps.push(app);
  return app;
}

interface BugRow extends DbRow {
  readonly id: string;
  readonly reporter_id: string | null;
  readonly report_enc: string;
  readonly kek_version: number;
  readonly surface: string;
  readonly page: string | null;
  readonly app_version: string | null;
  readonly platform: string | null;
  readonly user_agent: string | null;
}

async function onlyRow(app: TestApp): Promise<BugRow> {
  const rows = await app.db.all<BugRow>(
    sql(
      `SELECT id, reporter_id, report_enc, kek_version, surface, page, app_version, platform,
              user_agent
       FROM bugs ORDER BY created_at, id`,
    ),
  );
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) throw new Error("no bug row");
  return row;
}

/** Reads a stored report back the way a maintainer triaging the table would. */
function readReport(app: TestApp, row: BugRow): string {
  const key = bugReportKey(app.keys, row.reporter_id, row.kek_version);
  try {
    return decryptFieldText(key, bugReportContext(row.reporter_id, row.id), row.report_enc);
  } finally {
    zeroize(key.key);
  }
}

describe("bug reports over HTTP", () => {
  it("files an attributed report from a signed-in person and stores the text encrypted", async () => {
    const app = await boot();
    const { session } = await app.createSignedInUser();
    const response = await app.post("/v1/bugs", {
      session,
      body: {
        report: "  The task page went blank when I archived a subtask  ",
        surface: "workspace",
        page: "/tasks/0199a1b2-0000-7000-8000-000000000001",
        appVersion: "0.0.1",
      },
      headers: { "user-agent": "SymplistTest/1.0" },
    });
    expect(response.status, response.text).toBe(201);
    const receipt = response.json<BugReportReceipt>();

    const row = await onlyRow(app);
    expect(row).toMatchObject({
      id: receipt.id,
      reporter_id: session.userId,
      surface: "workspace",
      page: "/tasks/0199a1b2-0000-7000-8000-000000000001",
      app_version: "0.0.1",
      platform: null,
      user_agent: "SymplistTest/1.0",
    });
    expect(row.report_enc).toMatch(/^sym1\./);
    expect(readReport(app, row)).toBe("The task page went blank when I archived a subtask");
    // The words themselves never land in a column, a log line or the receipt.
    expect(await app.scanDatabaseFor("went blank")).toEqual([]);
    expect(app.logs.text()).not.toContain("went blank");
    expect(response.text).not.toContain("went blank");
  });

  it("files a report with nobody signed in, bound to no account", async () => {
    const app = await boot();
    const response = await app.post("/v1/bugs/anonymous", {
      body: { report: "Sign in did nothing after I typed the code", surface: "site", page: "/" },
      csrf: "1",
      headers: { "user-agent": "SymplistTest/1.0" },
    });
    expect(response.status, response.text).toBe(201);

    const row = await onlyRow(app);
    expect(row.reporter_id).toBeNull();
    expect(row.surface).toBe("site");
    expect(readReport(app, row)).toBe("Sign in did nothing after I typed the code");
    expect(await app.scanDatabaseFor("did nothing")).toEqual([]);
  });

  it("records the surface the desktop shell reports", async () => {
    const app = await boot();
    const { session } = await app.createSignedInUser();
    const response = await app.post("/v1/bugs", {
      session,
      body: {
        report: "The window reopened empty",
        surface: "desktop",
        appVersion: "0.0.1",
        platform: "darwin",
      },
    });
    expect(response.status, response.text).toBe(201);
    expect(await onlyRow(app)).toMatchObject({ surface: "desktop", platform: "darwin" });
  });

  it("refuses the attributed route without a session and the public one without its CSRF header", async () => {
    const app = await boot();
    const body = { report: "Something broke", surface: "site" };
    expect((await app.post("/v1/bugs", { body })).status).toBe(401);
    expect((await app.post("/v1/bugs/anonymous", { body, csrf: null })).status).toBe(403);
    expect(
      (await app.post("/v1/bugs/anonymous", { body, csrf: "1", origin: "https://evil.test" }))
        .status,
    ).toBe(403);
    expect(await app.db.all(sql("SELECT id FROM bugs"))).toEqual([]);
  });

  it("refuses an empty report and one past the length cap", async () => {
    const app = await boot();
    const { session } = await app.createSignedInUser();
    expect(
      (await app.post("/v1/bugs", { session, body: { report: "   ", surface: "site" } })).status,
    ).toBe(400);
    expect(
      (
        await app.post("/v1/bugs", {
          session,
          body: { report: "x".repeat(BUG_REPORT_MAX_LENGTH + 1), surface: "site" },
        })
      ).status,
    ).toBe(400);
    expect(
      (await app.post("/v1/bugs", { session, body: { report: "ok", surface: "phone" } })).status,
    ).toBe(400);
    expect(await app.db.all(sql("SELECT id FROM bugs"))).toEqual([]);
  });

  it("shares one per-IP bucket between the two routes, so signing in buys no extra allowance", async () => {
    const app = await boot();
    const { session } = await app.createSignedInUser();
    const body = { report: "Reminders fire twice", surface: "site" };
    const { limit } = ipRequestBuckets.bug_report;
    for (let index = 0; index < limit - 1; index += 1) {
      expect((await app.post("/v1/bugs", { session, body })).status).toBe(201);
    }
    expect((await app.post("/v1/bugs/anonymous", { body, csrf: "1" })).status).toBe(201);
    const refused = await app.post("/v1/bugs/anonymous", { body, csrf: "1" });
    // `rate.limited` answers 503 with `Retry-After` (decision C6.7), not 429.
    expect(refused.status, refused.text).toBe(503);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe("rate.limited");
    expect(await app.db.all(sql("SELECT id FROM bugs"))).toHaveLength(limit);
  });
});
