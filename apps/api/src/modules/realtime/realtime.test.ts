import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { Module } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { type AccessState, type ConversationId, conversationTopic } from "@symplist/contracts";
import type { SessionContext } from "@symplist/core/access";
import type { AccessPostCommitHook, BufferedTopicEvent } from "@symplist/core/events";
import {
  applyMigrations,
  createLocalSqliteClient,
  type DbClient,
  int,
  type LocalSqliteClient,
  newWriteId,
  sql,
  uuidv7,
} from "@symplist/db";
import { FakeClock } from "@symplist/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApp } from "../../app.ts";
import type { OperationalLog, OperationalLogFields } from "../../infra/scheduler/runtime.ts";
import { AccessSweep } from "./access-sweep.ts";
import { AuthWsAdapter } from "./auth-ws.adapter.ts";
import { RealtimeModule } from "./realtime.module.ts";
import {
  REALTIME_POST_COMMIT_HOOK,
  REALTIME_PUBLISHER,
  type RealtimeDependencies,
} from "./realtime.tokens.ts";
import { RingBuffer } from "./ring-buffer.ts";
import { type AccessLevelPolicy, RealtimePublishError, TopicHub } from "./topic-hub.ts";
import { TopicRegistry } from "./topic-registry.ts";
import type { WsSessionResolver } from "./upgrade-gate.ts";

/* ------------------------------------------------------------------------------------------------
 * Fixtures
 * --------------------------------------------------------------------------------------------- */

const WEB_ORIGIN = "http://localhost:3000";
const MARKER = "MARKER-7f3a-plaintext-never-logged";

/** The §5.4 guard levels with `BETA_ACCESS_REQUIRED=true`. */
const accessPolicy: AccessLevelPolicy = {
  satisfies(state, level) {
    const identity = state.deletionState === "none";
    if (level === "identity") return identity;
    const admitted =
      identity &&
      state.emailVerifiedAt !== null &&
      state.betaState === "unlocked" &&
      state.suspendedAt === null;
    return level === "admitted" ? admitted : admitted && state.role === "admin";
  },
};

/** Test events: the real composed map is still empty, so these stand in for feature declarations. */
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

interface UserFixture {
  readonly userId: string;
  readonly sessionId: string;
}

async function addUser(
  db: DbClient,
  options: { betaState?: "locked" | "unlocked" | "relocked"; expiresAt?: number } = {},
): Promise<UserFixture> {
  const userId = uuidv7();
  const sessionId = uuidv7();
  const now = Date.now();
  await db.batch([
    sql(
      `INSERT INTO users (id, email, email_verified_at, beta_state, created_at, updated_at, write_id)
       VALUES (:id, :email, :now, :beta, :now, :now, :w)`,
      {
        id: userId,
        email: `${userId}@example.com`,
        now: int(now),
        beta: options.betaState ?? "unlocked",
        w: newWriteId(),
      },
    ),
    sql(
      `INSERT INTO auth_sessions (id, user_id, token_digest, digest_version, created_at, last_seen_at, expires_at, write_id)
       VALUES (:id, :user, :digest, '1', :now, :now, :expires, :w)`,
      {
        id: sessionId,
        user: userId,
        digest: `digest-${sessionId}`,
        now: int(Math.min(now, options.expiresAt ?? now) - 60_000),
        expires: int(options.expiresAt ?? now + 3_600_000),
        w: newWriteId(),
      },
    ),
  ]);
  return { userId, sessionId };
}

async function addSession(db: DbClient, userId: string): Promise<string> {
  const sessionId = uuidv7();
  const now = Date.now();
  await db.run(
    sql(
      `INSERT INTO auth_sessions (id, user_id, token_digest, digest_version, created_at, last_seen_at, expires_at, write_id)
       VALUES (:id, :user, :digest, '1', :now, :now, :expires, :w)`,
      {
        id: sessionId,
        user: userId,
        digest: `digest-${sessionId}`,
        now: int(now - 1),
        expires: int(now + 3_600_000),
        w: newWriteId(),
      },
    ),
  );
  return sessionId;
}

/** Resolves `sym_session=<sessionId>` against D1, as the core session service would. */
function sessionResolver(db: DbClient): WsSessionResolver {
  return {
    async fromUpgradeRequest(request: IncomingMessage): Promise<SessionContext | null> {
      const match = /(?:^|;\s*)sym_session=([0-9a-f-]{36})/.exec(request.headers.cookie ?? "");
      if (!match?.[1]) return null;
      const row = await db.first(
        sql(
          `SELECT s.id, s.user_id, s.revoked_at, s.expires_at, u.email_verified_at, u.beta_state, u.suspended_at,
                  u.onboarding_step, u.role, u.access_generation, u.access_epoch, u.deletion_state
           FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = :id`,
          { id: match[1] },
        ),
      );
      if (!row || row.revoked_at !== null || Number(row.expires_at) <= Date.now()) return null;
      const access: AccessState = {
        emailVerifiedAt: row.email_verified_at === null ? null : Number(row.email_verified_at),
        betaState: row.beta_state as AccessState["betaState"],
        suspendedAt: row.suspended_at === null ? null : Number(row.suspended_at),
        onboardingStep: row.onboarding_step as AccessState["onboardingStep"],
        role: row.role as AccessState["role"],
        accessGeneration: Number(row.access_generation),
        accessEpoch: Number(row.access_epoch),
        deletionState: row.deletion_state as AccessState["deletionState"],
      };
      return { userId: String(row.user_id), sessionId: String(row.id), access };
    },
  };
}

interface Frame {
  readonly t: string;
  readonly [key: string]: unknown;
}

class Client {
  readonly frames: Frame[] = [];
  private readonly listeners = new Set<() => void>();
  readonly closed: Promise<{ code: number; reason: string }>;

  private constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      this.frames.push(JSON.parse(String(event.data)) as Frame);
      for (const listener of this.listeners) listener();
    });
    this.closed = new Promise((resolve) => {
      socket.addEventListener("close", (event) =>
        resolve({ code: event.code, reason: event.reason }),
      );
    });
  }

  static connect(url: string, headers: Record<string, string>): Promise<Client> {
    const socket = new WebSocket(url, { headers } as unknown as string[]);
    const client = new Client(socket);
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(client));
      socket.addEventListener("close", () => reject(new Error("closed before open")));
    });
  }

  send(frame: unknown): void {
    this.socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  /** Resolves with the first frame (seen or future) matching `predicate`, consuming nothing. */
  waitFor(predicate: (frame: Frame) => boolean, timeoutMs = 2_000): Promise<Frame> {
    const found = this.frames.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`No matching frame; received ${JSON.stringify(this.frames)}`));
      }, timeoutMs);
      const check = () => {
        const frame = this.frames.find(predicate);
        if (!frame) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(frame);
      };
      this.listeners.add(check);
    });
  }

  /** Round-trips a ping so every earlier server frame has arrived. */
  async settle(): Promise<void> {
    const before = this.frames.filter((frame) => frame.t === "pong").length;
    this.send({ t: "ping" });
    await this.waitFor(() => this.frames.filter((frame) => frame.t === "pong").length > before);
  }

  close(): void {
    this.socket.close();
  }
}

interface Harness {
  app: NestExpressApplication;
  db: LocalSqliteClient;
  resolver: WsSessionResolver;
  url: string;
  hub: TopicHub;
  registry: TopicRegistry;
  sweep: AccessSweep;
  hook: AccessPostCommitHook;
  log: Log;
  clients: Client[];
  connect(
    user: UserFixture | { sessionId: string },
    headers?: Record<string, string>,
  ): Promise<Client>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    for (const client of harness.clients) client.close();
    await harness.app.close();
    harness.db.close();
  }
});

async function start(
  tuning: RealtimeDependencies["tuning"] = {},
  options: { readonly resolver?: (db: DbClient) => WsSessionResolver } = {},
): Promise<Harness> {
  const db = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
  await applyMigrations(db);
  const log = new Log();
  const resolver = (options.resolver ?? sessionResolver)(db);

  @Module({
    imports: [
      RealtimeModule.forRoot({
        useFactory: (): RealtimeDependencies => ({
          db,
          sessions: resolver,
          access: accessPolicy,
          allowedOrigins: [WEB_ORIGIN],
          log,
          events: testEvents,
          tuning: { sweepIntervalMs: 3_600_000, ...tuning },
        }),
      }),
    ],
  })
  class TestModule {}

  const app = await createApp(TestModule, { logger: ["error"] });
  app.useWebSocketAdapter(new AuthWsAdapter(app));
  await app.listen(0, "127.0.0.1");
  const url = `${(await app.getUrl()).replace("http", "ws")}/v1/ws`;
  const clients: Client[] = [];
  const harness: Harness = {
    app,
    db,
    resolver,
    url,
    hub: app.get(TopicHub),
    registry: app.get(TopicRegistry),
    sweep: app.get(AccessSweep),
    hook: app.get(REALTIME_POST_COMMIT_HOOK),
    log,
    clients,
    async connect(user, headers = {}) {
      const client = await Client.connect(url, {
        origin: WEB_ORIGIN,
        cookie: `sym_session=${user.sessionId}`,
        ...headers,
      });
      clients.push(client);
      return client;
    },
  };
  harnesses.push(harness);
  return harness;
}

/** A raw upgrade request, to observe HTTP statuses and to act as a client that never answers pings. */
function rawUpgrade(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; socket?: Socket }> {
  const target = new URL(url.replace("ws", "http"));
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"),
        ...headers,
      },
    });
    request.on("response", (response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0 });
    });
    request.on("upgrade", (response, socket) =>
      resolve({ status: response.statusCode ?? 0, socket }),
    );
    request.on("error", reject);
    request.end();
  });
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

describe("WebSocket upgrade authentication (§7)", () => {
  it("rejects a missing or foreign Origin with 403 before looking at the session", async () => {
    const h = await start();
    const user = await addUser(h.db);
    const resolve = vi.spyOn(h.resolver, "fromUpgradeRequest");
    expect((await rawUpgrade(h.url, { cookie: `sym_session=${user.sessionId}` })).status).toBe(403);
    expect(
      (
        await rawUpgrade(h.url, {
          origin: "https://artifact.example.com",
          cookie: `sym_session=${user.sessionId}`,
        })
      ).status,
    ).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
    const accepted = await rawUpgrade(h.url, {
      origin: WEB_ORIGIN,
      cookie: `sym_session=${user.sessionId}`,
    });
    accepted.socket?.destroy();
    expect(accepted.status).toBe(101);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing, revoked or expired session with 401 and ignores bearer tokens", async () => {
    const h = await start();
    const revoked = await addUser(h.db);
    await h.db.run(
      sql("UPDATE auth_sessions SET revoked_at = 1 WHERE id = :id", { id: revoked.sessionId }),
    );
    const expired = await addUser(h.db, { expiresAt: Date.now() - 1 });
    expect((await rawUpgrade(h.url, { origin: WEB_ORIGIN })).status).toBe(401);
    expect(
      (
        await rawUpgrade(h.url, {
          origin: WEB_ORIGIN,
          authorization: `Bearer ${revoked.sessionId}`,
        })
      ).status,
    ).toBe(401);
    expect(
      (await rawUpgrade(h.url, { origin: WEB_ORIGIN, cookie: `sym_session=${revoked.sessionId}` }))
        .status,
    ).toBe(401);
    expect(
      (await rawUpgrade(h.url, { origin: WEB_ORIGIN, cookie: `sym_session=${expired.sessionId}` }))
        .status,
    ).toBe(401);
  });

  it("rejects an account being deleted with 403", async () => {
    const h = await start();
    const user = await addUser(h.db);
    await h.db.run(
      sql(
        "UPDATE users SET deletion_state = 'deleting', deletion_requested_at = 1 WHERE id = :id",
        { id: user.userId },
      ),
    );
    expect(
      (await rawUpgrade(h.url, { origin: WEB_ORIGIN, cookie: `sym_session=${user.sessionId}` }))
        .status,
    ).toBe(403);
  });

  it("accepts a valid session and records the socket's user and session", async () => {
    const h = await start();
    const user = await addUser(h.db);
    const client = await h.connect(user);
    await client.settle();
    const [socket] = h.hub.socketsOfSession(user.sessionId);
    expect(socket).toMatchObject({
      userId: user.userId,
      sessionId: user.sessionId,
      admitted: true,
    });
    expect(h.hub.socketsOfUser(user.userId)).toHaveLength(1);
  });
});

describe("frames (§7)", () => {
  it("answers ping with pong and malformed, unknown or binary frames with a validation error", async () => {
    const h = await start();
    const client = await h.connect(await addUser(h.db));
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
    const user = await addUser(h.db);
    h.registry.registerAuthorizer({
      kind: "conversation",
      authorize: () => new Promise((resolve) => setTimeout(() => resolve(true), 30)),
    });
    const client = await h.connect(user);
    const topic = conversationTopic(uuidv7() as ConversationId);
    client.send({ t: "sub", topic, cursor: null });
    client.send({ t: "unsub", topic });
    await client.settle();
    expect(h.hub.socketsOfUser(user.userId)[0]?.subscriptionCount).toBe(0);
  });

  it("closes with 1008 after more than 20 frames in 10 seconds", async () => {
    const h = await start();
    const client = await h.connect(await addUser(h.db));
    for (let index = 0; index < 21; index += 1) client.send({ t: "ping" });
    expect((await client.closed).code).toBe(1008);
  });

  it("closes with 1008 above 50 subscriptions", async () => {
    const h = await start({ framesPerWindow: 100 });
    const user = await addUser(h.db);
    h.registry.registerAuthorizer({ kind: "conversation", authorize: async () => true });
    const client = await h.connect(user);
    for (let index = 0; index < 50; index += 1) {
      client.send({ t: "sub", topic: conversationTopic(uuidv7() as ConversationId), cursor: null });
    }
    await client.settle();
    expect(h.hub.socketsOfUser(user.userId)[0]?.subscriptionCount).toBe(50);
    client.send({ t: "sub", topic: conversationTopic(uuidv7() as ConversationId), cursor: null });
    expect((await client.closed).code).toBe(1008);
  });

  it("pings every heartbeat interval and terminates a client that never answers", async () => {
    const h = await start({ heartbeatIntervalMs: 60 });
    const user = await addUser(h.db);
    const { status, socket } = await rawUpgrade(h.url, {
      origin: WEB_ORIGIN,
      cookie: `sym_session=${user.sessionId}`,
    });
    expect(status).toBe(101);
    const opcodes: number[] = [];
    socket?.on("data", (chunk: Buffer) => opcodes.push((chunk[0] ?? 0) & 0x0f));
    await new Promise<void>((resolve) => socket?.on("close", () => resolve()));
    expect(opcodes).toContain(0x9);
    expect(h.hub.socketsOfUser(user.userId)).toHaveLength(0);
  });
});

describe("user topic (§7)", () => {
  it("sends an admitted socket the composed snapshot and then its user events", async () => {
    const h = await start();
    const user = await addUser(h.db);
    const other = await addUser(h.db);
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
    const client = await h.connect(user);
    const otherClient = await h.connect(other);
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

    await h.hub.publishToUser(user.userId, {
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
    const locked = await addUser(h.db, { betaState: "locked" });
    const contributor = vi.fn(async () => ({ unreadCount: 99 }));
    h.registry.registerUserSnapshotContributor({ name: "scheduling", contribute: contributor });
    const client = await h.connect(locked);
    client.send({ t: "sub", topic: "user", cursor: null, openTasks: [] });
    const snapshot = await client.waitFor((frame) => frame.t === "snapshot");
    expect(snapshot.data).toEqual({
      unreadCount: 0,
      taskTreeVersion: 0,
      heads: {},
      vaultUnlocked: false,
    });
    expect(contributor).not.toHaveBeenCalled();

    await h.hub.publishToUser(locked.userId, {
      type: "tasks.changed",
      data: { taskTreeVersion: 1, taskIds: [] },
    });
    await h.hub.publishToUser(locked.userId, {
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
    const publisher = h.app.get(REALTIME_PUBLISHER) as TopicHub;
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
    const alice = await addUser(h.db);
    const bob = await addUser(h.db);
    const locked = await addUser(h.db, { betaState: "locked" });
    const aliceConversation = uuidv7() as ConversationId;
    const lockedConversation = uuidv7() as ConversationId;
    const owners = new Map([
      [aliceConversation, alice.userId],
      [lockedConversation, locked.userId],
    ]);

    const bobClient = await h.connect(bob);
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

    const lockedClient = await h.connect(locked);
    lockedClient.send({ t: "sub", topic: conversationTopic(lockedConversation), cursor: null });
    await lockedClient.waitFor((frame) => frame.t === "err");
    expect(lockedClient.frames).toEqual([{ t: "err", code: "not_found" }]);
    expect(authorize.mock.calls.every(([socket]) => socket.userId === bob.userId)).toBe(true);
  });

  it("delivers conversation events to the owner only, snapshots with the live partial, and replays from a cursor", async () => {
    const h = await start({ bufferCapacity: 3 });
    const alice = await addUser(h.db);
    const bob = await addUser(h.db);
    const conversation = uuidv7() as ConversationId;
    const topic = conversationTopic(conversation);
    h.registry.registerAuthorizer(ownedConversations(new Map([[conversation, alice.userId]])));
    const liveSeen: BufferedTopicEvent[][] = [];
    h.registry.registerSnapshotProvider({
      kind: "conversation",
      snapshot: async (_socket, parsed, live) => {
        liveSeen.push([...live]);
        return { conversationId: parsed.conversationId, messages: [] };
      },
    });
    const audience = { ownerId: alice.userId, conversationId: conversation };
    const chunk = (index: number) => ({
      type: "chunk",
      data: { runId: "r", chunk: { type: "text-delta", delta: `${MARKER}-${index}` } },
    });

    await h.hub.publishToConversation(audience, chunk(1));
    const alice1 = await h.connect(alice);
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
    const alice2 = await h.connect(alice);
    alice2.send({ t: "sub", topic, cursor });
    await alice2.waitFor((frame) => frame.t === "ev");
    await alice2.settle();
    expect(alice2.frames.filter((frame) => frame.t !== "pong").map((frame) => frame.seq)).toEqual([
      events[1]?.seq,
    ]);

    // Cursors outside the buffer, ahead of the topic or from an earlier process get a snapshot.
    for (const index of [4, 5, 6]) await h.hub.publishToConversation(audience, chunk(index));
    for (const stale of [cursor, (h.hub.topicSeq(topic) as number) + 5, 12]) {
      const client = await h.connect(alice);
      client.send({ t: "sub", topic, cursor: stale });
      await client.waitFor((frame) => frame.t === "snapshot");
    }

    // Bob, even subscribed through a permissive mistake, never receives Alice's events.
    const bobClient = await h.connect(bob);
    bobClient.send({ t: "sub", topic, cursor: null });
    await bobClient.waitFor((frame) => frame.t === "err");
    await h.hub.publishToConversation(
      { ownerId: bob.userId, conversationId: conversation },
      chunk(7),
    );
    await bobClient.settle();
    expect(bobClient.frames.filter((frame) => frame.t === "ev")).toEqual([]);
    expect(h.log.lines.some((line) => line.includes("realtime.owner_mismatch"))).toBe(true);

    expect(h.log.lines.join("\n")).not.toContain(MARKER);
  });

  it("sends resync when no snapshot provider exists and queues events published while a snapshot is built", async () => {
    const h = await start();
    const alice = await addUser(h.db);
    const conversation = uuidv7() as ConversationId;
    const topic = conversationTopic(conversation);
    h.registry.registerAuthorizer(ownedConversations(new Map([[conversation, alice.userId]])));
    const client = await h.connect(alice);
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
    const second = await h.connect(alice);
    second.send({ t: "sub", topic, cursor: null });
    await providerCalled;
    await h.hub.publishToConversation(
      { ownerId: alice.userId, conversationId: conversation },
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
    const revoked = await addUser(h.db);
    const relocked = await addUser(h.db);
    const expiring = await addUser(h.db);
    const locked = await addUser(h.db, { betaState: "locked" });
    const clients = {
      revoked: await h.connect(revoked),
      relocked: await h.connect(relocked),
      expiring: await h.connect(expiring),
      locked: await h.connect(locked),
    };
    await h.db.batch([
      sql("UPDATE auth_sessions SET revoked_at = 1 WHERE id = :id", { id: revoked.sessionId }),
      sql("UPDATE auth_sessions SET expires_at = :t WHERE id = :id", {
        id: expiring.sessionId,
        t: int(Date.now() - 1),
      }),
      sql(
        "UPDATE users SET beta_state = 'relocked', access_generation = access_generation + 1 WHERE id = :id",
        { id: relocked.userId },
      ),
      sql(
        "UPDATE users SET suspended_at = 1, access_generation = access_generation + 1 WHERE id = :id",
        { id: locked.userId },
      ),
    ]);
    const report = await h.sweep.sweep();
    expect(report).toEqual({ checked: 4, closedSession: 2, closedAccess: 1 });
    expect((await clients.revoked.closed).code).toBe(4401);
    expect((await clients.expiring.closed).code).toBe(4401);
    expect((await clients.relocked.closed).code).toBe(4403);
    await clients.locked.settle();
    expect(h.hub.socketsOfUser(locked.userId)[0]?.access.suspendedAt).toBe(1);
  });

  it("closes an admitted socket whose access generation moved, even when access was restored", async () => {
    const h = await start();
    const restored = await addUser(h.db);
    const steady = await addUser(h.db);
    const locked = await addUser(h.db, { betaState: "locked" });
    const clients = {
      restored: await h.connect(restored),
      steady: await h.connect(steady),
      locked: await h.connect(locked),
    };
    // A relock and a restore committed on another instance: admitted again, one generation later.
    await h.db.batch([
      sql("UPDATE users SET access_generation = access_generation + 2 WHERE id = :id", {
        id: restored.userId,
      }),
      sql(
        "UPDATE users SET beta_state = 'unlocked', access_generation = access_generation + 1 WHERE id = :id",
        { id: locked.userId },
      ),
    ]);
    expect(await h.sweep.sweep()).toEqual({ checked: 3, closedSession: 0, closedAccess: 1 });
    expect((await clients.restored.closed).code).toBe(4403);
    await clients.steady.settle();
    await clients.locked.settle();
    // A socket that was only at identity level is refreshed instead: it is admitted from now on.
    expect(h.hub.socketsOfUser(locked.userId)[0]).toMatchObject({ admitted: true });
    expect(await h.sweep.sweep()).toEqual({ checked: 2, closedSession: 0, closedAccess: 0 });
  });

  it("uses one D1 request for any number of sockets", async () => {
    const h = await start();
    for (let index = 0; index < 3; index += 1) await h.connect(await addUser(h.db));
    const batch = vi.spyOn(h.db, "batch");
    await h.sweep.sweep();
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("closes exactly the ended sessions' sockets on logout and admitted sockets on restriction", async () => {
    const h = await start();
    const alice = await addUser(h.db);
    const aliceOtherSession = await addSession(h.db, alice.userId);
    const bob = await addUser(h.db);
    const locked = await addUser(h.db, { betaState: "locked" });
    const aliceA = await h.connect(alice);
    const aliceB = await h.connect({ sessionId: aliceOtherSession });
    const bobClient = await h.connect(bob);
    const lockedClient = await h.connect(locked);

    // A logout for Alice's first session, naming Bob's session id too, closes only Alice's socket.
    await h.hook.onSessionsEnded({
      userId: alice.userId,
      sessionIds: [alice.sessionId, bob.sessionId],
      reason: "logout",
    });
    expect((await aliceA.closed).code).toBe(4401);
    await aliceB.settle();
    await bobClient.settle();

    await h.hook.onAccessRestricted({
      userId: alice.userId,
      reason: "relocked",
      cancelledRunIds: [],
    });
    expect((await aliceB.closed).code).toBe(4403);

    await h.hook.onAccessRestricted({
      userId: locked.userId,
      reason: "suspended",
      cancelledRunIds: [],
    });
    await lockedClient.settle();
    expect(h.hub.socketsOfUser(locked.userId)).toHaveLength(1);

    await h.hook.onSessionsEnded({ userId: bob.userId, sessionIds: "all", reason: "deleted" });
    expect((await bobClient.closed).code).toBe(4401);
  });
});

describe("upgrades racing a post-commit hook", () => {
  it("refuses an upgrade whose session lookup was in flight when its session ended or access changed", async () => {
    let pause: Promise<void> = Promise.resolve();
    let lookedUp: () => void = () => undefined;
    const h = await start(
      {},
      {
        resolver: (db) => {
          const inner = sessionResolver(db);
          return {
            async fromUpgradeRequest(request) {
              const session = await inner.fromUpgradeRequest(request);
              lookedUp();
              await pause;
              return session;
            },
          };
        },
      },
    );
    const alice = await addUser(h.db);
    const bob = await addUser(h.db);
    const cases = [
      {
        user: alice,
        code: 4401,
        commit: () =>
          h.hook.onSessionsEnded({
            userId: alice.userId,
            sessionIds: [alice.sessionId],
            reason: "logout",
          }),
      },
      {
        user: bob,
        code: 4403,
        commit: () =>
          h.hook.onAccessRestricted({
            userId: bob.userId,
            reason: "relocked",
            cancelledRunIds: [],
          }),
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
      const connecting = h.connect(user);
      // The session was read as valid; the logout or restriction commits before the socket opens.
      await read;
      await commit();
      await new Promise((resolve) => setTimeout(resolve, 5));
      release();
      const client = await connecting;
      expect((await client.closed).code).toBe(code);
      expect(h.hub.socketsOfUser(user.userId)).toHaveLength(0);
    }
  });

  it("refuses an upgrade answered from a session cache that predates a logout", async () => {
    const h = await start();
    const user = await addUser(h.db);
    // The auth_sessions row is untouched, as a cached session lookup would still see it.
    await h.hook.onSessionsEnded({
      userId: user.userId,
      sessionIds: [user.sessionId],
      reason: "revoked",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const client = await h.connect(user);
    expect((await client.closed).code).toBe(4401);
  });

  it("refuses a connection verified before its session ended or its access changed", async () => {
    const clock = new FakeClock(1_000_000);
    const hub = new TopicHub({
      registry: new TopicRegistry(),
      access: accessPolicy,
      timers: clock,
      log: new Log(),
    });
    const identity = (userId: string, sessionId: string): SessionContext => ({
      userId,
      sessionId,
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
    expect(hub.staleUpgrade(identity("u3", "s3"), verifiedAt)).toBe(4403);
    expect(hub.staleUpgrade(identity("u3", "s3"), clock.now() + 1)).toBeNull();
    await clock.advance(60_001);
    expect(hub.staleUpgrade(identity("u1", "s1"), verifiedAt)).toBeNull();
  });
});

describe("shutdown (§7)", () => {
  it("closes every socket with 1001 and refuses new upgrades", async () => {
    const h = await start({ shutdownGraceMs: 400 });
    const user = await addUser(h.db);
    const client = await h.connect(user);
    await client.settle();
    // A client that never answers the close handshake holds the grace period open.
    const stuck = await rawUpgrade(h.url, {
      origin: WEB_ORIGIN,
      cookie: `sym_session=${user.sessionId}`,
    });
    expect(stuck.status).toBe(101);
    const closing = h.app.close();
    expect((await client.closed).code).toBe(1001);
    expect(
      (await rawUpgrade(h.url, { origin: WEB_ORIGIN, cookie: `sym_session=${user.sessionId}` }))
        .status,
    ).toBe(503);
    await closing;
    stuck.socket?.destroy();
    harnesses.splice(harnesses.indexOf(h), 1);
    h.db.close();
  });
});
