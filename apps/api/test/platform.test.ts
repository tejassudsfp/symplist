import { type ConversationId, conversationTopic } from "@symplist/contracts";
import type { D1AccessService } from "@symplist/core/access";
import type {
  EventsContributor,
  InternalEventHandler,
  RunRelaySource,
} from "@symplist/core/events";
import { createKeyProvider } from "@symplist/crypto";
import { newWriteId, uuidv7 } from "@symplist/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InternalEventClient } from "../../worker/src/infra/internal-events.ts";
import { createWorkerLogger, type WorkerLogSink } from "../../worker/src/infra/logger.ts";
import { RunOutputPushClient } from "../../worker/src/infra/run-output.ts";
import { ACCESS_SERVICE } from "../src/common/access/access.providers.ts";
import { insertDispatchIntentStatement } from "../src/infra/executors/dispatch-intents.ts";
import { ExecutionDispatcher } from "../src/infra/executors/dispatcher.ts";
import { ExecutionRegistry } from "../src/infra/executors/execution-registry.ts";
import { InternalEventHandlerRegistry } from "../src/modules/internal/internal-event-handlers.ts";
import { TopicRegistry } from "../src/modules/realtime/topic-registry.ts";
import { FakeTracker } from "./executors/memory-tracker.ts";
import { bootTestApp, generatedSecret, type TestApp, type TestSession } from "./harness.ts";
import { WsTestClient } from "./ws-client.ts";

/**
 * The platform end to end (§5.1, §5.5, §6.2, §7, §8.2): the api booted with every runtime module
 * wired, real WebSockets and HTTP on its ephemeral port, and the worker's own clients pushing to it.
 */

const MARKER = "MARKER-e2e-5d0a-run-output";
const PROBE_KIND = "probe_run";

let apps: TestApp[] = [];
const clients: WsTestClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const app of apps.splice(0)) await app.close();
});

/**
 * An in-memory `runs` table standing in for Simon's (§8.1, §8.2): the tracker the executors reconcile
 * and cancel through, and the relay source the run output relay reads ownership and status from.
 */
class ProbeRuns implements RunRelaySource {
  readonly tracker = new FakeTracker();
  readonly conversations = new Map<string, string>();
  generation = 1;

  async ownership(runId: string) {
    const run = this.tracker.runs.get(runId);
    const conversationId = this.conversations.get(runId);
    return run && conversationId ? { runId, ownerId: run.ownerId, conversationId } : null;
  }

  async state(runId: string) {
    const run = this.tracker.runs.get(runId);
    return run ? { status: run.status, executorGeneration: this.generation } : null;
  }

  contributor(): EventsContributor {
    return {
      domain: "simon",
      executionKinds: [
        {
          kind: PROBE_KIND,
          triggerTaskId: "probe-run",
          payload: (job) => ({ runId: job.subjectId }),
          tracker: () => this.tracker,
        },
      ],
      runRelaySource: () => this,
    };
  }
}

async function boot(runs = new ProbeRuns()): Promise<{ app: TestApp; runs: ProbeRuns }> {
  const app = await bootTestApp({ runtime: { eventsContributors: [runs.contributor()] } });
  apps.push(app);
  return { app, runs };
}

async function connect(app: TestApp, session: TestSession): Promise<WsTestClient> {
  const client = await WsTestClient.connect(app.wsUrl, {
    origin: app.config.WEB_ORIGIN,
    cookie: session.cookie,
  });
  clients.push(client);
  return client;
}

async function subscribeUser(client: WsTestClient): Promise<void> {
  client.send({ t: "sub", topic: "user", cursor: null, openTasks: [] });
  await client.waitFor((frame) => frame.t === "snapshot" && frame.topic === "user");
}

function workerLog() {
  const lines: string[] = [];
  const sink: WorkerLogSink = {
    info: (message, properties) => lines.push(JSON.stringify({ message, properties })),
    warn: (message, properties) => lines.push(JSON.stringify({ message, properties })),
    error: (message, properties) => lines.push(JSON.stringify({ message, properties })),
  };
  return { lines, logger: createWorkerLogger(sink) };
}

describe("platform end to end", () => {
  it("closes a subscribed socket with 4403 on restriction, stops the user's runs, then 4401 on logout", async () => {
    const { app, runs } = await boot();
    const user = await app.createSignedInUser();
    const bystander = await app.createSignedInUser();

    // A running local job of the user, with its stop requested by the restriction batch (§5.5).
    let aborted: unknown;
    app.inject<ExecutionRegistry>(ExecutionRegistry).registerLocalHandler(
      PROBE_KIND,
      (_job, context) =>
        new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => {
            aborted = context.signal.reason;
            reject(context.signal.reason);
          });
        }),
    );
    const runId = uuidv7(app.clock.now());
    runs.tracker.add(runId, { ownerId: user.id, executor: null, status: "running" });
    await app.db.run(
      insertDispatchIntentStatement({
        id: uuidv7(app.clock.now()),
        ownerId: user.id,
        kind: PROBE_KIND,
        subjectId: runId,
        now: app.clock.now(),
        writeId: newWriteId(),
      }),
    );
    expect(
      (await app.inject<ExecutionDispatcher>(ExecutionDispatcher).dispatchPending()).dispatched,
    ).toBe(1);

    const socket = await connect(app, user.session);
    const other = await connect(app, bystander.session);
    await subscribeUser(socket);
    await subscribeUser(other);

    const run = runs.tracker.runs.get(runId);
    if (run) run.cancelRequestedAt = app.clock.now();
    const outcome = await app.inject<D1AccessService>(ACCESS_SERVICE).restrict({
      userId: user.id,
      reason: "relocked",
      writeId: uuidv7(app.clock.now()),
      now: app.clock.now(),
    });
    expect(outcome).toMatchObject({ applied: true, accessGeneration: 1 });
    expect((await socket.closed).code).toBe(4403);
    await other.settle();
    await vi.waitFor(() => expect(aborted).toMatchObject({ reason: "stopped" }));
    await vi.waitFor(() => expect(runs.tracker.runs.get(runId)?.status).toBe("stopped"));
    expect(app.trigger.cancellations).toEqual([]);

    // Relock keeps the login session (§5.5): once the upgrade race margin has passed the user can
    // reconnect at identity level, and logging out closes that session's socket with 4401.
    await app.clock.advance(10_001);
    const again = await connect(app, user.session);
    await subscribeUser(again);
    expect(await app.sessions.revoke({ userId: user.id, sessionId: user.session.sessionId })).toBe(
      true,
    );
    expect((await again.closed).code).toBe(4401);
    await other.settle();
    expect(other.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("delivers a signed internal event from the worker client to its handler and rejects a forged one", async () => {
    const { app } = await boot();
    const user = await app.createUser();
    const handle = vi.fn<InternalEventHandler["handle"]>(async () => undefined);
    app.inject<InternalEventHandlerRegistry>(InternalEventHandlerRegistry).register({
      type: "probe.announced",
      handle,
    });
    const taskId = uuidv7(app.clock.now());
    const { logger } = workerLog();
    const worker = new InternalEventClient({
      keys: app.keys,
      apiOrigin: app.baseUrl,
      logger,
      timers: app.clock,
    });
    expect(
      await worker.announce({
        type: "probe.announced",
        ownerId: user.id,
        payload: { taskIds: [taskId] },
      }),
    ).toBe("delivered");
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]?.[0]).toMatchObject({
      type: "probe.announced",
      ownerId: user.id,
      payload: { taskIds: [taskId] },
    });

    // A sender holding another secret under the api's current key version is refused.
    const forgedKeys = createKeyProvider({
      INTERNAL_EVENT_SECRET: { current: 1, versions: new Map([[1, generatedSecret()]]) },
    });
    const forger = new InternalEventClient({
      keys: forgedKeys,
      apiOrigin: app.baseUrl,
      logger,
      timers: app.clock,
      maxAttempts: 1,
    });
    expect(
      await forger.announce({
        type: "probe.announced",
        ownerId: user.id,
        payload: { taskIds: [taskId] },
      }),
    ).toBe("rejected");
    expect(handle).toHaveBeenCalledTimes(1);
    expect(app.logs.events("internal.request_rejected")).toMatchObject([
      { reason: "invalid_signature" },
    ]);
  });

  it("never reports an event delivered while the handler of its first try can still fail", async () => {
    const { app } = await boot();
    const user = await app.createUser();
    let fail: (error: unknown) => void = () => undefined;
    const handle = vi
      .fn<InternalEventHandler["handle"]>(async () => undefined)
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            fail = reject;
          }),
      );
    app.inject<InternalEventHandlerRegistry>(InternalEventHandlerRegistry).register({
      type: "probe.announced",
      handle,
    });
    const { lines, logger } = workerLog();
    const worker = new InternalEventClient({
      keys: app.keys,
      apiOrigin: app.baseUrl,
      logger,
      timers: app.clock,
    });
    const rejections = (reason: string) =>
      app.logs.events("internal.request_rejected").filter((line) => line.reason === reason).length;
    /** Moves the shared fake clock in small steps until `check` passes. */
    const advanceUntil = (check: () => void) =>
      vi.waitFor(
        async () => {
          await app.clock.advance(25);
          check();
        },
        { timeout: 3_000, interval: 5 },
      );

    const announcing = worker.announce({
      type: "probe.announced",
      ownerId: user.id,
      payload: { taskIds: [uuidv7(app.clock.now())] },
    });
    // Try 1 reaches the handler, which is still running when the worker stops waiting at 2 seconds.
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1));
    await app.clock.advance(2_000);
    // Try 2 finds the first try still in progress instead of being told the event was delivered.
    await advanceUntil(() => expect(rejections("in_progress")).toBe(1));
    // The first try's handler fails afterwards; the api forgets the id and try 3 handles it again.
    fail(Object.assign(new Error("D1 unavailable"), { code: "db.unavailable" }));
    await vi.waitFor(() =>
      expect(app.logs.events("internal.event_handler_failed")).toHaveLength(1),
    );
    await advanceUntil(() => expect(handle).toHaveBeenCalledTimes(2));
    expect(await announcing).toBe("delivered");
    expect(app.logs.events("internal.event_handled")).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("internal_event.delivered_on_retry");
  });

  it("relays encrypted run output pushed by the worker over HTTP to the owner's conversation socket", async () => {
    const { app, runs } = await boot();
    const owner = await app.createSignedInUser();
    const stranger = await app.createSignedInUser();
    const conversationId = uuidv7(app.clock.now()) as ConversationId;
    const runId = uuidv7(app.clock.now());
    runs.tracker.add(runId, { ownerId: owner.id, executor: "trigger", status: "running" });
    runs.conversations.set(runId, conversationId);
    app.inject<TopicRegistry>(TopicRegistry).registerAuthorizer({
      kind: "conversation",
      authorize: async (socket, topic) =>
        topic.conversationId === conversationId && socket.userId === owner.id,
    });

    const topic = conversationTopic(conversationId);
    const viewer = await connect(app, owner.session);
    viewer.send({ t: "sub", topic, cursor: null });
    // No snapshot provider is registered yet, so the subscription starts with a resync.
    await viewer.waitFor((frame) => frame.t === "resync");
    const intruder = await connect(app, stranger.session);
    intruder.send({ t: "sub", topic, cursor: null });
    await intruder.waitFor((frame) => frame.t === "err");

    const { lines, logger } = workerLog();
    const accountKey = await app.accountKeys.require(owner.id);
    const push = new RunOutputPushClient({
      runId,
      ownerId: owner.id,
      attempt: 1,
      accountKey,
      keys: app.keys,
      apiOrigin: app.baseUrl,
      logger,
      timers: app.clock,
    });
    push.write({ type: "text-start", id: "t1" });
    push.write({ type: "text-delta", id: "t1", delta: `${MARKER} hello` });
    push.write({ type: "text-end", id: "t1" });
    expect(await push.close()).toEqual({
      batchesSent: 1,
      batchesDropped: 0,
      chunksSent: 3,
      chunksDropped: 0,
    });

    await viewer.waitFor(
      (frame) =>
        frame.t === "ev" && (frame.data as { chunk: { type: string } }).chunk.type === "text-end",
    );
    const events = viewer.frames.filter((frame) => frame.t === "ev");
    expect(events.map((frame) => frame.type)).toEqual(["chunk", "chunk", "chunk"]);
    expect(events[1]).toMatchObject({
      topic,
      data: { runId, chunk: { type: "text-delta", delta: `${MARKER} hello` } },
    });
    await intruder.settle();
    expect(intruder.frames.filter((frame) => frame.t === "ev")).toEqual([]);
    // Plaintext exists only in api memory and on the owner's socket: never in D1, logs or objects.
    expect(await app.scanDatabaseFor(MARKER)).toEqual([]);
    expect(app.logs.text()).not.toContain(MARKER);
    expect(lines.join("\n")).not.toContain(MARKER);
  });

  it("closes every socket with 1001 when the api shuts down", async () => {
    const { app } = await boot();
    apps = apps.filter((candidate) => candidate !== app);
    const user = await app.createSignedInUser();
    const socket = await connect(app, user.session);
    await subscribeUser(socket);
    const closing = app.close();
    expect((await socket.closed).code).toBe(1001);
    await closing;
  });
});
