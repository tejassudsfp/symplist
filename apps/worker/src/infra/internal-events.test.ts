import {
  INTERNAL_CONTENT_TYPE,
  INTERNAL_EVENTS_PATH,
  internalEventBodySchema,
} from "@symplist/core/events";
import { createKeyProvider, verifyInternalRequest } from "@symplist/crypto";
import { uuidv7 } from "@symplist/db";
import { FakeClock, FakeTriggerClient } from "@symplist/testing";
import { describe, expect, it } from "vitest";
import { InternalEventClient } from "./internal-events.ts";
import { createWorkerLogger } from "./logger.ts";
import type { WorkerFetch } from "./signed-request.ts";

const API = "https://api.example.com";
const MARKER = "MARKER-90d2-internal-event";

const keys = createKeyProvider({
  INTERNAL_EVENT_SECRET: {
    current: 1,
    versions: new Map([[1, Buffer.alloc(32, 7).toString("base64url")]]),
  },
  CONTENT_KEK: { current: 1, versions: new Map([[1, Buffer.alloc(32, 9).toString("base64url")]]) },
});

interface Received {
  readonly path: string;
  readonly verified: boolean;
  readonly body: string;
  readonly eventId: string | undefined;
  readonly contentType: string | undefined;
}

/** A fake api: verifies each signature like the api does and answers from a script. */
function fakeApi(clock: FakeClock, script: (index: number) => number | "network" = () => 202) {
  const received: Received[] = [];
  const fetchImpl: WorkerFetch = async (url, init) => {
    const index = received.length;
    const headers = init.headers as Record<string, string>;
    const body = Buffer.from(init.body as Uint8Array);
    const path = url.slice(API.length);
    const verification = verifyInternalRequest(
      keys,
      {
        timestamp: headers["x-sym-timestamp"],
        eventId: headers["x-sym-event-id"],
        keyVersion: headers["x-sym-key"],
        signature: headers["x-sym-signature"],
        method: String(init.method),
        path,
        body,
      },
      { nowMs: clock.now() },
    );
    received.push({
      path,
      verified: verification.ok,
      body: body.toString("utf8"),
      eventId: headers["x-sym-event-id"],
      contentType: headers["content-type"],
    });
    const outcome = script(index);
    if (outcome === "network") throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ status: "ok" }), { status: outcome });
  };
  return { received, fetchImpl };
}

describe("internal event client (§6.2)", () => {
  it("signs an ids-only event and retries the identical request", async () => {
    const clock = new FakeClock(Date.UTC(2026, 8, 15, 12));
    const trigger = new FakeTriggerClient({ clock });
    const api = fakeApi(clock, (index) => (index === 0 ? 502 : 202));
    const events = new InternalEventClient({
      keys,
      apiOrigin: API,
      logger: createWorkerLogger(trigger.logger),
      fetch: api.fetchImpl,
      timers: clock,
    });
    const ownerId = uuidv7();
    const notificationId = uuidv7();
    const announcing = events.announce({
      type: "notifications.created",
      ownerId,
      payload: { notificationId },
    });
    await clock.advance(1_000);
    expect(await announcing).toBe("delivered");
    expect(api.received).toHaveLength(2);
    expect(api.received[0]?.body).toBe(api.received[1]?.body);
    expect(api.received[0]?.eventId).toBe(api.received[1]?.eventId);
    expect(
      api.received.every(
        (entry) =>
          entry.verified &&
          entry.path === INTERNAL_EVENTS_PATH &&
          entry.contentType === INTERNAL_CONTENT_TYPE,
      ),
    ).toBe(true);
    const body = internalEventBodySchema.parse(JSON.parse(api.received[0]?.body ?? ""));
    expect(body).toMatchObject({
      id: api.received[0]?.eventId,
      type: "notifications.created",
      ownerId,
      payload: { notificationId },
    });
  });

  it("reports the api's completed replay (200) to a retry after a lost response as delivered", async () => {
    const clock = new FakeClock(Date.UTC(2026, 8, 15, 12));
    const trigger = new FakeTriggerClient({ clock });
    // The first try reaches the api and takes effect, but the connection drops before the response.
    const api = fakeApi(clock, (index) => (index === 0 ? "network" : 200));
    const events = new InternalEventClient({
      keys,
      apiOrigin: API,
      logger: createWorkerLogger(trigger.logger),
      fetch: api.fetchImpl,
      timers: clock,
    });
    const announcing = events.announce({
      type: "tasks.changed",
      ownerId: uuidv7(),
      payload: { count: 1 },
    });
    await clock.advance(1_000);
    expect(await announcing).toBe("delivered");
    expect(api.received).toHaveLength(2);
    expect(api.received[0]?.eventId).toBe(api.received[1]?.eventId);
  });

  it("keeps retrying while the api reports an earlier try in progress, until the handler's outcome is known", async () => {
    const clock = new FakeClock(Date.UTC(2026, 8, 15, 12));
    const trigger = new FakeTriggerClient({ clock });
    // Try 1 times out while its handler runs; try 2 finds it in progress (409); the handler then
    // fails and the api forgets the id, so try 3 runs the handler again and it succeeds.
    const api = fakeApi(clock, (index) => (index === 0 ? "network" : index === 1 ? 409 : 202));
    const events = new InternalEventClient({
      keys,
      apiOrigin: API,
      logger: createWorkerLogger(trigger.logger),
      fetch: api.fetchImpl,
      timers: clock,
    });
    const announcing = events.announce({
      type: "tasks.changed",
      ownerId: uuidv7(),
      payload: { count: 1 },
    });
    await clock.advance(2_000);
    expect(await announcing).toBe("delivered");
    expect(api.received).toHaveLength(3);
    expect(new Set(api.received.map((entry) => entry.eventId)).size).toBe(1);
  });

  it("never counts a 404 or a try still in progress as delivered", async () => {
    const clock = new FakeClock(Date.UTC(2026, 8, 15, 12));
    const trigger = new FakeTriggerClient({ clock });
    const logger = createWorkerLogger(trigger.logger);
    const rejectedApi = fakeApi(clock, (index) => (index === 0 ? "network" : 404));
    const rejecting = new InternalEventClient({
      keys,
      apiOrigin: API,
      logger,
      fetch: rejectedApi.fetchImpl,
      timers: clock,
    });
    const first = rejecting.announce({ type: "tasks.changed", ownerId: uuidv7(), payload: {} });
    await clock.advance(1_000);
    expect(await first).toBe("rejected");

    const busyApi = fakeApi(clock, (index) => (index === 0 ? "network" : 409));
    const waiting = new InternalEventClient({
      keys,
      apiOrigin: API,
      logger,
      fetch: busyApi.fetchImpl,
      timers: clock,
    });
    const second = waiting.announce({ type: "tasks.changed", ownerId: uuidv7(), payload: {} });
    await clock.advance(5_000);
    expect(await second).toBe("unconfirmed");
    expect(busyApi.received).toHaveLength(3);
  });

  it("refuses payloads with content before anything is sent, and reports rejections", async () => {
    const clock = new FakeClock();
    const trigger = new FakeTriggerClient({ clock });
    const api = fakeApi(clock, () => 404);
    const events = new InternalEventClient({
      keys,
      apiOrigin: API,
      logger: createWorkerLogger(trigger.logger),
      fetch: api.fetchImpl,
      timers: clock,
    });
    await expect(
      events.announce({
        type: "tasks.changed",
        ownerId: uuidv7(),
        payload: { title: `Draft for ${MARKER} review` },
      }),
    ).rejects.toMatchObject({ code: "internal_event.invalid" });
    expect(api.received).toHaveLength(0);
    expect(
      await events.announce({ type: "tasks.changed", ownerId: uuidv7(), payload: { count: 1 } }),
    ).toBe("rejected");
    expect(trigger.findMarker(MARKER)).toEqual([]);
  });
});
