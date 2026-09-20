import { randomBytes, randomUUID } from "node:crypto";
import { D1CircuitBreaker, d1Outcomes, sql } from "@symplist/db";
import { FakeClock, FakeTriggerClient } from "@symplist/testing";
import { describe, expect, it } from "vitest";
import { createWorkerDb, workerProcessLane } from "./clients.ts";
import { loadWorkerRuntimeConfig } from "./config.ts";
import {
  createWorkerD1Counters,
  D1_COUNTERS_EVENT,
  d1OutcomeFields,
  reportingD1Counters,
  WorkerD1CounterReporter,
} from "./d1-counters.ts";
import { createWorkerLogger } from "./logger.ts";

const family = () => randomBytes(32).toString("base64url");
const MARKER = "MARKER-3c1e-sql-and-rows";

function hostedConfig(token: string) {
  return loadWorkerRuntimeConfig({
    NODE_ENV: "development",
    WEB_ORIGIN: "http://localhost:3000",
    API_ORIGIN: "http://localhost:4000",
    WS_ORIGIN: "ws://localhost:4000",
    DATA_DRIVER: "d1",
    EMAIL_DRIVER: "log",
    DURABLE: "false",
    EMAIL_FROM_REMINDERS: "Symplist <reminders@example.com>",
    TRIGGER_AI_SDK_OTEL_AUTOREGISTER: "0",
    CONTENT_KEK_1: family(),
    CONTENT_KEK_CURRENT: "1",
    INTERNAL_EVENT_SECRET_1: family(),
    INTERNAL_EVENT_SECRET_CURRENT: "1",
    REMINDER_UNSUBSCRIBE_SECRET_1: family(),
    REMINDER_UNSUBSCRIBE_SECRET_CURRENT: "1",
    CLOUDFLARE_ACCOUNT_ID: randomBytes(16).toString("hex"),
    D1_DATABASE_ID: randomUUID(),
    CLOUDFLARE_D1_WORKER_API_TOKEN: token,
    R2_BUCKET: "symplist-objects",
    R2_ACCESS_KEY_ID: randomBytes(12).toString("hex"),
    R2_SECRET_ACCESS_KEY: randomBytes(24).toString("hex"),
  });
}

const ok = (rows: Record<string, unknown>[]) =>
  new Response(
    JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: [{ success: true, results: rows, meta: {} }],
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        Ratelimit: "limit=1200, remaining=900, reset=30",
      },
    },
  );

/** A worker D1 client over a scripted D1 API, with its counters, reporter and Trigger log sink. */
function harness(replies: (() => Response)[]) {
  const clock = new FakeClock(Date.UTC(2026, 8, 16, 9));
  const trigger = new FakeTriggerClient({ clock });
  const circuit = new D1CircuitBreaker({ clock });
  const counters = createWorkerD1Counters({ clock, circuit });
  const token = randomBytes(24).toString("hex");
  const db = createWorkerDb(hostedConfig(token), {
    lane: workerProcessLane({ clock: clock as never }),
    counters,
    circuit,
    clock,
    fetch: async () => {
      const reply = replies.shift();
      if (!reply) throw new Error("unexpected D1 request");
      return reply();
    },
  });
  const reporter = new WorkerD1CounterReporter({
    counters,
    logger: createWorkerLogger(trigger.logger),
    timers: clock,
  });
  const reports = () => trigger.logs.filter((entry) => entry.message === D1_COUNTERS_EVENT);
  return { clock, trigger, db, reporter, token, reports };
}

describe("worker D1 counters (§3.1)", () => {
  it("names every D1 outcome with a field the redacting logger keeps", () => {
    expect(Object.keys(d1OutcomeFields)).toEqual([...d1Outcomes]);
    expect(d1OutcomeFields.statement_failed).toBe("outcomeStatementFailedCount");
    expect(d1OutcomeFields.http_429).toBe("outcomeHttp429Count");
  });

  it("reports d1.requests every minute with runtime, lane, outcomes, 429s, circuit state and bucket wait", async () => {
    const h = harness([
      () => ok([{ secret: MARKER }]),
      () => ok([{ secret: MARKER }]),
      () => new Response("{}", { status: 429, headers: { "Retry-After": "120" } }),
    ]);
    h.reporter.start();
    await h.db.first(sql(`SELECT '${MARKER}' AS secret`));
    await h.db.first(sql("SELECT :value AS secret", { value: MARKER }));
    await expect(h.db.first(sql("SELECT 1 AS one"))).rejects.toMatchObject({
      code: "rate.limited",
    });
    // The open circuit fails fast without a request.
    await expect(h.db.first(sql("SELECT 1 AS one"))).rejects.toMatchObject({
      code: "rate.limited",
    });

    await h.clock.advance(60_000);
    expect(h.reports()).toHaveLength(1);
    const properties = h.reports()[0]?.properties as Record<string, unknown>;
    expect(properties).toMatchObject({
      runtime: "worker",
      lane: "worker",
      reason: "interval",
      windowMs: 60_000,
      requestCount: 3,
      outcomeOkCount: 2,
      outcomeHttp429Count: 1,
      outcomeCircuitOpenCount: 1,
      http429Count: 1,
      readRetryCount: 0,
      isCircuitOpen: true,
      circuitOpenedCount: 1,
      bucketWaitCount: expect.any(Number),
      bucketWaitTotalMs: expect.any(Number),
      bucketWaitMaxMs: expect.any(Number),
      ratelimitRemainingCount: 900,
    });
    // Numbers, flags and fixed codes only: nothing was redacted, and no SQL, row or token leaked.
    expect(properties.redactedFields).toBeUndefined();
    for (const [name, value] of Object.entries(properties)) {
      if (["runtime", "lane", "reason"].includes(name)) expect(value).toMatch(/^[a-z_]+$/);
      else expect(["number", "boolean"]).toContain(value === null ? "number" : typeof value);
    }
    expect(h.trigger.findMarker(MARKER)).toEqual([]);
    expect(JSON.stringify(h.trigger.logs)).not.toContain(h.token);

    // A quiet minute without an open circuit reports nothing; the next active one does.
    await h.clock.advance(120_000);
    const quiet = h.reports().length;
    await h.clock.advance(60_000);
    expect(h.reports()).toHaveLength(quiet);
    h.reporter.stop();
  });

  it("reports the partial window at the end of a task run, even when the task throws", async () => {
    const h = harness([() => ok([{ one: 1 }])]);
    h.reporter.start();
    await h.clock.advance(20_000);
    await expect(
      reportingD1Counters(
        h.reporter,
        { task: "account-purge", runId: "run_cm7d1counters" },
        async () => {
          await h.db.first(sql("SELECT 1 AS one"));
          throw new Error("purge failed");
        },
      ),
    ).rejects.toThrow("purge failed");
    expect(h.reports()).toHaveLength(1);
    expect(h.reports()[0]?.properties).toMatchObject({
      reason: "task_end",
      task: "account-purge",
      runId: "run_cm7d1counters",
      windowMs: 20_000,
      requestCount: 1,
      outcomeOkCount: 1,
      isCircuitOpen: false,
      ratelimitRemainingCount: 900,
    });
    // The task-end report closed the window: the next minute has nothing to report.
    await h.clock.advance(60_000);
    expect(h.reports()).toHaveLength(1);

    const empty = await reportingD1Counters(
      h.reporter,
      { task: "account-purge" },
      async () => "done",
    );
    expect(empty).toBe("done");
    expect(h.reports()[1]?.properties).toMatchObject({
      reason: "task_end",
      requestCount: 0,
      ratelimitRemainingCount: null,
    });
    h.reporter.stop();
  });
});
