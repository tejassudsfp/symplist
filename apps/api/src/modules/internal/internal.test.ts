import {
  INTERNAL_CONTENT_TYPE,
  INTERNAL_EVENTS_PATH,
  type InternalEventHandler,
} from "@symplist/core/events";
import { computeInternalSignature, signInternalRequest } from "@symplist/crypto";
import {
  applyMigrations,
  createLocalSqliteClient,
  type LocalSqliteClient,
  newWriteId,
  sql,
  uuidv7,
} from "@symplist/db";
import { FakeClock } from "@symplist/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootTestApp, generatedSecret, type TestApp } from "../../../test/harness.ts";
import { buildRouteClassRegistry, collectRoutes } from "../../common/route-registry.ts";
import { InternalEventHandlerRegistry } from "./internal-event-handlers.ts";
import { InternalEventsController } from "./internal-events.controller.ts";
import { EventIdMemory } from "./replay-memory.ts";
import { recordWebhookDelivery, webhookReceiptBatch } from "./webhook-receipts.ts";

/* ------------------------------------------------------------------------------------------------
 * Fixtures
 * --------------------------------------------------------------------------------------------- */

const MARKER = "MARKER-2b91-internal-event-plaintext";
interface Harness {
  readonly app: TestApp;
  readonly base: string;
  readonly clock: FakeClock;
  readonly handlers: InternalEventHandlerRegistry;
  /** `INTERNAL_EVENT_SECRET_1`, still configured beside the current version 2. */
  readonly previousSecret: string;
  /** Log lines of the platform logger, one JSON object per line. */
  logLines(): string[];
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.app.close();
});

/** The platform with two internal secret versions (current 2). */
async function start(tuning: { readonly replayMemoryCapacity?: number } = {}): Promise<Harness> {
  const previousSecret = generatedSecret();
  const app = await bootTestApp({
    env: {
      INTERNAL_EVENT_SECRET_1: previousSecret,
      INTERNAL_EVENT_SECRET_2: generatedSecret(),
      INTERNAL_EVENT_SECRET_CURRENT: "2",
    },
    runtime: { internal: { tuning } },
  });
  const harness: Harness = {
    app,
    base: app.baseUrl,
    clock: app.clock,
    handlers: app.inject(InternalEventHandlerRegistry),
    previousSecret,
    logLines: () => app.logs.lines,
  };
  harnesses.push(harness);
  return harness;
}

interface SignedRequest {
  readonly path: string;
  readonly body: Buffer;
  readonly headers: Record<string, string>;
}

function signed(
  h: Harness,
  path: string,
  body: unknown,
  options: { eventId?: string; timestamp?: number; bodyOverride?: Buffer } = {},
): SignedRequest {
  const raw = options.bodyOverride ?? Buffer.from(JSON.stringify(body));
  const headers = signInternalRequest(h.app.keys, {
    timestamp: options.timestamp ?? Math.floor(h.clock.now() / 1000),
    eventId: options.eventId ?? uuidv7(),
    method: "POST",
    path,
    body: raw,
  });
  return { path, body: raw, headers: { ...headers, "content-type": INTERNAL_CONTENT_TYPE } };
}

async function send(h: Harness, request: SignedRequest, extra: Record<string, string> = {}) {
  const response = await fetch(`${h.base}${request.path}`, {
    method: "POST",
    headers: { ...request.headers, ...extra },
    body: new Uint8Array(request.body),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Internal events
 * --------------------------------------------------------------------------------------------- */

describe("POST /internal/v1/events (§6.2)", () => {
  let h: Harness;
  let handled: InternalEventHandler["handle"] & ReturnType<typeof vi.fn>;
  const owner = "01996d2a-4c00-7000-8000-00000000c0de";

  const event = (overrides: Record<string, unknown> = {}) => ({
    id: uuidv7(),
    type: "tasks.changed",
    ownerId: owner,
    occurredAt: 1_789_466_400_000,
    payload: { taskIds: [uuidv7()], taskTreeVersion: 4 },
    ...overrides,
  });

  beforeEach(async () => {
    h = await start();
    handled = vi.fn(async () => undefined) as never;
    h.handlers.register({ type: "tasks.changed", handle: handled });
  });

  it("declares the signed route class for the internal events route and skips IP throttling", () => {
    const registry = buildRouteClassRegistry(collectRoutes(h.app.app));
    expect(registry["POST /internal/v1/events"]).toBe("signed");
    expect(Reflect.getMetadata("THROTTLER:SKIPdefault", InternalEventsController)).toBe(true);
  });

  it("dispatches a valid signed event to its handler without the v1 prefix, cookies or CORS", async () => {
    const body = event();
    const request = signed(h, INTERNAL_EVENTS_PATH, body, { eventId: body.id });
    const response = await send(h, request, {
      cookie: "sym_session=abc",
      origin: "http://localhost:3000",
    });
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: "accepted" });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(handled).toHaveBeenCalledWith(body);
    expect((await fetch(`${h.base}/v1${INTERNAL_EVENTS_PATH}`, { method: "POST" })).status).toBe(
      404,
    );
  });

  it("rejects a forged signature, a tampered body and a secret that is not the internal secret", async () => {
    const body = event();
    const valid = signed(h, INTERNAL_EVENTS_PATH, body, { eventId: body.id });
    const forgedKey = Buffer.alloc(32, 99);
    const forged = {
      ...valid,
      headers: {
        ...valid.headers,
        "x-sym-signature": computeInternalSignature(forgedKey, {
          timestamp: Number(valid.headers["x-sym-timestamp"]),
          eventId: body.id,
          method: "POST",
          path: INTERNAL_EVENTS_PATH,
          body: valid.body,
        }),
      },
    };
    const tampered = {
      ...valid,
      body: Buffer.from(JSON.stringify({ ...body, ownerId: uuidv7() })),
    };
    for (const request of [forged, tampered]) {
      const response = await send(h, request);
      expect(response.status).toBe(404);
      expect((response.body.error as { code: string }).code).toBe("not_found");
    }
    expect(handled).not.toHaveBeenCalled();
    expect(h.logLines().filter((line) => line.includes("invalid_signature"))).toHaveLength(2);
  });

  it("rejects stale timestamps outside ±300 seconds", async () => {
    const now = Math.floor(h.clock.now() / 1000);
    for (const timestamp of [now - 301, now + 301]) {
      const body = event();
      expect(
        (await send(h, signed(h, INTERNAL_EVENTS_PATH, body, { eventId: body.id, timestamp })))
          .status,
      ).toBe(404);
    }
    const body = event();
    expect(
      (
        await send(
          h,
          signed(h, INTERNAL_EVENTS_PATH, body, { eventId: body.id, timestamp: now - 300 }),
        )
      ).status,
    ).toBe(202);
    expect(h.logLines().filter((line) => line.includes('"reason":"stale"'))).toHaveLength(2);
  });

  it("answers a replayed event id as a completed duplicate for 10 minutes, even with a fresh signature", async () => {
    const body = event();
    const request = signed(h, INTERNAL_EVENTS_PATH, body, { eventId: body.id });
    expect((await send(h, request)).status).toBe(202);
    expect(await send(h, request)).toMatchObject({ status: 200, body: { status: "duplicate" } });
    await h.clock.advance(60_000);
    expect(
      (await send(h, signed(h, INTERNAL_EVENTS_PATH, body, { eventId: body.id }))).status,
    ).toBe(200);
    expect(handled).toHaveBeenCalledTimes(1);
    expect(h.logLines().filter((line) => line.includes('"reason":"replayed"'))).toHaveLength(2);
  });

  it("answers 409 while an earlier try is still being handled, so a handler failure is never taken for delivery", async () => {
    let fail: (error: unknown) => void = () => undefined;
    handled.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const body = event();
    const request = signed(h, INTERNAL_EVENTS_PATH, body, { eventId: body.id });
    // The first try is still running its handler when the worker gives up on it and retries.
    const first = send(h, request);
    await vi.waitFor(() => expect(handled).toHaveBeenCalledTimes(1));
    const inProgress = await send(h, request);
    expect(inProgress.status).toBe(409);
    expect((inProgress.body.error as { code: string }).code).toBe("idempotency.in_progress");

    // The handler fails afterwards: the id is forgotten and the next identical try runs it again.
    fail(Object.assign(new Error("D1 unavailable"), { code: "db.unavailable" }));
    expect((await first).status).toBe(500);
    expect((await send(h, request)).status).toBe(202);
    expect(handled).toHaveBeenCalledTimes(2);
    expect(await send(h, request)).toMatchObject({ status: 200, body: { status: "duplicate" } });
    expect(handled).toHaveBeenCalledTimes(2);
  });

  it("forgets the id of a request refused before any handler ran, so an identical retry gets the same answer", async () => {
    const unhandled = event({ type: "notifications.created" });
    const request = signed(h, INTERNAL_EVENTS_PATH, unhandled, { eventId: unhandled.id });
    expect((await send(h, request)).status).toBe(400);
    expect((await send(h, request)).status).toBe(400);
    expect(handled).not.toHaveBeenCalled();
  });

  it("remembers an event id until its signature leaves the window, even when signed ahead of the api clock", async () => {
    const now = Math.floor(h.clock.now() / 1000);
    const body = event();
    const request = signed(h, INTERNAL_EVENTS_PATH, body, {
      eventId: body.id,
      timestamp: now + 300,
    });
    expect((await send(h, request)).status).toBe(202);
    // Ten minutes later the timestamp is exactly 300 seconds old, so the signature is still fresh.
    await h.clock.advance(600_000);
    expect((await send(h, request)).status).toBe(200);
    await h.clock.advance(999);
    expect((await send(h, request)).status).toBe(200);
    await h.clock.advance(1);
    expect((await send(h, request)).status).toBe(404);
    expect(handled).toHaveBeenCalledTimes(1);
    expect(h.logLines().filter((line) => line.includes('"reason":"replayed"'))).toHaveLength(2);
    expect(h.logLines().filter((line) => line.includes('"reason":"stale"'))).toHaveLength(1);
  });

  it("rejects a key version that is not configured and accepts the previous configured version", async () => {
    const body = event();
    const request = signed(h, INTERNAL_EVENTS_PATH, body, { eventId: body.id });
    const unknown = { ...request, headers: { ...request.headers, "x-sym-key": "3" } };
    expect((await send(h, unknown)).status).toBe(404);
    const v1 = {
      ...request,
      headers: {
        ...request.headers,
        "x-sym-key": "1",
        "x-sym-signature": computeInternalSignature(Buffer.from(h.previousSecret, "base64url"), {
          timestamp: Number(request.headers["x-sym-timestamp"]),
          eventId: body.id,
          method: "POST",
          path: INTERNAL_EVENTS_PATH,
          body: request.body,
        }),
      },
    };
    expect((await send(h, v1)).status).toBe(202);
  });

  it("validates media type, body shape, ids-only payloads, the event id binding and the handler type", async () => {
    const body = event();
    const wrongType = signed(h, INTERNAL_EVENTS_PATH, body, { eventId: body.id });
    expect((await send(h, wrongType, { "content-type": "application/json" })).status).toBe(400);

    const freeText = event({ payload: { note: `hello ${MARKER}` } });
    expect(
      (await send(h, signed(h, INTERNAL_EVENTS_PATH, freeText, { eventId: freeText.id }))).status,
    ).toBe(400);

    const mismatched = event();
    expect(
      (await send(h, signed(h, INTERNAL_EVENTS_PATH, mismatched, { eventId: uuidv7() }))).status,
    ).toBe(400);

    const unhandled = event({ type: "notifications.created" });
    expect(
      (await send(h, signed(h, INTERNAL_EVENTS_PATH, unhandled, { eventId: unhandled.id }))).status,
    ).toBe(400);

    const notJson = signed(h, INTERNAL_EVENTS_PATH, null, { bodyOverride: Buffer.from("{nope") });
    expect((await send(h, notJson)).status).toBe(400);

    const huge = signed(h, INTERNAL_EVENTS_PATH, null, { bodyOverride: Buffer.alloc(70_000, 97) });
    expect((await send(h, huge)).status).toBe(413);
    expect(handled).not.toHaveBeenCalled();
    expect(h.logLines().join("\n")).not.toContain(MARKER);
  });

  it("returns 500 when a handler fails and accepts a retry of the same signed request", async () => {
    handled.mockRejectedValueOnce(
      Object.assign(new Error(`db down ${MARKER}`), { code: "db.unavailable" }),
    );
    const body = event();
    const request = signed(h, INTERNAL_EVENTS_PATH, body, { eventId: body.id });
    const failed = await send(h, request);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.body)).not.toContain(MARKER);
    expect((await send(h, request)).status).toBe(202);
    expect(handled).toHaveBeenCalledTimes(2);
    expect(h.logLines().join("\n")).not.toContain(MARKER);
  });
});

describe("event id replay memory", () => {
  it("tells an id in progress from a completed one, expires ids after 10 minutes and fails closed when full", async () => {
    const clock = new FakeClock(0);
    const memory = new EventIdMemory(clock, { capacity: 2 });
    expect(memory.reserve("a")).toBe("reserved");
    expect(memory.reserve("a")).toBe("in_progress");
    memory.complete("a");
    expect(memory.reserve("a")).toBe("completed");
    expect(memory.reserve("b")).toBe("reserved");
    expect(memory.reserve("c")).toBe("full");
    await clock.advance(600_000);
    expect(memory.reserve("a")).toBe("reserved");
    memory.release("a");
    expect(memory.reserve("a")).toBe("reserved");
    // Completing an id that was released or never reserved remembers nothing.
    memory.release("a");
    memory.complete("a");
    expect(memory.reserve("a")).toBe("reserved");
  });

  it("keeps an id until the end of its signature window when that is later than 10 minutes", async () => {
    const clock = new FakeClock(0);
    const memory = new EventIdMemory(clock);
    expect(memory.reserve("early", 601_000)).toBe("reserved");
    memory.complete("early");
    await clock.advance(600_000);
    expect(memory.reserve("early", 601_000)).toBe("completed");
    await clock.advance(1_000);
    expect(memory.reserve("early", 1_201_000)).toBe("reserved");
  });
});

/* ------------------------------------------------------------------------------------------------
 * Webhook receipts
 * --------------------------------------------------------------------------------------------- */

describe("webhook receipts (§6.2)", () => {
  let db: LocalSqliteClient;
  const userId = uuidv7();

  beforeEach(async () => {
    db = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
    await applyMigrations(db);
    await db.run(
      sql(
        `INSERT INTO users (id, email, created_at, updated_at, write_id) VALUES (:id, 'w@example.com', '0', '0', :w)`,
        {
          id: userId,
          w: newWriteId(),
        },
      ),
    );
  });
  afterEach(() => db.close());

  const delivery = (receiptId: string) => ({
    provider: "resend" as const,
    receiptId,
    eventType: "email.bounced",
    receivedAt: 5,
    effects: (guard: { notReceived: string; params: Readonly<Record<string, string>> }) => [
      sql(`UPDATE users SET updated_at = updated_at + 1 WHERE id = :id AND ${guard.notReceived}`, {
        id: userId,
        ...guard.params,
      }),
    ],
  });

  it("applies the effect and records the receipt in one batch, exactly once per provider and id", async () => {
    const first = await recordWebhookDelivery(db, delivery("msg_1"));
    const second = await recordWebhookDelivery(db, delivery("msg_1"));
    const other = await recordWebhookDelivery(db, delivery("msg_2"));
    expect([first.duplicate, second.duplicate, other.duplicate]).toEqual([false, true, false]);
    expect(
      await db.first(sql("SELECT updated_at FROM users WHERE id = :id", { id: userId })),
    ).toEqual({ updated_at: 2 });
    expect(
      await db.all(
        sql("SELECT provider, receipt_id, event_type FROM webhook_receipts ORDER BY receipt_id"),
      ),
    ).toEqual([
      { provider: "resend", receipt_id: "msg_1", event_type: "email.bounced" },
      { provider: "resend", receipt_id: "msg_2", event_type: "email.bounced" },
    ]);
    const composio = await recordWebhookDelivery(db, {
      ...delivery("msg_1"),
      provider: "composio",
    });
    expect(composio.duplicate).toBe(false);
  });

  it("refuses effects without the receipt guard and malformed receipt ids", () => {
    expect(() =>
      webhookReceiptBatch({
        ...delivery("msg_3"),
        effects: () => [sql("UPDATE users SET updated_at = 1 WHERE id = :id", { id: userId })],
      }),
    ).toThrow(/receipt guard/);
    expect(() => webhookReceiptBatch(delivery(""))).toThrow();
    expect(() => webhookReceiptBatch(delivery("bad id with spaces"))).toThrow();
  });
});
