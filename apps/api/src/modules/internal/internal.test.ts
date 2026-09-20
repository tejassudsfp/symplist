import type { ConversationId } from "@symplist/contracts";
import { conversationTopic } from "@symplist/contracts";
import type { AccountKeyStore } from "@symplist/core/account";
import {
  eventsContributors,
  INTERNAL_CONTENT_TYPE,
  INTERNAL_EVENTS_PATH,
  type InternalEventHandler,
  type RunLifecycleStatus,
  type RunRelaySource,
  runOutputPath,
} from "@symplist/core/events";
import {
  type AccountDataKey,
  computeInternalSignature,
  createAccountKey,
  createKeyProvider,
  encryptFieldText,
  generateToken,
  runChunkContext,
  signInternalRequest,
} from "@symplist/crypto";
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
import type { ExecutorStateReader } from "../../infra/executors/executor-state.ts";
import type { OperationalLog, OperationalLogFields } from "../../infra/scheduler/runtime.ts";
import { TopicHub } from "../realtime/topic-hub.ts";
import { TopicRegistry } from "../realtime/topic-registry.ts";
import { SimonTopics } from "../simon/simon.realtime.ts";
import { InternalEventHandlerRegistry } from "./internal-event-handlers.ts";
import { InternalEventsController } from "./internal-events.controller.ts";
import { EventIdMemory } from "./replay-memory.ts";
import { RunOutputController } from "./run-output.controller.ts";
import { RUN_OUTPUT_REPLAY_WINDOW_MS, RunOutputRelay } from "./run-output.relay.ts";
import { recordWebhookDelivery, webhookReceiptBatch } from "./webhook-receipts.ts";

/* ------------------------------------------------------------------------------------------------
 * Fixtures
 * --------------------------------------------------------------------------------------------- */

const MARKER = "MARKER-2b91-run-output-plaintext";
const secret = (seed: number) => Buffer.alloc(32, seed).toString("base64url");

class Log implements OperationalLog {
  readonly lines: string[] = [];
  info(event: string, fields?: OperationalLogFields) {
    this.lines.push(JSON.stringify({ event, ...fields }));
  }
  warn(event: string, fields?: OperationalLogFields) {
    this.lines.push(JSON.stringify({ event, ...fields }));
  }
  error(event: string, fields?: OperationalLogFields) {
    this.lines.push(JSON.stringify({ event, ...fields }));
  }
}

class FakeRuns implements RunRelaySource {
  readonly runs = new Map<
    string,
    { ownerId: string; conversationId: string; status: RunLifecycleStatus; generation: number }
  >();
  ownershipCalls = 0;
  stateCalls = 0;

  async ownership(runId: string) {
    this.ownershipCalls += 1;
    const run = this.runs.get(runId);
    return run ? { runId, ownerId: run.ownerId, conversationId: run.conversationId } : null;
  }

  async state(runId: string) {
    this.stateCalls += 1;
    const run = this.runs.get(runId);
    return run ? { status: run.status, executorGeneration: run.generation } : null;
  }
}

interface Harness {
  readonly app: TestApp;
  readonly base: string;
  readonly clock: FakeClock;
  readonly runs: FakeRuns;
  readonly hub: TopicHub;
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

/** The platform with two internal secret versions (current 2) and a probe run relay source. */
async function start(tuning: { readonly replayMemoryCapacity?: number } = {}): Promise<Harness> {
  const runs = new FakeRuns();
  const previousSecret = generatedSecret();
  const app = await bootTestApp({
    // This relay harness deliberately owns synthetic runs/conversations, not Simon's D1 records.
    overrides: [{ token: SimonTopics, value: { onModuleInit() {} } }],
    env: {
      INTERNAL_EVENT_SECRET_1: previousSecret,
      INTERNAL_EVENT_SECRET_2: generatedSecret(),
      INTERNAL_EVENT_SECRET_CURRENT: "2",
    },
    runtime: {
      eventsContributors: [
        {
          domain: "simon",
          executionKinds: eventsContributors
            .filter((contributor) => contributor.domain === "simon")
            .flatMap((contributor) => contributor.executionKinds),
          runRelaySource: () => runs,
        },
      ],
      internal: { tuning },
    },
  });
  const harness: Harness = {
    app,
    base: app.baseUrl,
    clock: app.clock,
    runs,
    hub: app.inject(TopicHub),
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

/** The current executor generation, which runs must carry for their output to be relayed. */
async function currentGeneration(h: Harness): Promise<number> {
  const row = await h.app.db.first<{ generation: number }>(
    sql("SELECT generation FROM executor_state WHERE id = 1"),
  );
  return Number(row?.generation);
}

async function addOwner(h: Harness): Promise<{ ownerId: string; key: AccountDataKey }> {
  const user = await h.app.createUser();
  return { ownerId: user.id, key: await h.app.accountKeys.require(user.id) };
}

function collect(h: Harness, ownerId: string) {
  const frames: Record<string, unknown>[] = [];
  const socket = h.hub.connect(
    { send: (text) => frames.push(JSON.parse(text)), close: () => undefined, isOpen: () => true },
    {
      userId: ownerId,
      sessionId: uuidv7(),
      access: {
        emailVerifiedAt: 1,
        betaState: "unlocked",
        suspendedAt: null,
        onboardingStep: "done",
        role: "member",
        accessGeneration: 0,
        accessEpoch: 0,
        deletionState: "none",
      },
    },
  );
  return { socket, frames };
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

  it("declares the signed route class for both internal routes in the platform registry and skips IP throttling", () => {
    const registry = buildRouteClassRegistry(collectRoutes(h.app.app));
    expect(registry["POST /internal/v1/events"]).toBe("signed");
    expect(registry["POST /internal/v1/runs/:runId/output"]).toBe("signed");
    for (const controller of [InternalEventsController, RunOutputController]) {
      expect(Reflect.getMetadata("THROTTLER:SKIPdefault", controller)).toBe(true);
    }
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
 * Run output
 * --------------------------------------------------------------------------------------------- */

describe("POST /internal/v1/runs/:runId/output (§8.2)", () => {
  let h: Harness;
  let owner: { ownerId: string; key: AccountDataKey };
  let runId: string;
  let conversationId: ConversationId;
  let generation: number;

  const chunks = (text: string) => [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
  ];

  function envelopeFor(
    key: AccountDataKey,
    ownerId: string,
    run: string,
    seq: number,
    content: unknown,
  ): string {
    return encryptFieldText(key, runChunkContext(ownerId, run, seq), JSON.stringify(content));
  }

  function output(
    seq: number,
    content: unknown = chunks(`${MARKER}-${seq}`),
    overrides: Record<string, unknown> = {},
    path = runOutputPath(runId),
  ) {
    const body = {
      runId,
      attempt: 1,
      seq,
      envelope: envelopeFor(owner.key, owner.ownerId, runId, seq, content),
      ...overrides,
    };
    return signed(h, path, body);
  }

  beforeEach(async () => {
    h = await start();
    owner = await addOwner(h);
    runId = uuidv7();
    conversationId = uuidv7() as ConversationId;
    generation = await currentGeneration(h);
    h.runs.runs.set(runId, {
      ownerId: owner.ownerId,
      conversationId,
      status: "running",
      generation,
    });
    h.app.inject<TopicRegistry>(TopicRegistry).registerAuthorizer({
      kind: "conversation",
      authorize: async (socket, topic) =>
        socket.userId === h.runs.runs.get(runId)?.ownerId &&
        topic.conversationId === conversationId,
    });
  });

  it("decrypts, relays each chunk on the conversation topic to the owner and buffers it for replay", async () => {
    const { socket, frames } = collect(h, owner.ownerId);
    await h.hub.subscribeConversation(socket, conversationTopic(conversationId), null);
    const intruder = collect(h, uuidv7());

    const response = await send(h, output(0));
    expect(response).toMatchObject({ status: 202, body: { status: "accepted", relayed: 2 } });
    const events = frames.filter((frame) => frame.t === "ev");
    expect(events.map((frame) => frame.type)).toEqual(["chunk", "chunk"]);
    expect(events[1]).toMatchObject({
      topic: conversationTopic(conversationId),
      data: { runId, chunk: { type: "text-delta", delta: `${MARKER}-0` } },
    });
    expect(intruder.frames).toEqual([]);

    const late = collect(h, owner.ownerId);
    const cursor = (events[0]?.seq as number) - 1;
    await h.hub.subscribeConversation(late.socket, conversationTopic(conversationId), cursor);
    expect(late.frames.map((frame) => frame.seq)).toEqual(events.map((frame) => frame.seq));
    expect(h.logLines().join("\n")).not.toContain(MARKER);
  });

  it("deduplicates on (runId, seq) even when the retry carries a new event id and signature", async () => {
    const { socket, frames } = collect(h, owner.ownerId);
    await h.hub.subscribeConversation(socket, conversationTopic(conversationId), null);
    expect((await send(h, output(5))).status).toBe(202);
    const retry = await send(h, output(5));
    expect(retry).toMatchObject({ status: 200, body: { status: "duplicate" } });
    expect((await send(h, output(6))).status).toBe(202);
    expect(frames.filter((frame) => frame.t === "ev")).toHaveLength(4);
  });

  it("caches ownership for the run's life and re-reads status and generation at most every 10 seconds", async () => {
    for (const seq of [0, 1, 2]) expect((await send(h, output(seq))).status).toBe(202);
    expect(h.runs.ownershipCalls).toBe(1);
    expect(h.runs.stateCalls).toBe(1);
    await h.clock.advance(10_000);
    expect((await send(h, output(3))).status).toBe(202);
    expect(h.runs.stateCalls).toBe(2);
    expect(h.runs.ownershipCalls).toBe(1);

    const run = h.runs.runs.get(runId);
    if (run) run.status = "completed";
    expect((await send(h, output(4))).status).toBe(202);
    await h.clock.advance(10_000);
    expect((await send(h, output(5))).status).toBe(404);
  });

  it("rejects output for a moved executor generation", async () => {
    await h.app.db.run(
      sql("UPDATE executor_state SET generation = generation + 1, write_id = :w WHERE id = 1", {
        w: newWriteId(),
      }),
    );
    await h.clock.advance(10_000);
    expect((await send(h, output(0))).status).toBe(404);
    expect(h.logLines().some((line) => line.includes("stale_generation"))).toBe(true);
  });

  it("answers 503 when the owner's account key cannot be loaded, and relays the identical retry", async () => {
    const { socket, frames } = collect(h, owner.ownerId);
    await h.hub.subscribeConversation(socket, conversationTopic(conversationId), null);
    const load = vi
      .spyOn(h.app.accountKeys, "load")
      .mockRejectedValueOnce(
        Object.assign(new Error(`D1 timed out ${MARKER}`), { code: "db.unavailable" }),
      );
    const request = output(0);
    const failed = await send(h, request);
    expect(failed.status).toBe(503);
    expect(failed.headers.get("retry-after")).toBe("1");
    expect((failed.body.error as { code: string }).code).toBe("rate.limited");
    expect(frames.filter((frame) => frame.t === "ev")).toEqual([]);

    // The worker retries the byte-identical request once D1 answers again.
    const retried = await send(h, request);
    expect(retried).toMatchObject({ status: 202, body: { status: "accepted", relayed: 2 } });
    expect(load).toHaveBeenCalledTimes(2);
    expect(frames.filter((frame) => frame.t === "ev")).toHaveLength(2);
    expect(h.logLines().some((line) => line.includes("undecryptable"))).toBe(false);
    expect(h.logLines().join("\n")).not.toContain(MARKER);
  });

  it("rejects the wrong run: a path that differs from the body, an unknown run, or another run's envelope", async () => {
    const other = uuidv7();
    const unknown = uuidv7();
    expect((await send(h, output(0, undefined, {}, runOutputPath(other)))).status).toBe(404);
    expect(
      (await send(h, output(0, undefined, { runId: unknown }, runOutputPath(unknown)))).status,
    ).toBe(404);

    // Another run of the same owner: the envelope's AAD binds the run id, so it cannot be moved.
    h.runs.runs.set(other, {
      ownerId: owner.ownerId,
      conversationId,
      status: "running",
      generation,
    });
    const moved = signed(h, runOutputPath(other), {
      runId: other,
      attempt: 1,
      seq: 0,
      envelope: envelopeFor(owner.key, owner.ownerId, runId, 0, chunks("x")),
    });
    expect((await send(h, moved)).status).toBe(400);
  });

  it("rejects envelopes that fail decryption: another seq, another owner's key, garbage plaintext", async () => {
    const { socket, frames } = collect(h, owner.ownerId);
    await h.hub.subscribeConversation(socket, conversationTopic(conversationId), null);
    const swappedSeq = signed(h, runOutputPath(runId), {
      runId,
      attempt: 1,
      seq: 2,
      envelope: envelopeFor(owner.key, owner.ownerId, runId, 1, chunks(MARKER)),
    });
    expect((await send(h, swappedSeq)).status).toBe(400);

    const stranger = await addOwner(h);
    const foreign = signed(h, runOutputPath(runId), {
      runId,
      attempt: 1,
      seq: 3,
      envelope: envelopeFor(stranger.key, stranger.ownerId, runId, 3, chunks(MARKER)),
    });
    expect((await send(h, foreign)).status).toBe(400);

    expect((await send(h, output(4, { not: "an array" }))).status).toBe(400);
    expect((await send(h, output(5, [{ delta: "missing type" }]))).status).toBe(400);
    expect(frames.filter((frame) => frame.t === "ev")).toEqual([]);
    // A rejected seq was not remembered: the genuine envelope for it is still relayed.
    expect((await send(h, output(2))).status).toBe(202);
    expect(h.logLines().join("\n")).not.toContain(MARKER);
  });

  it("rejects forged and stale output requests and wrong key versions, and relays a replay once", async () => {
    const { socket, frames } = collect(h, owner.ownerId);
    await h.hub.subscribeConversation(socket, conversationTopic(conversationId), null);
    const request = output(0);
    const forged = {
      ...request,
      headers: { ...request.headers, "x-sym-signature": `v1=${"0".repeat(64)}` },
    };
    expect((await send(h, forged)).status).toBe(404);
    const wrongVersion = { ...request, headers: { ...request.headers, "x-sym-key": "9" } };
    expect((await send(h, wrongVersion)).status).toBe(404);
    const stale = signed(h, runOutputPath(runId), JSON.parse(request.body.toString()), {
      timestamp: Math.floor(h.clock.now() / 1000) - 3_600,
    });
    expect((await send(h, stale)).status).toBe(404);
    expect((await send(h, request)).status).toBe(202);
    // A byte-identical replay meets its (runId, seq) and relays nothing, even long after the run
    // went quiet, for as long as its signature could still be fresh.
    await h.clock.advance(RUN_OUTPUT_REPLAY_WINDOW_MS - 1_000);
    const replayed = signed(h, runOutputPath(runId), JSON.parse(request.body.toString()), {
      timestamp: Math.floor(h.clock.now() / 1000),
    });
    expect(await send(h, replayed)).toMatchObject({ status: 200, body: { status: "duplicate" } });
    expect(frames.filter((frame) => frame.t === "ev")).toHaveLength(2);
  });

  it("keeps run output out of the event id replay memory, so streaming never starves internal events", async () => {
    // A replay memory that holds three ids: before run output had its own dedupe, the fourth batch
    // of one streaming run filled it and every internal request answered 503.
    h = await start({ replayMemoryCapacity: 3 });
    owner = await addOwner(h);
    generation = await currentGeneration(h);
    h.runs.runs.set(runId, {
      ownerId: owner.ownerId,
      conversationId,
      status: "running",
      generation,
    });
    const handle = vi.fn<InternalEventHandler["handle"]>(async () => undefined);
    h.handlers.register({ type: "tasks.changed", handle });

    for (let seq = 0; seq < 12; seq += 1) {
      expect((await send(h, output(seq))).status).toBe(202);
    }
    // Every retry of a batch is re-signed with a fresh event id; the (runId, seq) dedupe answers it.
    expect((await send(h, output(11))).status).toBe(200);

    const announcement = {
      id: uuidv7(),
      type: "tasks.changed",
      ownerId: owner.ownerId,
      occurredAt: h.clock.now(),
      payload: { taskIds: [uuidv7()], taskTreeVersion: 1 },
    };
    const accepted = await send(
      h,
      signed(h, INTERNAL_EVENTS_PATH, announcement, { eventId: announcement.id }),
    );
    expect(accepted.status).toBe(202);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("stops relaying when the api shuts down", async () => {
    h.hub.beginShutdown();
    expect((await send(h, output(0))).status).toBe(503);
  });
});

/* ------------------------------------------------------------------------------------------------
 * Webhook receipts
 * --------------------------------------------------------------------------------------------- */

describe("run output relay dedupe as replay protection (§6.2, §8.2)", () => {
  function relayFor(options: { readonly maxRuns?: number } = {}) {
    const clock = new FakeClock(Date.UTC(2026, 8, 15, 10));
    const keys = createKeyProvider({
      CONTENT_KEK: { current: 1, versions: new Map([[1, secret(41)]]) },
    });
    const ownerId = uuidv7();
    const conversationId = uuidv7();
    const { key } = createAccountKey(keys, ownerId);
    const active = new Map<string, RunLifecycleStatus>();
    const lookups = { ownership: 0, state: 0 };
    const log = new Log();
    const relay = new RunOutputRelay({
      source: {
        ownership: async (runId) => {
          lookups.ownership += 1;
          return active.has(runId) ? { runId, ownerId, conversationId } : null;
        },
        state: async (runId) => {
          lookups.state += 1;
          const status = active.get(runId);
          return status ? { status, executorGeneration: 1 } : null;
        },
      },
      accountKeys: {
        load: async () => ({ ...key, key: Uint8Array.from(key.key) }),
      } as unknown as Pick<AccountKeyStore, "load">,
      executorState: {
        readCached: async () => ({ generation: 1 }),
      } as unknown as ExecutorStateReader,
      hub: new TopicHub({
        registry: new TopicRegistry(),
        access: { satisfies: () => true },
        timers: clock,
        log,
      }),
      timers: clock,
      log,
      ...options,
    });
    const body = (runId: string, seq: number) => ({
      runId,
      attempt: 1,
      seq,
      envelope: encryptFieldText(
        key,
        runChunkContext(ownerId, runId, seq),
        JSON.stringify([{ type: "text-start", id: "t1" }]),
      ),
    });
    return { clock, relay, active, lookups, body };
  }

  it("refuses new runs while full of runs inside their replay window, instead of forgetting one", async () => {
    const { clock, relay, active, body } = relayFor({ maxRuns: 2 });
    const [a, b, c] = [uuidv7(), uuidv7(), uuidv7()];
    for (const runId of [a, b, c]) active.set(runId, "running");
    expect(await relay.accept(a, body(a, 0))).toEqual({ status: "accepted", relayed: 1 });
    expect(await relay.accept(b, body(b, 0))).toEqual({ status: "accepted", relayed: 1 });
    expect(await relay.accept(c, body(c, 0))).toEqual({ status: "rejected", reason: "capacity" });
    // Run a is still remembered, so its replay is a duplicate rather than a second relay.
    expect(await relay.accept(a, body(a, 0))).toEqual({ status: "duplicate" });

    await clock.advance(RUN_OUTPUT_REPLAY_WINDOW_MS);
    expect(await relay.accept(b, body(b, 1))).toEqual({ status: "accepted", relayed: 1 });
    // Only a run whose last request left the replay window makes room.
    expect(await relay.accept(c, body(c, 0))).toEqual({ status: "accepted", relayed: 1 });
    expect(relay.trackedRuns).toBe(2);
  });

  it.each(["awaiting_approval", "awaiting_user"] as const)(
    "relays a committed %s card while the pause owns the conversation",
    async (status) => {
      const { relay, active, body } = relayFor();
      const id = uuidv7();
      active.set(id, status);
      expect(await relay.accept(id, body(id, 0))).toEqual({ status: "accepted", relayed: 1 });
      expect(await relay.accept(id, body(id, 0))).toEqual({ status: "duplicate" });
    },
  );

  it("keeps the dedupe of a run that ended, and answers repeated misses without new lookups", async () => {
    const { clock, relay, active, lookups, body } = relayFor();
    const runId = uuidv7();
    active.set(runId, "running");
    expect(await relay.accept(runId, body(runId, 0))).toEqual({ status: "accepted", relayed: 1 });
    active.set(runId, "completed");
    await clock.advance(10_000);
    expect(await relay.accept(runId, body(runId, 1))).toMatchObject({ reason: "inactive_run" });
    expect(await relay.accept(runId, body(runId, 0))).toEqual({ status: "duplicate" });

    const unknown = uuidv7();
    const before = { ...lookups };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await relay.accept(unknown, body(unknown, 0))).toMatchObject({
        reason: "unknown_run",
      });
    }
    expect(lookups.ownership - before.ownership).toBe(1);
    await clock.advance(10_000);
    expect(await relay.accept(unknown, body(unknown, 0))).toMatchObject({ reason: "unknown_run" });
    expect(lookups.ownership - before.ownership).toBe(2);
  });

  it("revokes cached ownership immediately while retaining sequence replay protection", async () => {
    const { relay, active, lookups, body } = relayFor();
    const runId = uuidv7();
    active.set(runId, "running");
    expect(await relay.accept(runId, body(runId, 0))).toEqual({ status: "accepted", relayed: 1 });
    const before = { ...lookups };
    relay.invalidate(runId);
    expect(await relay.accept(runId, body(runId, 1))).toEqual({
      status: "rejected",
      reason: "unknown_run",
    });
    expect(lookups).toEqual(before);
    expect(await relay.accept(runId, body(runId, 0))).toEqual({ status: "duplicate" });
  });
});

describe("run output relay key cache (§8.2)", () => {
  it("decrypts with a private copy of the cached key, so a concurrent eviction never zeroes it mid-request", async () => {
    const clock = new FakeClock(Date.UTC(2026, 8, 15, 10));
    const keys = createKeyProvider({
      CONTENT_KEK: { current: 1, versions: new Map([[1, secret(31)]]) },
    });
    const ownerId = uuidv7();
    const runId = uuidv7();
    const conversationId = uuidv7();
    const { key } = createAccountKey(keys, ownerId);
    const log = new Log();
    const relay = new RunOutputRelay({
      source: {
        ownership: async () => ({ runId, ownerId, conversationId }),
        state: async () => ({ status: "running", executorGeneration: 1 }),
      },
      accountKeys: {
        load: async () => ({ ...key, key: Uint8Array.from(key.key) }),
      } as unknown as Pick<AccountKeyStore, "load">,
      executorState: {
        readCached: async () => ({ generation: 1 }),
      } as unknown as ExecutorStateReader,
      hub: new TopicHub({
        registry: new TopicRegistry(),
        access: { satisfies: () => true },
        timers: clock,
        log,
      }),
      timers: clock,
      log,
    });
    const body = (seq: number) => ({
      runId,
      attempt: 1,
      seq,
      envelope: encryptFieldText(
        key,
        runChunkContext(ownerId, runId, seq),
        JSON.stringify([{ type: "text-start", id: "t1" }]),
      ),
    });
    expect(await relay.accept(runId, body(0))).toEqual({ status: "accepted", relayed: 1 });

    // Zeroise every cached key right after the next lookup hands one out, before decryption runs.
    const cache = (relay as unknown as { keys: Map<string, unknown> }).keys;
    const get = cache.get.bind(cache);
    cache.get = (ownerKey: string) => {
      const value = get(ownerKey);
      queueMicrotask(() => relay.clear());
      return value;
    };
    expect(await relay.accept(runId, body(1))).toEqual({ status: "accepted", relayed: 1 });
    expect(log.lines.join("\n")).not.toContain("undecryptable");
  });
});

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
    expect(generateToken().length).toBeGreaterThan(0);
  });
});
