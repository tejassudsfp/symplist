import { inspect } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  describeDbClientContract,
  describeRawD1ParamTypes,
  observingFetch,
} from "../../testing/src/contracts/db/db-client-contract.ts";
import {
  FAKE_D1_ACCOUNT_ID,
  FAKE_D1_API_TOKEN,
  FAKE_D1_DATABASE_ID,
  FakeD1Api,
} from "../../testing/src/contracts/db/fake-d1-api.ts";
import { ManualClock } from "../../testing/src/contracts/db/manual-clock.ts";
import { D1CircuitBreaker } from "./circuit-breaker.ts";
import { d1Outcomes } from "./counters.ts";
import {
  D1RestClient,
  type D1RestClientOptions,
  type FetchLike,
  RETRYABLE_D1_MESSAGES,
} from "./d1-rest-client.ts";
import {
  type DbError,
  DbRateLimitedError,
  DbStatementError,
  DbUnavailableError,
  DbUnknownOutcomeError,
} from "./errors.ts";
import { D1_LIMITS } from "./limits.ts";
import { createLocalSqliteClient } from "./local-sqlite-client.ts";
import { sql } from "./query.ts";
import { RateLane } from "./rate-limit.ts";

type Reply = Response | Error | ((init: RequestInit) => Promise<Response>);

const envelope = (result: unknown[], headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status,
    headers,
  });

const failure = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      success: false,
      errors: [{ code: 7500, message }],
      messages: [],
      result: [],
      ...extra,
    }),
    { status },
  );

const rows = (...list: Array<Record<string, unknown>>) => ({
  success: true,
  results: list,
  meta: { changes: 0, duration: 1 },
});

const read = sql("SELECT id FROM tasks WHERE id = :id", { id: "task-1" });
const write = sql("UPDATE tasks SET write_id = :w WHERE id = :id", { w: "w-1", id: "task-1" });

function setup(overrides: Partial<D1RestClientOptions> = {}) {
  const clock = new ManualClock();
  const circuit = new D1CircuitBreaker({ clock });
  const lane = new RateLane({
    name: "api",
    ratePerSecond: 1_000,
    burst: 1_000,
    maxWaitMs: 1_000,
    clock,
  });
  const replies: Reply[] = [];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected request");
    if (reply instanceof Error) throw reply;
    if (typeof reply === "function") return reply(init);
    return reply;
  };
  const client = new D1RestClient({
    accountId: FAKE_D1_ACCOUNT_ID,
    databaseId: FAKE_D1_DATABASE_ID,
    apiToken: FAKE_D1_API_TOKEN,
    lane,
    circuit,
    clock,
    fetch,
    random: () => 0.5,
    ...overrides,
  });
  return { client, clock, circuit, lane, replies, calls };
}

async function settle<T>(
  promise: Promise<T>,
  clock: ManualClock,
  ms = 10_000,
): Promise<T | unknown> {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await clock.advance(ms);
  const result = await outcome;
  return "error" in result ? result.error : result.value;
}

const hangUntilAborted = (init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

describe("D1RestClient requests", () => {
  it("posts one batch request with the bearer token to the query endpoint", async () => {
    const { client, replies, calls } = setup();
    replies.push(envelope([rows({ id: "task-1" }), rows()]));
    const results = await client.batch([read, write]);
    expect(results).toEqual([
      { success: true, results: [{ id: "task-1" }], meta: { changes: 0, duration: 1 } },
      { success: true, results: [], meta: { changes: 0, duration: 1 } },
    ]);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${FAKE_D1_ACCOUNT_ID}/d1/database/${FAKE_D1_DATABASE_ID}/query`,
    );
    expect(call?.init.method).toBe("POST");
    const headers = new Headers(call?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${FAKE_D1_API_TOKEN}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(call?.init.body))).toEqual({
      batch: [
        { sql: "SELECT id FROM tasks WHERE id = ?", params: ["task-1"] },
        { sql: "UPDATE tasks SET write_id = ? WHERE id = ?", params: ["w-1", "task-1"] },
      ],
    });
  });

  it("uses the raw endpoint for read-only raw batches and maps rows back to objects", async () => {
    const { client, replies, calls } = setup();
    replies.push(
      envelope([
        {
          success: true,
          results: {
            columns: ["id", "n"],
            rows: [
              ["a", 1],
              ["b", null],
            ],
          },
          meta: {},
        },
      ]),
    );
    await expect(client.all(read, { raw: true })).resolves.toEqual([
      { id: "a", n: 1 },
      { id: "b", n: null },
    ]);
    expect(calls[0]?.url.endsWith("/raw")).toBe(true);
    await expect(client.batch([write], { raw: true })).rejects.toMatchObject({
      code: "db.invalid_statement",
    });
    expect(calls).toHaveLength(1);
  });

  it("sends migration scripts as one { sql } request", async () => {
    const { client, replies, calls } = setup();
    replies.push(envelope([rows(), rows()]));
    await client.executeScript("CREATE TABLE a (x TEXT) STRICT;\nINSERT INTO a VALUES ('y');");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      sql: "CREATE TABLE a (x TEXT) STRICT;\nINSERT INTO a VALUES ('y');",
    });
  });

  it("uses a 35-second abort by default", async () => {
    expect(D1_LIMITS.requestTimeoutMs).toBe(35_000);
    const spy = vi.spyOn(globalThis, "setTimeout");
    const { client, replies } = setup();
    replies.push(envelope([rows()]));
    await client.run(write);
    expect(spy.mock.calls.some(([, delay]) => delay === 35_000)).toBe(true);
  });

  it("validates configuration without echoing the token", () => {
    const base = {
      accountId: FAKE_D1_ACCOUNT_ID,
      databaseId: FAKE_D1_DATABASE_ID,
      apiToken: "tok",
      lane: "api" as const,
    };
    expect(() => new D1RestClient({ ...base, accountId: "../../other" })).toThrow(
      /CLOUDFLARE_ACCOUNT_ID/,
    );
    expect(() => new D1RestClient({ ...base, databaseId: "db/../../x" })).toThrow(/D1_DATABASE_ID/);
    expect(() => new D1RestClient({ ...base, apiToken: "tok\r\nX-Injected: 1" })).toThrow(/token/);
    expect(() => new D1RestClient({ ...base, apiToken: "" })).toThrow(/token/);
    expect(() => new D1RestClient({ ...base, baseUrl: "http://api.example.test" })).toThrow(
      /https/,
    );
    expect(() => new D1RestClient({ ...base, baseUrl: "http://127.0.0.1:8787" })).not.toThrow();
  });
});

describe("D1RestClient envelope parsing (§3.2)", () => {
  it("treats HTTP 400 as a failed batch", async () => {
    const { client, replies } = setup();
    replies.push(failure(400, "UNIQUE constraint failed: tasks.id: SQLITE_CONSTRAINT"));
    const error = await client.run(write).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DbStatementError);
    expect(error).toMatchObject({
      code: "db.statement_failed",
      kind: "constraint",
      constraint: "unique",
      httpStatus: 400,
    });
    expect((error as DbError).message).not.toContain("tasks.id");
    expect((error as DbError).providerMessage).toContain("UNIQUE constraint failed");
    expect(JSON.stringify(error)).not.toContain("UNIQUE");
  });

  it("treats success: false at the top level or on any statement as a failed batch", async () => {
    const { client, replies } = setup();
    replies.push(
      new Response(
        JSON.stringify({ success: false, errors: [], messages: [], result: [rows(), rows()] }),
        { status: 200 },
      ),
    );
    await expect(client.batch([read, write])).rejects.toMatchObject({
      code: "db.statement_failed",
      httpStatus: 200,
    });

    replies.push(envelope([rows(), { success: false, results: [], meta: {} }]));
    await expect(client.batch([read, write])).rejects.toMatchObject({
      code: "db.statement_failed",
      statementIndex: 1,
    });

    replies.push(
      new Response(
        JSON.stringify({
          success: true,
          errors: [{ code: 1, message: "boom" }],
          messages: [],
          result: [rows()],
        }),
        {
          status: 200,
        },
      ),
    );
    await expect(client.run(write)).rejects.toBeInstanceOf(DbStatementError);
  });

  it("treats HTTP 400 with an unparseable body as a failed batch, never retried or unknown", async () => {
    const { client, replies, calls } = setup();
    replies.push(new Response("<html>Bad Request</html>", { status: 400 }));
    await expect(client.run(write)).rejects.toMatchObject({
      code: "db.statement_failed",
      httpStatus: 400,
    });
    replies.push(new Response("", { status: 400 }));
    await expect(client.first(read)).rejects.toBeInstanceOf(DbStatementError);
    expect(calls).toHaveLength(2);
    expect(client.counters.snapshot()).toMatchObject({
      readRetries: 0,
      outcomes: { statement_failed: 2, unknown_outcome: 0 },
    });
  });

  it("reports a malformed success response as an unknown write outcome", async () => {
    const { client, replies, calls } = setup();
    replies.push(envelope([rows()]));
    await expect(client.batch([write, write])).rejects.toBeInstanceOf(DbUnknownOutcomeError);
    replies.push(new Response("<html>gateway</html>", { status: 200 }));
    await expect(client.run(write)).rejects.toMatchObject({
      code: "db.unknown_outcome",
      failure: "bad_response",
    });
    replies.push(envelope([{ success: true, results: "nope", meta: {} }]));
    await expect(client.run(write)).rejects.toMatchObject({ code: "db.unknown_outcome" });
    expect(calls).toHaveLength(3);
  });

  it("maps 401 and 403 to db.unauthorized and other 4xx to db.request_rejected, without retries", async () => {
    const { client, replies, calls } = setup();
    replies.push(
      failure(401, "Authentication error"),
      failure(403, "Forbidden"),
      failure(404, "Not found"),
    );
    await expect(client.first(read)).rejects.toMatchObject({ code: "db.unauthorized" });
    await expect(client.first(read)).rejects.toMatchObject({ code: "db.unauthorized" });
    await expect(client.first(read)).rejects.toMatchObject({ code: "db.request_rejected" });
    expect(calls).toHaveLength(3);
  });
});

describe("D1RestClient retries (§3.1)", () => {
  it("retries read-only batches on retryable D1 messages, 5xx and network errors with jittered backoff", async () => {
    const sleeps: number[] = [];
    const { client, clock, replies, calls } = setup({
      readRetry: { maxAttempts: 4, baseDelayMs: 200, maxDelayMs: 2_000 },
    });
    const originalSleep = clock.sleep.bind(clock);
    clock.sleep = (ms, signal) => {
      sleeps.push(ms);
      return originalSleep(ms, signal);
    };
    replies.push(
      failure(400, RETRYABLE_D1_MESSAGES[0] as string),
      new Response("upstream", { status: 503 }),
      new TypeError("fetch failed"),
      envelope([rows({ id: "task-1" })]),
    );
    const result = await settle(client.first(read), clock);
    expect(result).toEqual({ id: "task-1" });
    expect(calls).toHaveLength(4);
    // Full jitter with random() = 0.5 over 200, 400 and 800 ms ceilings.
    expect(sleeps).toEqual([100, 200, 400]);
    expect(client.counters.snapshot()).toMatchObject({
      requestsSent: 4,
      readRetries: 3,
      outcomes: { ok: 1 },
    });
  });

  it("retries every message D1 documents as retryable, including replica disconnects", async () => {
    expect(RETRYABLE_D1_MESSAGES).toContain("Replica disconnected from primary.");
    const { client, clock, replies, calls } = setup();
    replies.push(
      failure(400, "Replica disconnected from primary."),
      envelope([rows({ id: "task-1" })]),
    );
    await expect(settle(client.first(read), clock)).resolves.toEqual({ id: "task-1" });
    expect(calls).toHaveLength(2);
  });

  it("gives up on reads after the attempt limit with db.unavailable", async () => {
    const { client, clock, replies, calls } = setup();
    replies.push(
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    );
    const error = await settle(client.first(read), clock);
    expect(error).toBeInstanceOf(DbUnavailableError);
    expect(error).toMatchObject({ failure: "network" });
    expect(calls).toHaveLength(3);
  });

  it("does not retry reads that failed for a non-retryable reason", async () => {
    const { client, replies, calls } = setup();
    replies.push(failure(400, "no such table: tasks"));
    await expect(client.first(read)).rejects.toMatchObject({ kind: "syntax" });
    expect(calls).toHaveLength(1);
  });

  it("never retries writes: network errors, 5xx and retryable messages are unknown outcomes", async () => {
    const { client, replies, calls } = setup();
    replies.push(new TypeError("fetch failed"));
    await expect(client.run(write)).rejects.toMatchObject({
      code: "db.unknown_outcome",
      failure: "network",
    });
    replies.push(new Response("bad gateway", { status: 502 }));
    await expect(client.run(write)).rejects.toMatchObject({
      code: "db.unknown_outcome",
      failure: "server_error",
    });
    replies.push(failure(500, RETRYABLE_D1_MESSAGES[2] as string));
    await expect(client.run(write)).rejects.toMatchObject({ code: "db.unknown_outcome" });
    replies.push(failure(400, RETRYABLE_D1_MESSAGES[4] as string));
    await expect(client.batch([read, write])).rejects.toMatchObject({ code: "db.unknown_outcome" });
    expect(calls).toHaveLength(4);
    expect(client.counters.snapshot()).toMatchObject({
      requestsSent: 4,
      readRetries: 0,
      outcomes: { unknown_outcome: 4 },
    });
  });

  it("aborts after the request timeout: unknown outcome for writes, unavailable for reads", async () => {
    const { client, replies, calls } = setup({ timeoutMs: 20, readRetry: { maxAttempts: 3 } });
    replies.push(hangUntilAborted);
    await expect(client.run(write)).rejects.toMatchObject({
      code: "db.unknown_outcome",
      failure: "timeout",
    });
    replies.push(hangUntilAborted);
    await expect(client.first(read)).rejects.toMatchObject({
      code: "db.unavailable",
      failure: "timeout",
    });
    expect(calls).toHaveLength(2);
  });

  it("honors caller aborts", async () => {
    const { client, replies } = setup();
    const controller = new AbortController();
    replies.push((init) => {
      queueMicrotask(() => controller.abort());
      return hangUntilAborted(init);
    });
    await expect(client.first(read, { signal: controller.signal })).rejects.toMatchObject({
      code: "db.aborted",
    });
    const aborted = new AbortController();
    aborted.abort();
    await expect(client.run(write, { signal: aborted.signal })).rejects.toMatchObject({
      code: "db.aborted",
    });
  });

  it("reports a write aborted after its lane grant but before sending as aborted, not unknown", async () => {
    const controller = new AbortController();
    class AbortingLane extends RateLane {
      override async acquire(): Promise<{ waitedMs: number }> {
        // The caller gives up in the same turn the token is granted.
        controller.abort();
        return { waitedMs: 0 };
      }
    }
    const { client, calls } = setup({
      lane: new AbortingLane({ name: "api", ratePerSecond: 1, burst: 1, maxWaitMs: 1_000 }),
    });
    const error = await client
      .run(write, { signal: controller.signal })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "db.aborted" });
    expect(error).not.toBeInstanceOf(DbUnknownOutcomeError);
    expect(calls).toHaveLength(0);
    expect(client.counters.snapshot().outcomes).toMatchObject({ aborted: 1, unknown_outcome: 0 });
  });
});

describe("D1RestClient rate limiting (§3.1)", () => {
  it("opens the process circuit on 429 for Retry-After and fails fast without sending", async () => {
    const { client, clock, circuit, replies, calls } = setup();
    replies.push(new Response("{}", { status: 429, headers: { "Retry-After": "60" } }));
    const error = await client.first(read).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DbRateLimitedError);
    expect(error).toMatchObject({ code: "rate.limited", reason: "http_429", retryAfterMs: 60_000 });
    expect(calls).toHaveLength(1);

    await expect(client.first(read)).rejects.toMatchObject({
      reason: "circuit_open",
      retryAfterMs: 60_000,
    });
    await expect(client.run(write)).rejects.toMatchObject({ reason: "circuit_open" });
    expect(calls).toHaveLength(1);
    expect(circuit.state().open).toBe(true);

    await clock.advance(60_000);
    replies.push(envelope([rows()]));
    await expect(client.first(read)).resolves.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("shares the circuit between clients in the process", async () => {
    const first = setup();
    const second = new D1RestClient({
      accountId: FAKE_D1_ACCOUNT_ID,
      databaseId: FAKE_D1_DATABASE_ID,
      apiToken: FAKE_D1_API_TOKEN,
      lane: first.lane,
      circuit: first.circuit,
      clock: first.clock,
      fetch: async () => {
        throw new Error("must not send");
      },
    });
    first.replies.push(new Response("{}", { status: 429 }));
    await expect(first.client.first(read)).rejects.toMatchObject({ retryAfterMs: 300_000 });
    await expect(second.first(read)).rejects.toMatchObject({ reason: "circuit_open" });
  });

  it("opens the circuit before a breach when Ratelimit reports the budget exhausted", async () => {
    const { client, replies, calls } = setup();
    replies.push(
      envelope([rows()], {
        Ratelimit: '"default";r=3;t=40',
        "Ratelimit-Policy": '"default";q=1200;w=300',
      }),
    );
    await expect(client.first(read)).resolves.toBeNull();
    await expect(client.first(read)).rejects.toMatchObject({
      reason: "circuit_open",
      retryAfterMs: 40_000,
    });
    expect(calls).toHaveLength(1);
    expect(client.counters.snapshot()).toMatchObject({ ratelimitRemainingMin: 3, circuitOpen: 1 });
  });

  it("sheds unauthenticated work on the api lane before sending", async () => {
    const clock = new ManualClock();
    const { client, replies, calls } = setup({
      lane: new RateLane({
        name: "api",
        ratePerSecond: 2,
        burst: 10,
        unauthenticatedShare: 0.3,
        maxWaitMs: 5_000,
        clock,
      }),
      clock,
    });
    for (let index = 0; index < 3; index += 1) replies.push(envelope([rows()]));
    for (let index = 0; index < 3; index += 1)
      await client.first(read, { priority: "unauthenticated" });
    await expect(client.first(read, { priority: "unauthenticated" })).rejects.toMatchObject({
      code: "rate.limited",
      reason: "shed",
    });
    expect(calls).toHaveLength(3);
    expect(client.counters.snapshot().outcomes.shed).toBe(1);
  });

  it("enforces D1 limits before acquiring a token or sending", async () => {
    const { client, calls } = setup();
    await expect(client.batch([{ sql: "SELECT 1; SELECT 2", params: [] }])).rejects.toMatchObject({
      code: "db.invalid_statement",
    });
    await expect(
      client.batch([{ sql: "DELETE FROM beta_admin_events", params: [] }]),
    ).rejects.toMatchObject({ code: "db.append_only" });
    await expect(client.executeScript("  -- nothing  ")).rejects.toMatchObject({
      code: "db.limit_exceeded",
    });
    expect(calls).toHaveLength(0);
    expect(client.counters.snapshot().outcomes.invalid).toBe(3);
  });
});

describe("D1RestClient counters (§3.1)", () => {
  afterEach(() => vi.useRealTimers());

  it("emits per-minute snapshots with numbers and fixed ids only", async () => {
    const marker = "secret-marker-7f3a";
    const { client, replies } = setup({ runtime: "worker" });
    replies.push(envelope([rows({ id: marker })], { Ratelimit: '"default";r=900;t=100' }));
    await client.first(sql("SELECT :marker AS id", { marker }));
    replies.push(failure(400, `UNIQUE constraint failed: ${marker}`));
    await client.run(sql("INSERT INTO t VALUES (:marker)", { marker })).catch(() => undefined);

    vi.useFakeTimers();
    const emitted: unknown[] = [];
    const stop = client.counters.start((snapshot) => emitted.push(snapshot));
    vi.advanceTimersByTime(60_000);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(emitted).toHaveLength(1);
    const snapshot = emitted[0] as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      metric: "d1.requests",
      runtime: "worker",
      lane: "api",
      requestsSent: 2,
      http429: 0,
      readRetries: 0,
      circuitOpen: 0,
      ratelimitRemainingMin: 900,
      outcomes: { ok: 1, statement_failed: 1 },
    });
    expect(Object.keys((snapshot.outcomes as object) ?? {}).sort()).toEqual([...d1Outcomes].sort());
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain(marker);
    expect(text).not.toContain(FAKE_D1_API_TOKEN);
    expect(text).not.toContain("SELECT");
    for (const [key, value] of Object.entries(snapshot)) {
      if (["metric", "runtime", "lane"].includes(key)) continue;
      if (key === "outcomes") {
        expect(Object.values(value as object).every((count) => typeof count === "number")).toBe(
          true,
        );
        continue;
      }
      expect(typeof value).toBe("number");
    }
    // A snapshot starts a new window.
    expect(client.counters.snapshot()).toMatchObject({
      requestsSent: 0,
      ratelimitRemainingMin: -1,
    });
  });

  it("never exposes the token through errors", async () => {
    const { client, replies } = setup();
    replies.push(failure(401, "Authentication error"));
    const error = (await client.first(read).catch((caught: unknown) => caught)) as DbError;
    expect(JSON.stringify([error.message, error.stack, { ...error }])).not.toContain(
      FAKE_D1_API_TOKEN,
    );
  });

  it("never exposes the token when the client itself is serialized or inspected", () => {
    const { client } = setup();
    expect(JSON.stringify(client)).not.toContain(FAKE_D1_API_TOKEN);
    expect(inspect(client, { depth: 10, showHidden: true })).not.toContain(FAKE_D1_API_TOKEN);
    expect(Object.values(client).some((value) => String(value).includes(FAKE_D1_API_TOKEN))).toBe(
      false,
    );
  });
});

describeDbClientContract("REST client over the fake D1 API", async () => {
  const database = createLocalSqliteClient({ path: ":memory:", env: {} });
  const api = new FakeD1Api({ database });
  const observed = observingFetch(api.fetch);
  const client = new D1RestClient({
    accountId: FAKE_D1_ACCOUNT_ID,
    databaseId: FAKE_D1_DATABASE_ID,
    apiToken: FAKE_D1_API_TOKEN,
    lane: new RateLane({ name: "api", ratePerSecond: 1_000, burst: 1_000, maxWaitMs: 1_000 }),
    circuit: new D1CircuitBreaker(),
    fetch: observed.fetch,
  });
  return { client, responses: observed.responses, close: () => database.close() };
});

describe("raw param probe over the fake D1 API", () => {
  const database = createLocalSqliteClient({ path: ":memory:", env: {} });
  const api = new FakeD1Api({ database });
  afterAll(() => database.close());
  describeRawD1ParamTypes("fake D1 API (the local stand-in rejects non-string params)", {
    url: `https://api.cloudflare.com/client/v4/accounts/${FAKE_D1_ACCOUNT_ID}/d1/database/${FAKE_D1_DATABASE_ID}/query`,
    apiToken: FAKE_D1_API_TOKEN,
    fetch: api.fetch,
  });
});
