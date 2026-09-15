import {
  INTERNAL_CONTENT_TYPE,
  INTERNAL_EVENTS_PATH,
  internalEventBodySchema,
  runOutputBodySchema,
  runOutputPath,
} from "@symplist/core/events";
import {
  type AccountDataKey,
  createAccountKey,
  createKeyProvider,
  decryptFieldText,
  runChunkContext,
  verifyInternalRequest,
} from "@symplist/crypto";
import { uuidv7 } from "@symplist/db";
import { FakeClock, FakeTriggerClient } from "@symplist/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { InternalEventClient } from "./internal-events.ts";
import { createWorkerLogger } from "./logger.ts";
import { MAX_RUN_CHUNK_BYTES, RunOutputPushClient } from "./run-output.ts";
import type { WorkerFetch } from "./signed-request.ts";

const API = "https://api.example.com";
const MARKER = "MARKER-90d2-streamed-text";

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

describe("run output push client (§8.2)", () => {
  let clock: FakeClock;
  let trigger: FakeTriggerClient;
  let owner: string;
  let runId: string;
  let accountKey: AccountDataKey;

  beforeEach(() => {
    clock = new FakeClock(Date.UTC(2026, 8, 15, 12));
    trigger = new FakeTriggerClient({ clock });
    owner = uuidv7();
    runId = uuidv7();
    accountKey = createAccountKey(keys, owner).key;
  });

  function client(
    fetchImpl: WorkerFetch,
    overrides: Partial<ConstructorParameters<typeof RunOutputPushClient>[0]> = {},
  ) {
    return new RunOutputPushClient({
      runId,
      ownerId: owner,
      attempt: 1,
      accountKey,
      keys,
      apiOrigin: API,
      logger: createWorkerLogger(trigger.logger),
      fetch: fetchImpl,
      timers: clock,
      ...overrides,
    });
  }

  function decrypt(received: Received) {
    const body = runOutputBodySchema.parse(JSON.parse(received.body));
    return {
      seq: body.seq,
      chunks: JSON.parse(
        decryptFieldText(accountKey, runChunkContext(owner, body.runId, body.seq), body.envelope),
      ),
    };
  }

  it("flushes after 100 ms with signed, encrypted run_chunk envelopes and a monotonic seq", async () => {
    const api = fakeApi(clock);
    const sink = client(api.fetchImpl);
    sink.write({ type: "text-start", id: "t" });
    sink.write({ type: "text-delta", id: "t", delta: MARKER });
    await clock.advance(99);
    expect(api.received).toHaveLength(0);
    await clock.advance(1);
    await sink.flush();
    sink.write({ type: "text-delta", id: "t", delta: "second" });
    await clock.advance(100);
    const stats = await sink.close();

    expect(api.received.map((entry) => [entry.path, entry.verified, entry.contentType])).toEqual([
      [runOutputPath(runId), true, INTERNAL_CONTENT_TYPE],
      [runOutputPath(runId), true, INTERNAL_CONTENT_TYPE],
    ]);
    expect(api.received.map(decrypt)).toEqual([
      {
        seq: 0,
        chunks: [
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: MARKER },
        ],
      },
      { seq: 1, chunks: [{ type: "text-delta", id: "t", delta: "second" }] },
    ]);
    expect(api.received.every((entry) => !entry.body.includes(MARKER))).toBe(true);
    expect(stats).toEqual({ batchesSent: 2, batchesDropped: 0, chunksSent: 3, chunksDropped: 0 });
  });

  it("flushes immediately once 2 KB are buffered, keeping batches in order", async () => {
    const api = fakeApi(clock);
    const sink = client(api.fetchImpl);
    for (let index = 0; index < 5; index += 1)
      sink.write({ type: "text-delta", id: "t", delta: "x".repeat(600) });
    await sink.flush();
    expect(api.received.map(decrypt).map((batch) => [batch.seq, batch.chunks.length])).toEqual([
      [0, 4],
      [1, 1],
    ]);
  });

  it("retries a batch up to 3 times within 5 seconds with fresh signatures, then drops it and continues", async () => {
    const api = fakeApi(clock, (index) => (index < 3 ? (index === 1 ? "network" : 503) : 202));
    const sink = client(api.fetchImpl);
    sink.write({ type: "text-delta", id: "t", delta: MARKER });
    const flushing = sink.flush();
    await clock.advance(5_000);
    await flushing;
    expect(api.received).toHaveLength(3);
    expect(new Set(api.received.map((entry) => entry.eventId)).size).toBe(3);
    expect(api.received.every((entry) => entry.verified)).toBe(true);

    sink.write({ type: "text-delta", id: "t", delta: "after" });
    await sink.flush();
    expect(decrypt(api.received[3] as Received)).toMatchObject({ seq: 1 });
    expect(await sink.close()).toMatchObject({ batchesSent: 1, batchesDropped: 1 });
    expect(trigger.logs.some((log) => log.message === "run_output.retries_exhausted")).toBe(true);
    expect(trigger.findMarker(MARKER)).toEqual([]);
  });

  it("does not retry a rejected batch and drops refused or oversized chunks", async () => {
    const api = fakeApi(clock, () => 404);
    const sink = client(api.fetchImpl);
    sink.write({ type: "text-delta", id: "t", delta: MARKER });
    sink.write({ delta: MARKER } as never);
    sink.write({ type: "tool-output-available", output: "y".repeat(MAX_RUN_CHUNK_BYTES) });
    const stats = await sink.close();
    expect(api.received).toHaveLength(1);
    expect(stats).toEqual({ batchesSent: 0, batchesDropped: 1, chunksSent: 0, chunksDropped: 3 });
    sink.write({ type: "text-delta", id: "t", delta: "late" });
    expect(api.received).toHaveLength(1);
    expect(trigger.findMarker(MARKER)).toEqual([]);
  });

  it("counts a duplicate acknowledgement as delivered", async () => {
    const api = fakeApi(clock, () => 200);
    const sink = client(api.fetchImpl);
    sink.write({ type: "finish" });
    expect(await sink.close()).toMatchObject({ batchesSent: 1, batchesDropped: 0 });
  });
});

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
      api.received.every((entry) => entry.verified && entry.path === INTERNAL_EVENTS_PATH),
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
