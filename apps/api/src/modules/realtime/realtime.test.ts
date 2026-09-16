import { type ConversationId, conversationTopic } from "@symplist/contracts";
import type { SessionContext } from "@symplist/core/access";
import { type BufferedTopicEvent, TopicAccessDeniedError } from "@symplist/core/events";
import { int, sql, uuidv7 } from "@symplist/db";
import { FakeClock } from "@symplist/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  bootTestApp,
  type TestApp,
  type TestAppOptions,
  type TestSession,
  type TestUserState,
} from "../../../test/harness.ts";
import { rawUpgrade, WsTestClient } from "../../../test/ws-client.ts";
import { ACCESS_SERVICE } from "../../common/access/access.providers.ts";
import { REALTIME_ACCESS_NOTIFIER, REALTIME_SHUTDOWN } from "../../common/seams.ts";
import type { OperationalLog, OperationalLogFields } from "../../infra/scheduler/runtime.ts";
import { SimonTopics } from "../simon/simon.realtime.ts";
import { AccessSweep } from "./access-sweep.ts";
import { REALTIME_PUBLISHER, type RealtimeDependencies } from "./realtime.tokens.ts";
import { RingBuffer } from "./ring-buffer.ts";
import { RealtimeSessionControl } from "./session-control.ts";
import { RealtimeShutdownControl } from "./shutdown-control.ts";
import { type AccessLevelPolicy, RealtimePublishError, TopicHub } from "./topic-hub.ts";
import { TopicRegistry } from "./topic-registry.ts";
import type { UpgradeSession } from "./upgrade-gate.ts";

/* ------------------------------------------------------------------------------------------------
 * Fixtures
 * --------------------------------------------------------------------------------------------- */

const MARKER = "MARKER-7f3a-plaintext-never-logged";

/** Test events: the composed contracts map is still empty, so these stand in for feature events. */
const testEvents = {
  "access.changed": z.strictObject({ accessState: z.string() }),
  "tasks.changed": z.strictObject({
    taskTreeVersion: z.number().int(),
    taskIds: z.array(z.string()),
  }),
  "run.status": z.strictObject({ runId: z.string(), status: z.string() }),
  "run.progress": z.strictObject({ step: z.number().int() }),
};

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

interface Harness {
  readonly app: TestApp;
  readonly hub: TopicHub;
  readonly registry: TopicRegistry;
  readonly sweep: AccessSweep;
  readonly control: RealtimeSessionControl;
  readonly clients: WsTestClient[];
  user(state?: TestUserState): Promise<{ readonly id: string; readonly session: TestSession }>;
  connect(session: TestSession, headers?: Record<string, string>): Promise<WsTestClient>;
  upgradeHeaders(session: TestSession): Record<string, string>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    for (const client of harness.clients) client.close();
    await harness.app.close();
  }
});

async function start(
  tuning: RealtimeDependencies["tuning"] = {},
  options: Pick<TestAppOptions, "env"> & { readonly backgroundLoops?: boolean } = {},
): Promise<Harness> {
  const app = await bootTestApp({
    // These infrastructure tests install deliberately synthetic owners/providers below. Production
    // Simon topic registration is covered by its real-conversation HTTP/WebSocket tests instead.
    overrides: [{ token: SimonTopics, value: { onModuleInit() {} } }],
    ...(options.env ? { env: options.env } : {}),
    runtime: {
      ...(options.backgroundLoops === undefined
        ? {}
        : { backgroundLoops: options.backgroundLoops }),
      realtime: { tuning: { sweepIntervalMs: 3_600_000, ...tuning }, events: testEvents },
    },
  });
  const clients: WsTestClient[] = [];
  const upgradeHeaders = (session: TestSession) => ({
    origin: app.config.WEB_ORIGIN,
    cookie: session.cookie,
  });
  const harness: Harness = {
    app,
    hub: app.inject(TopicHub),
    registry: app.inject(TopicRegistry),
    sweep: app.inject(AccessSweep),
    control: app.inject(RealtimeSessionControl),
    clients,
    async user(state = "admitted") {
      const user = await app.createSignedInUser(state);
      return { id: user.id, session: user.session };
    },
    async connect(session, headers = {}) {
      const client = await WsTestClient.connect(app.wsUrl, {
        ...upgradeHeaders(session),
        ...headers,
      });
      clients.push(client);
      return client;
    },
    upgradeHeaders,
  };
  harnesses.push(harness);
  return harness;
}

/** Ends a session by expiry in D1 alone, as time passing would, without moving other sessions. */
async function expireSession(h: Harness, session: TestSession): Promise<void> {
  await h.app.db.run(
    sql("UPDATE auth_sessions SET expires_at = created_at + 1 WHERE id = :id", {
      id: session.sessionId,
    }),
  );
  await h.app.clock.advance(2);
}

function ownedConversations(owner: Map<string, string>) {
  return {
    kind: "conversation" as const,
    authorize: async (socket: SessionContext, topic: { conversationId: ConversationId }) =>
      owner.get(topic.conversationId) === socket.userId,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Tests
 * --------------------------------------------------------------------------------------------- */

describe("ring buffer", () => {
  it("keeps the newest entries and knows when a cursor can be replayed", () => {
    const buffer = new RingBuffer<{ seq: number }>(3);
    for (const seq of [11, 12, 13, 14]) buffer.push({ seq });
    expect(buffer.after(12).map((entry) => entry.seq)).toEqual([13, 14]);
    expect(buffer.upTo(13).map((entry) => entry.seq)).toEqual([12, 13]);
    expect(buffer.canReplayAfter(11, 14)).toBe(true);
    expect(buffer.canReplayAfter(10, 14)).toBe(false);
    expect(buffer.canReplayAfter(14, 14)).toBe(true);
    expect(buffer.canReplayAfter(15, 14)).toBe(false);
    expect(() => buffer.push({ seq: 14 })).toThrow(RangeError);
  });
});

describe("platform wiring (§5.5, §7)", () => {
  it("binds the gateway's session control, shutdown control and access policy into the platform", async () => {
    const h = await start();
    expect(h.app.inject<RealtimeShutdownControl>(REALTIME_SHUTDOWN)).toBeInstanceOf(
      RealtimeShutdownControl,
    );
    const notifier = h.app.inject<{ sessionsEnded: unknown }>(REALTIME_ACCESS_NOTIFIER);
    expect(typeof notifier.sessionsEnded).toBe("function");
    // The hub's policy is the access service's own check, honoring BETA_ACCESS_REQUIRED.
    const lenient = await start({}, { env: { BETA_ACCESS_REQUIRED: "false" } });
    const locked = await lenient.user("locked");
    const client = await lenient.connect(locked.session);
    await client.settle();
    expect(lenient.hub.socketsOfUser(locked.id)[0]?.admitted).toBe(true);
    const policy = lenient.app.inject<AccessLevelPolicy>(ACCESS_SERVICE);
    const state = await lenient.app.accessState(locked.id);
    expect(state && policy.satisfies(state, "admitted")).toBe(true);
  });
});

describe("WebSocket upgrade authentication (§7)", () => {
  it("rejects a missing or foreign Origin with 403 before looking at the session", async () => {
    const h = await start();
    const user = await h.user();
    const resolve = vi.spyOn(h.app.sessions, "resolveUpgrade");
    expect((await rawUpgrade(h.app.wsUrl, { cookie: user.session.cookie })).status).toBe(403);
    expect(
      (
        await rawUpgrade(h.app.wsUrl, {
          origin: "https://artifact.example.com",
          cookie: user.session.cookie,
        })
      ).status,
    ).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
    const accepted = await rawUpgrade(h.app.wsUrl, h.upgradeHeaders(user.session));
    accepted.socket?.destroy();
    expect(accepted.status).toBe(101);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing, forged, revoked or expired session with 401 and ignores bearer tokens", async () => {
    const h = await start();
    const revoked = await h.user();
    await h.app.sessions.revoke({ userId: revoked.id, sessionId: revoked.session.sessionId });
    const expired = await h.user();
    await expireSession(h, expired.session);
    const origin = h.app.config.WEB_ORIGIN;
    expect((await rawUpgrade(h.app.wsUrl, { origin })).status).toBe(401);
    expect(
      (await rawUpgrade(h.app.wsUrl, { origin, authorization: `Bearer ${revoked.session.token}` }))
        .status,
    ).toBe(401);
    expect(
      (
        await rawUpgrade(h.app.wsUrl, {
          origin,
          cookie: `${h.app.sessionCookieName}=${Buffer.alloc(32, 7).toString("base64url")}`,
        })
      ).status,
    ).toBe(401);
    // The cached lookup of a session revoked in this process is evicted at once.
    expect((await rawUpgrade(h.app.wsUrl, h.upgradeHeaders(revoked.session))).status).toBe(401);
    expect((await rawUpgrade(h.app.wsUrl, h.upgradeHeaders(expired.session))).status).toBe(401);
  });

  it("rejects an account being deleted with 403, below the identity level", async () => {
    const h = await start();
    const user = await h.user();
    await h.app.db.run(
      sql(
        "UPDATE users SET deletion_state = 'deleting', deletion_requested_at = 1 WHERE id = :id",
        { id: user.id },
      ),
    );
    expect((await rawUpgrade(h.app.wsUrl, h.upgradeHeaders(user.session))).status).toBe(403);
  });

  it("accepts a valid session at identity level and records the socket's user, session and access", async () => {
    const h = await start();
    const user = await h.user();
    const locked = await h.user("locked");
    const client = await h.connect(user.session);
    const lockedClient = await h.connect(locked.session);
    await client.settle();
    await lockedClient.settle();
    expect(h.hub.socketsOfSession(user.session.sessionId)[0]).toMatchObject({
      userId: user.id,
      sessionId: user.session.sessionId,
      admitted: true,
    });
    expect(h.hub.socketsOfUser(locked.id)[0]).toMatchObject({ admitted: false });
  });
});

describe("frames (§7)", () => {
  it("answers ping with pong and malformed, unknown or binary frames with a validation error", async () => {
    const h = await start();
    const client = await h.connect((await h.user()).session);
    client.send({ t: "ping" });
    await client.waitFor((frame) => frame.t === "pong");
    client.send("{not json");
    client.send({ t: "sub", topic: "user" });
    client.send({ t: "publish", topic: "user" });
    client.send({ t: "sub", topic: "conversation:not-a-uuid", cursor: null });
    client.socket.send(new Uint8Array([1, 2, 3]));
    await client.settle();
    expect(client.frames.filter((frame) => frame.t === "err")).toEqual(
      Array.from({ length: 5 }, () => ({ t: "err", code: "validation" })),
    );
  });

  it("handles a socket's frames in order, so an unsub never races an in-flight sub", async () => {
    const h = await start();
    const user = await h.user();
    h.registry.registerAuthorizer({
      kind: "conversation",
      authorize: () => new Promise((resolve) => setTimeout(() => resolve(true), 30)),
    });
    const client = await h.connect(user.session);
    const topic = conversationTopic(uuidv7() as ConversationId);
    client.send({ t: "sub", topic, cursor: null });
    client.send({ t: "unsub", topic });
    await client.settle();
    expect(h.hub.socketsOfUser(user.id)[0]?.subscriptionCount).toBe(0);
  });

  it("closes with 1008 after more than 20 frames in 10 seconds", async () => {
    const h = await start();
    const client = await h.connect((await h.user()).session);
    for (let index = 0; index < 21; index += 1) client.send({ t: "ping" });
    expect((await client.closed).code).toBe(1008);
  });

  it("closes with 1008 above 50 subscriptions", async () => {
    const h = await start({ framesPerWindow: 100 });
    const user = await h.user();
    h.registry.registerAuthorizer({ kind: "conversation", authorize: async () => true });
    const client = await h.connect(user.session);
    for (let index = 0; index < 50; index += 1) {
      client.send({ t: "sub", topic: conversationTopic(uuidv7() as ConversationId), cursor: null });
    }
    await client.settle();
    expect(h.hub.socketsOfUser(user.id)[0]?.subscriptionCount).toBe(50);
    client.send({ t: "sub", topic: conversationTopic(uuidv7() as ConversationId), cursor: null });
    expect((await client.closed).code).toBe(1008);
  });

  it("pings every heartbeat interval and terminates a client that never answers", async () => {
    const h = await start({ heartbeatIntervalMs: 60 }, { backgroundLoops: true });
    const user = await h.user();
    const { status, socket } = await rawUpgrade(h.app.wsUrl, h.upgradeHeaders(user.session));
    expect(status).toBe(101);
    const opcodes: number[] = [];
    socket?.on("data", (chunk: Buffer) => opcodes.push((chunk[0] ?? 0) & 0x0f));
    const closed = new Promise<void>((resolve) => socket?.on("close", () => resolve()));
    await h.app.clock.advance(60);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await h.app.clock.advance(60);
    await closed;
    expect(opcodes).toContain(0x9);
    expect(h.hub.socketsOfUser(user.id)).toHaveLength(0);
  });
});

describe("user topic (§7)", () => {
  it("sends an admitted socket the composed snapshot and then its user events", async () => {
    const h = await start();
    const user = await h.user();
    const other = await h.user();
    const taskId = uuidv7();
    h.registry.registerUserSnapshotContributor({
      name: "workspace",
      contribute: async () => ({ taskTreeVersion: 7, unreadCount: 2 }),
    });
    h.registry.registerUserSnapshotContributor({
      name: "documents",
      contribute: async (_socket, input) => ({
        heads: Object.fromEntries(
          [...input.openTasks, uuidv7()].map((id) => [id, "rev-1"]),
        ) as never,
      }),
    });
    const client = await h.connect(user.session);
    const otherClient = await h.connect(other.session);
    client.send({ t: "sub", topic: "user", cursor: null, openTasks: [taskId] });
    otherClient.send({ t: "sub", topic: "user", cursor: null, openTasks: [] });
    const snapshot = await client.waitFor((frame) => frame.t === "snapshot");
    expect(snapshot).toMatchObject({
      topic: "user",
      data: {
        unreadCount: 2,
        taskTreeVersion: 7,
        heads: { [taskId]: "rev-1" },
        vaultUnlocked: false,
      },
    });
    await otherClient.waitFor((frame) => frame.t === "snapshot");

    await h.hub.publishToUser(user.id, {
      type: "tasks.changed",
      data: { taskTreeVersion: 8, taskIds: [taskId] },
    });
    const event = await client.waitFor((frame) => frame.t === "ev");
    expect(event).toMatchObject({
      topic: "user",
      type: "tasks.changed",
      seq: (snapshot.seq as number) + 1,
    });
    await otherClient.settle();
    expect(otherClient.frames.some((frame) => frame.t === "ev")).toBe(false);
  });

  it("gives a socket that is not admitted an empty snapshot and access-state events only", async () => {
    const h = await start();
    const locked = await h.user("locked");
    const contributor = vi.fn(async () => ({ unreadCount: 99 }));
    h.registry.registerUserSnapshotContributor({ name: "scheduling", contribute: contributor });
    const client = await h.connect(locked.session);
    client.send({ t: "sub", topic: "user", cursor: null, openTasks: [] });
    const snapshot = await client.waitFor((frame) => frame.t === "snapshot");
    expect(snapshot.data).toEqual({
      unreadCount: 0,
      taskTreeVersion: 0,
      heads: {},
      vaultUnlocked: false,
    });
    expect(contributor).not.toHaveBeenCalled();

    await h.hub.publishToUser(locked.id, {
      type: "tasks.changed",
      data: { taskTreeVersion: 1, taskIds: [] },
    });
    await h.hub.publishToUser(locked.id, {
      type: "access.changed",
      data: { accessState: "unlocked" },
    });
    await client.settle();
    expect(client.frames.filter((frame) => frame.t === "ev").map((frame) => frame.type)).toEqual([
      "access.changed",
    ]);
  });

  it("rejects undeclared events, events on the wrong topic and publish() to the user topic", async () => {
    const h = await start();
    const publisher = h.app.inject<TopicHub>(REALTIME_PUBLISHER);
    await expect(
      h.hub.publishToUser(uuidv7(), { type: "undeclared.event", data: {} }),
    ).rejects.toBeInstanceOf(RealtimePublishError);
    await expect(
      h.hub.publishToUser(uuidv7(), { type: "tasks.changed", data: { taskTreeVersion: "x" } }),
    ).rejects.toMatchObject({ code: "realtime.event_invalid" });
    await expect(
      h.hub.publishToConversation(
        { ownerId: uuidv7(), conversationId: uuidv7() },
        { type: "tasks.changed", data: { taskTreeVersion: 1, taskIds: [] } },
      ),
    ).rejects.toMatchObject({ code: "realtime.topic_invalid" });
    await expect(
      publisher.publish("user", { type: "access.changed", data: { accessState: "x" } } as never),
    ).rejects.toMatchObject({ code: "realtime.topic_invalid" });
  });
});

describe("conversation topics (§7)", () => {
  it("answers unknown and foreign conversations with the same not_found, and requires admitted access", async () => {
    const h = await start();
    const alice = await h.user();
    const bob = await h.user();
    const locked = await h.user("locked");
    const aliceConversation = uuidv7() as ConversationId;
    const lockedConversation = uuidv7() as ConversationId;
    const owners = new Map([
      [aliceConversation, alice.id],
      [lockedConversation, locked.id],
    ]);

    const bobClient = await h.connect(bob.session);
    bobClient.send({ t: "sub", topic: conversationTopic(aliceConversation), cursor: null });
    await bobClient.waitFor((frame) => frame.t === "err");
    expect(bobClient.frames).toEqual([{ t: "err", code: "not_found" }]);

    const authorize = vi.fn(ownedConversations(owners).authorize);
    h.registry.registerAuthorizer({ kind: "conversation", authorize });
    bobClient.send({ t: "sub", topic: conversationTopic(aliceConversation), cursor: null });
    bobClient.send({
      t: "sub",
      topic: conversationTopic(uuidv7() as ConversationId),
      cursor: null,
    });
    await bobClient.settle();
    expect(bobClient.frames.filter((frame) => frame.t === "err")).toEqual([
      { t: "err", code: "not_found" },
      { t: "err", code: "not_found" },
      { t: "err", code: "not_found" },
    ]);

    const lockedClient = await h.connect(locked.session);
    lockedClient.send({ t: "sub", topic: conversationTopic(lockedConversation), cursor: null });
    await lockedClient.waitFor((frame) => frame.t === "err");
    expect(lockedClient.frames).toEqual([{ t: "err", code: "not_found" }]);
    expect(authorize.mock.calls.every(([socket]) => socket.userId === bob.id)).toBe(true);
  });

  it("delivers conversation events to the owner only, snapshots with the live partial, and replays from a cursor", async () => {
    const h = await start({ bufferCapacity: 3 });
    const alice = await h.user();
    const bob = await h.user();
    const conversation = uuidv7() as ConversationId;
    const topic = conversationTopic(conversation);
    h.registry.registerAuthorizer(ownedConversations(new Map([[conversation, alice.id]])));
    const liveSeen: BufferedTopicEvent[][] = [];
    h.registry.registerSnapshotProvider({
      kind: "conversation",
      snapshot: async (_socket, parsed, live) => {
        liveSeen.push([...live]);
        return { conversationId: parsed.conversationId, messages: [] };
      },
    });
    const audience = { ownerId: alice.id, conversationId: conversation };
    const chunk = (index: number) => ({
      type: "chunk",
      data: { runId: "r", chunk: { type: "text-delta", delta: `${MARKER}-${index}` } },
    });

    await h.hub.publishToConversation(audience, chunk(1));
    const alice1 = await h.connect(alice.session);
    alice1.send({ t: "sub", topic, cursor: null });
    const snapshot = await alice1.waitFor((frame) => frame.t === "snapshot");
    expect(snapshot).toMatchObject({ topic, data: { conversationId: conversation } });
    expect(liveSeen[0]?.map((event) => event.type)).toEqual(["chunk"]);

    for (const index of [2, 3]) await h.hub.publishToConversation(audience, chunk(index));
    await alice1.waitFor(
      (frame) => frame.t === "ev" && (frame.seq as number) === (snapshot.seq as number) + 2,
    );
    const events = alice1.frames.filter((frame) => frame.t === "ev");
    expect(events.map((frame) => (frame.data as { chunk: { delta: string } }).chunk.delta)).toEqual(
      [`${MARKER}-2`, `${MARKER}-3`],
    );

    // A reconnect inside the buffer replays the tail.
    const cursor = events[0]?.seq as number;
    const alice2 = await h.connect(alice.session);
    alice2.send({ t: "sub", topic, cursor });
    await alice2.waitFor((frame) => frame.t === "ev");
    await alice2.settle();
    expect(alice2.frames.filter((frame) => frame.t !== "pong").map((frame) => frame.seq)).toEqual([
      events[1]?.seq,
    ]);

    // Cursors outside the buffer, ahead of the topic or from an earlier process get a snapshot.
    for (const index of [4, 5, 6]) await h.hub.publishToConversation(audience, chunk(index));
    for (const stale of [cursor, (h.hub.topicSeq(topic) as number) + 5, 12]) {
      const client = await h.connect(alice.session);
      client.send({ t: "sub", topic, cursor: stale });
      await client.waitFor((frame) => frame.t === "snapshot");
    }

    // Bob, even publishing as the owner through a mistake, never receives Alice's events.
    const bobClient = await h.connect(bob.session);
    bobClient.send({ t: "sub", topic, cursor: null });
    await bobClient.waitFor((frame) => frame.t === "err");
    await h.hub.publishToConversation({ ownerId: bob.id, conversationId: conversation }, chunk(7));
    await bobClient.settle();
    expect(bobClient.frames.filter((frame) => frame.t === "ev")).toEqual([]);
    expect(h.app.logs.events("realtime.owner_mismatch")).toHaveLength(1);

    expect(h.app.logs.text()).not.toContain(MARKER);
  });

  it("detaches when a fresh snapshot denies access and discards queued plaintext", async () => {
    const h = await start();
    const alice = await h.user();
    const conversation = uuidv7() as ConversationId;
    const topic = conversationTopic(conversation);
    h.registry.registerAuthorizer(ownedConversations(new Map([[conversation, alice.id]])));
    let deny: (reason: unknown) => void = () => undefined;
    let entered: () => void = () => undefined;
    const building = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.registry.registerSnapshotProvider({
      kind: "conversation",
      snapshot: () =>
        new Promise((_resolve, reject) => {
          deny = reject;
          entered();
        }),
    });
    const client = await h.connect(alice.session);
    client.send({ t: "sub", topic, cursor: null });
    await building;
    await h.hub.publishToConversation(
      { ownerId: alice.id, conversationId: conversation },
      { type: "run.progress", data: { step: 1 } },
    );
    deny(new TopicAccessDeniedError());
    expect(await client.waitFor((frame) => frame.t === "err")).toMatchObject({ code: "not_found" });
    await h.hub.publishToConversation(
      { ownerId: alice.id, conversationId: conversation },
      { type: "run.progress", data: { step: 2 } },
    );
    await client.settle();
    expect(client.frames.filter((frame) => frame.t !== "pong").map((frame) => frame.t)).toEqual([
      "err",
    ]);
  });

  it("sends resync when no snapshot provider exists and queues events published while a snapshot is built", async () => {
    const h = await start();
    const alice = await h.user();
    const conversation = uuidv7() as ConversationId;
    const topic = conversationTopic(conversation);
    h.registry.registerAuthorizer(ownedConversations(new Map([[conversation, alice.id]])));
    const client = await h.connect(alice.session);
    client.send({ t: "sub", topic, cursor: null });
    expect(await client.waitFor((frame) => frame.t === "resync")).toEqual({ t: "resync", topic });

    let release: (value: unknown) => void = () => undefined;
    let building: () => void = () => undefined;
    const providerCalled = new Promise<void>((resolve) => {
      building = resolve;
    });
    h.registry.registerSnapshotProvider({
      kind: "conversation",
      snapshot: () =>
        new Promise((resolve) => {
          release = resolve;
          building();
        }),
    });
    const second = await h.connect(alice.session);
    second.send({ t: "sub", topic, cursor: null });
    await providerCalled;
    await h.hub.publishToConversation(
      { ownerId: alice.id, conversationId: conversation },
      { type: "run.progress", data: { step: 1 } },
    );
    release({ messages: [] });
    await second.waitFor((frame) => frame.t === "ev");
    expect(second.frames.map((frame) => frame.t)).toEqual(["snapshot", "ev"]);
  });
});

describe("session and access freshness (§5.5)", () => {
  it("closes revoked or expired sessions with 4401 and lost access with 4403 on the sweep", async () => {
    const h = await start();
    const revoked = await h.user();
    const relocked = await h.user();
    const expiring = await h.user();
    const locked = await h.user("locked");
    const clients = {
      revoked: await h.connect(revoked.session),
      relocked: await h.connect(relocked.session),
      expiring: await h.connect(expiring.session),
      locked: await h.connect(locked.session),
    };
    // Changes committed by another api instance: nothing in this process was notified.
    await expireSession(h, expiring.session);
    await h.app.db.batch([
      sql("UPDATE auth_sessions SET revoked_at = :now WHERE id = :id", {
        id: revoked.session.sessionId,
        now: int(h.app.clock.now()),
      }),
      sql(
        "UPDATE users SET beta_state = 'relocked', access_generation = access_generation + 1 WHERE id = :id",
        { id: relocked.id },
      ),
      sql(
        "UPDATE users SET suspended_at = 1, access_generation = access_generation + 1 WHERE id = :id",
        { id: locked.id },
      ),
    ]);
    const report = await h.sweep.sweep();
    expect(report).toEqual({ checked: 4, closedSession: 2, closedAccess: 1 });
    expect((await clients.revoked.closed).code).toBe(4401);
    expect((await clients.expiring.closed).code).toBe(4401);
    expect((await clients.relocked.closed).code).toBe(4403);
    await clients.locked.settle();
    expect(h.hub.socketsOfUser(locked.id)[0]?.access.suspendedAt).toBe(1);
  });

  it("closes an admitted socket whose access generation moved, even when access was restored", async () => {
    const h = await start();
    const restored = await h.user();
    const steady = await h.user();
    const locked = await h.user("locked");
    const clients = {
      restored: await h.connect(restored.session),
      steady: await h.connect(steady.session),
      locked: await h.connect(locked.session),
    };
    // A relock and a restore committed on another instance: admitted again, one generation later.
    await h.app.db.batch([
      sql("UPDATE users SET access_generation = access_generation + 2 WHERE id = :id", {
        id: restored.id,
      }),
      sql(
        "UPDATE users SET beta_state = 'unlocked', access_generation = access_generation + 1 WHERE id = :id",
        { id: locked.id },
      ),
    ]);
    expect(await h.sweep.sweep()).toEqual({ checked: 3, closedSession: 0, closedAccess: 1 });
    expect((await clients.restored.closed).code).toBe(4403);
    await clients.steady.settle();
    await clients.locked.settle();
    // A socket that was only at identity level is refreshed instead: it is admitted from now on.
    expect(h.hub.socketsOfUser(locked.id)[0]).toMatchObject({ admitted: true });
    expect(await h.sweep.sweep()).toEqual({ checked: 2, closedSession: 0, closedAccess: 0 });
  });

  it("never applies a sweep result read before a newer refresh, so a restricted socket is not re-admitted", async () => {
    const h = await start();
    const user = await h.user("locked");
    const client = await h.connect(user.session);
    await client.settle();
    // Access was granted on another instance: the next sweep reads the user as admitted.
    await h.app.db.run(
      sql(
        "UPDATE users SET beta_state = 'unlocked', access_generation = access_generation + 1 WHERE id = :id",
        { id: user.id },
      ),
    );
    const original = h.app.db.batch.bind(h.app.db);
    let read: () => void = () => undefined;
    let deliver: () => void = () => undefined;
    const readDone = new Promise<void>((resolve) => {
      read = resolve;
    });
    const held = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    vi.spyOn(h.app.db, "batch").mockImplementationOnce(async (statements, options) => {
      const results = await original(statements, options);
      read();
      // The sweep's D1 answer is on its way back while the restriction commits and is refreshed.
      await held;
      return results;
    });
    const sweeping = h.sweep.sweep();
    await readDone;

    await h.app.db.run(
      sql(
        "UPDATE users SET beta_state = 'relocked', access_generation = access_generation + 1 WHERE id = :id",
        { id: user.id },
      ),
    );
    await h.sweep.refreshUser(user.id);
    const [socket] = h.hub.socketsOfUser(user.id);
    expect(socket).toMatchObject({ admitted: false, access: { betaState: "relocked" } });
    const generation = socket?.access.accessGeneration;

    deliver();
    expect(await sweeping).toEqual({ checked: 1, closedSession: 0, closedAccess: 0 });
    expect(h.hub.socketsOfUser(user.id)[0]).toMatchObject({
      admitted: false,
      access: { betaState: "relocked", accessGeneration: generation },
    });
  });

  it("never re-admits a restricted socket from a sweep read before the restriction, even when its refresh failed", async () => {
    const h = await start();
    const user = await h.user("locked");
    const client = await h.connect(user.session);
    await client.settle();
    // Access was granted on another instance: the next sweep reads the user as admitted.
    await h.app.db.run(
      sql(
        "UPDATE users SET beta_state = 'unlocked', access_generation = access_generation + 1 WHERE id = :id",
        { id: user.id },
      ),
    );
    const original = h.app.db.batch.bind(h.app.db);
    let read: () => void = () => undefined;
    let deliver: () => void = () => undefined;
    const readDone = new Promise<void>((resolve) => {
      read = resolve;
    });
    const held = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    const batch = vi
      .spyOn(h.app.db, "batch")
      .mockImplementationOnce(async (statements, options) => {
        const results = await original(statements, options);
        read();
        // The sweep's D1 answer is on its way back while the restriction commits.
        await held;
        return results;
      });
    const sweeping = h.sweep.sweep();
    await readDone;

    await h.app.db.run(
      sql(
        "UPDATE users SET beta_state = 'relocked', access_generation = access_generation + 1 WHERE id = :id",
        { id: user.id },
      ),
    );
    // The restriction's refresh of the identity-level socket cannot reach D1.
    batch.mockRejectedValueOnce(
      Object.assign(new Error("D1 timed out"), { code: "db.unavailable" }),
    );
    await h.control.accessRestricted({ userId: user.id, reason: "relocked", accessGeneration: 2 });
    expect(h.app.logs.events("realtime.sweep_failed")).toHaveLength(1);
    expect(h.hub.socketsOfUser(user.id)[0]).toMatchObject({ admitted: false });

    deliver();
    expect(await sweeping).toEqual({ checked: 1, closedSession: 0, closedAccess: 0 });
    expect(h.hub.socketsOfUser(user.id)[0]).toMatchObject({
      admitted: false,
      access: { betaState: "locked" },
    });

    // The next read, taken after the restriction, applies.
    expect(await h.sweep.sweep()).toEqual({ checked: 1, closedSession: 0, closedAccess: 0 });
    expect(h.hub.socketsOfUser(user.id)[0]).toMatchObject({
      admitted: false,
      access: { betaState: "relocked" },
    });
  });

  it("applies access state monotonically by access generation and by read order", () => {
    const clock = new FakeClock(1_000_000);
    const hub = new TopicHub({
      registry: new TopicRegistry(),
      access: {
        satisfies: (state, level) => level === "identity" || state.betaState === "unlocked",
      },
      timers: clock,
      log: new Log(),
    });
    const state = (betaState: "locked" | "unlocked" | "relocked", accessGeneration: number) => ({
      emailVerifiedAt: 1,
      betaState,
      suspendedAt: null,
      onboardingStep: "done" as const,
      role: "member" as const,
      accessGeneration,
      accessEpoch: 0,
      deletionState: "none" as const,
    });
    const socket = hub.connect(
      { send: () => undefined, close: () => undefined, isOpen: () => true },
      { userId: uuidv7(), sessionId: uuidv7(), access: state("locked", 4) },
    );
    const older = hub.beginAccessRead();
    const newer = hub.beginAccessRead();
    expect(hub.applyAccess(socket, state("relocked", 6), newer)).toBe(true);
    // An identity-level socket ignores a result read before the one it applied…
    expect(
      hub.applyAccess(socket, { ...state("relocked", 6), onboardingStep: "name" }, older),
    ).toBe(true);
    expect(hub.applyAccess(socket, state("unlocked", 5), older)).toBe(true);
    expect(socket).toMatchObject({
      admitted: false,
      access: { accessGeneration: 6, onboardingStep: "done" },
    });
    // …and a result with an older generation, whenever it was read.
    expect(hub.applyAccess(socket, state("unlocked", 5), hub.beginAccessRead())).toBe(true);
    expect(socket).toMatchObject({ admitted: false, access: { accessGeneration: 6 } });
    // A newer generation that admits it applies.
    expect(hub.applyAccess(socket, state("unlocked", 7), hub.beginAccessRead())).toBe(true);
    expect(socket).toMatchObject({ admitted: true, access: { accessGeneration: 7 } });
    // Once admitted, a stale result neither closes nor changes it; a moved generation closes it.
    expect(hub.applyAccess(socket, state("relocked", 6), hub.beginAccessRead())).toBe(true);
    expect(socket).toMatchObject({ admitted: true, access: { accessGeneration: 7 } });
    expect(hub.applyAccess(socket, state("unlocked", 9), hub.beginAccessRead())).toBe(false);

    // A read taken before the user's restriction was noted never raises access, but still closes.
    const identityOnly = hub.connect(
      { send: () => undefined, close: () => undefined, isOpen: () => true },
      { userId: uuidv7(), sessionId: uuidv7(), access: state("locked", 4) },
    );
    const beforeRestriction = hub.beginAccessRead();
    hub.noteAccessChanged(identityOnly.userId);
    expect(hub.applyAccess(identityOnly, state("unlocked", 5), beforeRestriction)).toBe(true);
    expect(identityOnly).toMatchObject({ admitted: false, access: { accessGeneration: 4 } });
    const admittedSocket = hub.connect(
      { send: () => undefined, close: () => undefined, isOpen: () => true },
      { userId: identityOnly.userId, sessionId: uuidv7(), access: state("unlocked", 4) },
    );
    hub.noteAccessChanged(identityOnly.userId);
    expect(hub.applyAccess(admittedSocket, state("relocked", 4), beforeRestriction)).toBe(false);
    expect(hub.applyAccess(identityOnly, state("relocked", 6), hub.beginAccessRead())).toBe(true);
    expect(identityOnly).toMatchObject({ admitted: false, access: { accessGeneration: 6 } });
  });

  it("uses one D1 request for any number of sockets, and runs on its interval", async () => {
    const h = await start({ sweepIntervalMs: 30_000 }, { backgroundLoops: true });
    for (let index = 0; index < 3; index += 1) await h.connect((await h.user()).session);
    const batch = vi.spyOn(h.app.db, "batch");
    await h.sweep.sweep();
    expect(batch).toHaveBeenCalledTimes(1);
    batch.mockClear();
    await h.app.clock.advance(30_000);
    await vi.waitFor(() =>
      expect(
        batch.mock.calls.some(([statements]) => statements[0]?.sql.includes("auth_sessions")),
      ).toBe(true),
    );
    batch.mockRestore();
  });

  it("closes exactly the ended sessions' sockets on logout and the right sockets on restriction", async () => {
    const h = await start();
    const alice = await h.user();
    const aliceOther = await h.app.signIn(alice.id);
    const bob = await h.user();
    const locked = await h.user("locked");
    const aliceA = await h.connect(alice.session);
    const aliceB = await h.connect(aliceOther);
    const bobClient = await h.connect(bob.session);
    const lockedClient = await h.connect(locked.session);

    // A logout for Alice's first session, naming Bob's session id too, closes only Alice's socket.
    await h.control.sessionsEnded({
      userId: alice.id,
      sessionIds: [alice.session.sessionId, bob.session.sessionId],
      reason: "logout",
    });
    expect((await aliceA.closed).code).toBe(4401);
    await aliceB.settle();
    await bobClient.settle();

    await h.control.accessRestricted({ userId: alice.id, reason: "relocked", accessGeneration: 1 });
    expect((await aliceB.closed).code).toBe(4403);

    // A socket that was only at identity level stays open on suspension and is refreshed from D1.
    await h.control.accessRestricted({
      userId: locked.id,
      reason: "suspended",
      accessGeneration: 1,
    });
    await lockedClient.settle();
    expect(h.hub.socketsOfUser(locked.id)).toHaveLength(1);

    // Account deletion closes every socket of the account, identity level included.
    await h.control.accessRestricted({ userId: locked.id, reason: "deleted", accessGeneration: 2 });
    expect((await lockedClient.closed).code).toBe(4403);

    await h.control.sessionsEnded({
      userId: bob.id,
      sessionIds: [bob.session.sessionId],
      reason: "revoked",
    });
    expect((await bobClient.closed).code).toBe(4401);
    expect(h.app.logs.events("realtime.sessions_ended").length).toBeGreaterThan(0);
  });
});

describe("upgrades racing a post-commit hook", () => {
  it("refuses an upgrade whose session lookup was in flight when its session ended or access changed", async () => {
    const h = await start();
    const alice = await h.user();
    const bob = await h.user();
    const original = h.app.sessions.resolveUpgrade.bind(h.app.sessions);
    let pause: Promise<void> = Promise.resolve();
    let lookedUp: () => void = () => undefined;
    vi.spyOn(h.app.sessions, "resolveUpgrade").mockImplementation(async (token, address) => {
      const resolved = await original(token, address);
      lookedUp();
      await pause;
      return resolved;
    });
    const cases = [
      {
        user: alice,
        code: 4401,
        commit: () =>
          h.control.sessionsEnded({
            userId: alice.id,
            sessionIds: [alice.session.sessionId],
            reason: "logout",
          }),
      },
      {
        user: bob,
        code: 4403,
        commit: () =>
          h.control.accessRestricted({ userId: bob.id, reason: "relocked", accessGeneration: 1 }),
      },
    ];
    for (const { user, code, commit } of cases) {
      let release: () => void = () => undefined;
      pause = new Promise<void>((resolve) => {
        release = resolve;
      });
      const read = new Promise<void>((resolve) => {
        lookedUp = resolve;
      });
      const connecting = h.connect(user.session);
      // The session was read as valid; the logout or restriction commits before the socket opens.
      await read;
      await commit();
      release();
      const client = await connecting;
      expect((await client.closed).code).toBe(code);
      expect(h.hub.socketsOfUser(user.id)).toHaveLength(0);
    }
  });

  it("refuses an upgrade answered from a session cache that predates a logout", async () => {
    const h = await start();
    const user = await h.user();
    // The auth_sessions row is untouched, as a cached session lookup would still see it.
    await h.control.sessionsEnded({
      userId: user.id,
      sessionIds: [user.session.sessionId],
      reason: "revoked",
    });
    const client = await h.connect(user.session);
    expect((await client.closed).code).toBe(4401);
    // Once the cache TTL has passed since the logout, the margin no longer applies.
    await h.app.clock.advance(10_001);
    const later = await h.connect(user.session);
    await later.settle();
    expect(h.hub.socketsOfUser(user.id)).toHaveLength(1);
  });

  it("after every session of a user ended, refuses only sockets of sessions created before that", async () => {
    const h = await start();
    const user = await h.user();
    // Sign out everywhere noted on this instance; the cached lookup of the old session is still live.
    await h.app.clock.advance(1_000);
    h.hub.noteSessionsEnded(user.id, "all");
    const old = await h.connect(user.session);
    expect((await old.closed).code).toBe(4401);

    // The user signs in again at once: the new session is younger than the sign-out, so it connects.
    await h.app.clock.advance(1);
    const fresh = await h.app.signIn(user.id);
    const client = await h.connect(fresh);
    await client.settle();
    expect(h.hub.socketsOfUser(user.id)).toHaveLength(1);
    expect(h.hub.socketsOfUser(user.id)[0]?.sessionId).toBe(fresh.sessionId);
  });

  it("refuses a connection verified before its session ended or its access changed", async () => {
    const clock = new FakeClock(1_000_000);
    const hub = new TopicHub({
      registry: new TopicRegistry(),
      access: { satisfies: () => true },
      timers: clock,
      log: new Log(),
    });
    const identity = (
      userId: string,
      sessionId: string,
      sessionCreatedAt = clock.now() - 60_000,
    ): UpgradeSession => ({
      userId,
      sessionId,
      sessionCreatedAt,
      access: {
        emailVerifiedAt: 1,
        betaState: "unlocked",
        suspendedAt: null,
        onboardingStep: "done",
        role: "member",
        accessGeneration: 1,
        accessEpoch: 0,
        deletionState: "none",
      },
    });
    const verifiedAt = clock.now();
    await clock.advance(5);
    hub.noteSessionsEnded("u1", ["s1"]);
    hub.noteSessionsEnded("u2", "all");
    hub.noteAccessChanged("u3");
    expect(hub.staleUpgrade(identity("u1", "s1"), verifiedAt)).toBe(4401);
    expect(hub.staleUpgrade(identity("u1", "s9"), verifiedAt)).toBeNull();
    expect(hub.staleUpgrade(identity("u2", "s2"), verifiedAt)).toBe(4401);
    // A session created after every session of u2 ended is not one of them.
    expect(hub.staleUpgrade(identity("u2", "s3", clock.now()), verifiedAt)).toBe(4401);
    expect(hub.staleUpgrade(identity("u2", "s4", clock.now() + 1), verifiedAt)).toBeNull();
    expect(hub.staleUpgrade(identity("u3", "s3"), verifiedAt)).toBe(4403);
    expect(hub.staleUpgrade(identity("u3", "s3"), clock.now() + 1)).toBeNull();
    await clock.advance(60_001);
    expect(hub.staleUpgrade(identity("u1", "s1"), verifiedAt)).toBeNull();
  });
});

describe("shutdown (§7)", () => {
  it("closes every socket with 1001 through the shutdown coordinator and refuses new upgrades", async () => {
    const h = await start({ shutdownGraceMs: 400 });
    harnesses.splice(harnesses.indexOf(h), 1);
    const user = await h.user();
    const client = await h.connect(user.session);
    await client.settle();
    // A client that never answers the close handshake holds the grace period open.
    const stuck = await rawUpgrade(h.app.wsUrl, h.upgradeHeaders(user.session));
    expect(stuck.status).toBe(101);
    const closing = h.app.close();
    expect((await client.closed).code).toBe(1001);
    expect((await rawUpgrade(h.app.wsUrl, h.upgradeHeaders(user.session))).status).toBe(503);
    await closing;
    stuck.socket?.destroy();
    expect(h.hub.isShuttingDown).toBe(true);
  });
});
