import {
  errorEnvelopeSchema,
  simonConversationCreatedSchema,
  simonConversationViewSchema,
  simonMessageAcceptedSchema,
  simonRunViewSchema,
  taskCreateResponseSchema,
} from "@symplist/contracts";
import { SimonApprovals, SimonRepository, SimonUserAsks, SimonViews } from "@symplist/core/simon";
import { zeroize } from "@symplist/crypto";
import { int, sql, uuidv7 } from "@symplist/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootTestApp,
  type RequestOptions,
  type TestApp,
  type TestSession,
} from "../../../test/harness.ts";
import { WsTestClient } from "../../../test/ws-client.ts";
import { ExecutionDispatcher } from "../../infra/executors/dispatcher.ts";
import { IP_LIMIT_METADATA } from "../../infra/limits/ip-limits.ts";
import { TopicHub } from "../realtime/topic-hub.ts";
import { SimonController } from "./simon.controller.ts";

const apps: TestApp[] = [];
const sockets: WsTestClient[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});

it("rate-limits Simon submissions before they can create D1 or model work", () => {
  expect(Reflect.getMetadata(IP_LIMIT_METADATA, SimonController.prototype.message)).toEqual([
    "simon_submit",
  ]);
});

describe("Simon conversation history and realtime", () => {
  it("detaches if a quick chat expires between authorization and snapshot loading", async () => {
    const app = await boot();
    const { session } = await app.createSignedInUser();
    const { conversationId, runId } = await question(app, session);
    const hub = app.app.get(TopicHub);
    const read = SimonViews.prototype.conversation;
    vi.spyOn(SimonViews.prototype, "conversation").mockImplementationOnce(async function (
      this: SimonViews,
      ...args
    ) {
      await hub.publishToConversation(
        { ownerId: session.userId, conversationId },
        {
          type: "chunk",
          data: {
            runId,
            chunk: { type: "text-delta", id: "text", delta: "expired-private-marker" },
          },
        },
      );
      await app.db.run(
        sql("UPDATE conversations SET expires_at = :now WHERE id = :id", {
          id: conversationId,
          now: int(app.clock.now()),
        }),
      );
      return read.apply(this, args);
    });
    const socket = await WsTestClient.connect(app.wsUrl, {
      origin: app.config.WEB_ORIGIN,
      cookie: session.cookie,
    });
    sockets.push(socket);
    socket.send({ t: "sub", topic: `conversation:${conversationId}`, cursor: null });
    expect(await socket.waitFor((frame) => frame.t === "err")).toMatchObject({ code: "not_found" });
    await socket.settle();
    expect(socket.frames.filter((frame) => frame.t === "ev" || frame.t === "snapshot")).toEqual([]);
    expect(JSON.stringify(socket.frames)).not.toContain("expired-private-marker");
  });
  it("reads owner history, pending questions and strict history cursors", async () => {
    const app = await boot();
    const { session } = await app.createSignedInUser();
    const { session: stranger } = await app.createSignedInUser();
    const { conversationId, askId, runId } = await question(app, session);
    const response = await app.get(`/v1/conversations/${conversationId}`, { session });
    expect(response.status).toBe(200);
    const view = simonConversationViewSchema.parse(response.json());
    expect(view).toMatchObject({
      pendingAskId: askId,
      activeRun: { runId, status: "awaiting_user" },
    });
    expect(view.messages).toHaveLength(2);
    const older = await app.get(`/v1/conversations/${conversationId}?beforeSeq=2`, { session });
    expect(
      simonConversationViewSchema.parse(older.json()).messages.map((message) => message.seq),
    ).toEqual([1]);
    expect(
      (await app.get(`/v1/conversations/${conversationId}?beforeSeq=-1`, { session })).status,
    ).toBe(400);
    expect(
      (await app.get(`/v1/conversations/${conversationId}?ownerId=${session.userId}`, { session }))
        .status,
    ).toBe(400);
    expect(
      (await app.get(`/v1/conversations/${conversationId}`, { session: stranger })).status,
    ).toBe(404);
  });

  it("authorizes real conversations, snapshots the active run tail and replays only newer frames", async () => {
    const app = await boot();
    const { session } = await app.createSignedInUser();
    const { session: stranger } = await app.createSignedInUser();
    const { conversationId, runId } = await question(app, session);
    const hub = app.app.get(TopicHub);
    const audience = { ownerId: session.userId, conversationId };
    const publish = (delta: string, id = runId) =>
      hub.publishToConversation(audience, {
        type: "chunk",
        data: { runId: id, chunk: { type: "text-delta", id: "text_1", delta } },
      });
    await publish("unrelated-old-run", uuidv7());
    await publish("live-marker-one");
    const connect = async (identity: TestSession) => {
      const socket = await WsTestClient.connect(app.wsUrl, {
        origin: app.config.WEB_ORIGIN,
        cookie: identity.cookie,
      });
      sockets.push(socket);
      return socket;
    };
    const topic = `conversation:${conversationId}`;
    const foreign = await connect(stranger);
    foreign.send({ t: "sub", topic, cursor: null });
    expect(await foreign.waitFor((frame) => frame.t === "err")).toMatchObject({
      code: "not_found",
    });
    const socket = await connect(session);
    socket.send({ t: "sub", topic, cursor: null });
    const snapshot = await socket.waitFor((frame) => frame.t === "snapshot");
    expect(snapshot).toMatchObject({
      data: {
        conversationId,
        activeRun: { runId },
        live: [{ type: "chunk", data: { runId, chunk: { delta: "live-marker-one" } } }],
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("unrelated-old-run");
    await publish("live-marker-two");
    const event = await socket.waitFor((frame) => frame.t === "ev");
    expect(event).toMatchObject({ data: { chunk: { delta: "live-marker-two" } } });
    const reconnect = await connect(session);
    reconnect.send({ t: "sub", topic, cursor: snapshot.seq });
    expect(await reconnect.waitFor((frame) => frame.t === "ev")).toMatchObject({
      seq: event.seq,
      data: event.data,
    });
    expect(reconnect.frames.filter((frame) => frame.t === "ev")).toHaveLength(1);
    expect(app.logs.text()).not.toContain("live-marker");
  });
});
async function boot() {
  const app = await bootTestApp();
  apps.push(app);
  return app;
}
const key = () => uuidv7();
function post(
  app: TestApp,
  session: TestSession,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
) {
  return app.post(path, {
    session,
    idempotencyKey: key(),
    ...(body === undefined ? {} : { body }),
    ...options,
  });
}
async function quick(app: TestApp, session: TestSession) {
  const response = await post(app, session, "/v1/conversations", { kind: "quick" });
  expect(response.status, response.text).toBe(201);
  return simonConversationCreatedSchema.parse(response.json()).conversationId;
}
const code = (response: { json(): unknown }) =>
  errorEnvelopeSchema.parse(response.json()).error.code;

async function question(app: TestApp, session: TestSession) {
  const conversationId = await quick(app, session);
  const response = await post(app, session, `/v1/conversations/${conversationId}/messages`, {
    text: "Please ask",
  });
  const runId = simonMessageAcceptedSchema.parse(response.json()).runId;
  const repository = app.app.get(SimonRepository);
  const claim = await repository.claim(runId ?? "", "local");
  if (!claim) throw new Error("Expected local claim");
  try {
    const askId = await new SimonUserAsks(repository).pause(
      claim.run,
      claim.key,
      { question: "private-question-marker", toolCallId: "ask_1" },
      { text: "A question", steps: 1 },
    );
    return { askId, runId, conversationId };
  } finally {
    zeroize(claim.key.key);
  }
}

async function approval(app: TestApp, session: TestSession) {
  const conversationId = await quick(app, session);
  const sent = await post(app, session, `/v1/conversations/${conversationId}/messages`, {
    text: "Please send",
  });
  const runId = simonMessageAcceptedSchema.parse(sent.json()).runId;
  const repository = app.app.get(SimonRepository);
  const claim = await repository.claim(runId ?? "", "local");
  if (!claim) throw new Error("Expected claim");
  const connectionId = uuidv7();
  await app.db.run(
    sql(
      `INSERT INTO connections (id, owner_id, toolkit, connected_account_id,
    status, confirmed_at, created_at, updated_at, write_id)
    VALUES (:id, :owner, 'gmail', 'ca_http', 'active', :now, :now, :now, :id)`,
      { id: connectionId, owner: session.userId, now: int(app.clock.now()) },
    ),
  );
  try {
    const approvals = new SimonApprovals(repository);
    const id = await approvals.pause(
      claim.run,
      claim.key,
      {
        toolCallId: "send_1",
        toolSlug: "GMAIL_SEND_EMAIL",
        connection: {
          id: connectionId,
          ownerId: session.userId,
          toolkit: "gmail",
          connectedAccountId: "ca_http",
          generation: 1,
        },
        arguments: { body: "approval-http-private-marker" },
        preview: { body: "approval-http-private-marker" },
        policyVersion: "test.1",
      },
      { text: "Review the send", steps: 1 },
    );
    return { id, conversationId, runId, view: await approvals.load(session.userId, id) };
  } finally {
    zeroize(claim.key.key);
  }
}

describe("Simon approval HTTP decisions", () => {
  it("refuses a revoked session even if its ordinary read cache is warm", async () => {
    const app = await boot();
    const { session } = await app.createSignedInUser();
    const { id, view } = await approval(app, session);
    expect((await app.get(`/v1/approvals/${id}`, { session })).status).toBe(200);
    await app.db.run(
      sql("UPDATE auth_sessions SET revoked_at = :now WHERE user_id = :owner", {
        owner: session.userId,
        now: int(app.clock.now()),
      }),
    );
    const result = await post(app, session, `/v1/approvals/${id}/decision`, {
      decision: "approve",
      argDigest: view.argDigest,
    });
    expect(result.status).toBe(401);
    expect(
      (await app.db.first(sql("SELECT status FROM approvals WHERE id = :id", { id })))?.status,
    ).toBe("pending");
    expect(await app.db.all(sql("SELECT id FROM runs"))).toHaveLength(1);
  });
  it.each(["approve", "deny", "dismiss"] as const)(
    "records and replays %s exactly once",
    async (decision) => {
      const app = await boot();
      const { session } = await app.createSignedInUser();
      const { id, view, conversationId } = await approval(app, session);
      const read = await app.get(`/v1/approvals/${id}`, { session });
      expect(read.status).toBe(200);
      expect(read.json()).toMatchObject({
        id,
        status: "pending",
        arguments: { body: "approval-http-private-marker" },
      });
      const chat = await post(app, session, `/v1/conversations/${conversationId}/messages`, {
        text: "yes approve",
      });
      expect(simonMessageAcceptedSchema.parse(chat.json()).status).toBe("queued");
      const decisionKey = key();
      const body = { decision, argDigest: view.argDigest };
      const first = await post(app, session, `/v1/approvals/${id}/decision`, body, {
        idempotencyKey: decisionKey,
      });
      expect(first.status, first.text).toBe(200);
      expect(first.json()).toMatchObject({
        approvalId: id,
        status: decision === "approve" ? "approved" : decision === "deny" ? "denied" : "dismissed",
      });
      const replay = await post(app, session, `/v1/approvals/${id}/decision`, body, {
        idempotencyKey: decisionKey,
      });
      expect(replay.status).toBe(200);
      expect(replay.json()).toEqual(first.json());
      const stale = await post(app, session, `/v1/approvals/${id}/decision`, body);
      expect(stale.status).toBe(409);
      expect(code(stale)).toBe("approval.stale");
      expect(app.logs.lines.join("\n")).not.toContain("approval-http-private-marker");
    },
  );

  it("enforces owner identity, CSRF, strict arguments and quick-chat expiry", async () => {
    const app = await boot();
    const { session } = await app.createSignedInUser();
    const { session: stranger } = await app.createSignedInUser();
    const { id, view } = await approval(app, session);
    const body = { decision: "approve", argDigest: view.argDigest };
    expect((await app.get(`/v1/approvals/${id}`, { session: stranger })).status).toBe(404);
    expect((await post(app, stranger, `/v1/approvals/${id}/decision`, body)).status).toBe(404);
    expect(
      (await post(app, session, `/v1/approvals/${id}/decision`, body, { csrf: null })).status,
    ).toBe(403);
    expect(
      (
        await post(app, session, `/v1/approvals/${id}/decision`, {
          ...body,
          ownerId: stranger.userId,
        })
      ).status,
    ).toBe(400);
    await app.clock.advance(24 * 3_600_000);
    expect((await app.get(`/v1/approvals/${id}`, { session })).status).toBe(404);
  });
});

describe("Simon user questions", () => {
  it("queues an ordinary reply and answers only through the explicit idempotent endpoint", async () => {
    const app = await boot();
    const { session } = await app.createSignedInUser();
    const { askId, runId, conversationId } = await question(app, session);
    const queued = await post(app, session, `/v1/conversations/${conversationId}/messages`, {
      text: "ordinary reply",
    });
    expect(simonMessageAcceptedSchema.parse(queued.json())).toMatchObject({
      status: "queued",
      runId: null,
    });
    const before = await app.get(`/v1/user-asks/${askId}`, { session });
    expect(before.status).toBe(200);
    expect(before.json()).toMatchObject({
      status: "pending",
      question: "private-question-marker",
      answer: null,
    });
    const answerKey = key();
    const send = () =>
      post(
        app,
        session,
        `/v1/user-asks/${askId}/answer`,
        { text: "private-answer-marker" },
        { idempotencyKey: answerKey },
      );
    const responses = await Promise.all([send(), send(), send()]);
    for (const response of responses) {
      expect(response.status, response.text).toBe(200);
      expect(response.json()).toEqual(responses[0]?.json());
    }
    const next = responses[0]?.json<{ runId: string }>().runId;
    expect(next).not.toBe(runId);
    expect(
      (
        await app.db.first(
          sql("SELECT active_run_id FROM conversations WHERE id = :id", { id: conversationId }),
        )
      )?.active_run_id,
    ).toBe(next);
    expect(await app.db.all(sql("SELECT id FROM runs"))).toHaveLength(2);
    expect(await app.db.all(sql("SELECT id FROM messages WHERE status = 'queued'"))).toHaveLength(
      1,
    );
    const replay = await send();
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    const mismatch = await post(
      app,
      session,
      `/v1/user-asks/${askId}/answer`,
      { text: "changed answer" },
      { idempotencyKey: answerKey },
    );
    expect(code(mismatch)).toBe("idempotency.mismatch");
    expect((await app.get(`/v1/user-asks/${askId}`, { session })).json()).toMatchObject({
      status: "answered",
      answer: "private-answer-marker",
    });
    for (const marker of ["private-question-marker", "private-answer-marker"]) {
      expect(app.logs.text()).not.toContain(marker);
      expect(JSON.stringify(await app.db.all(sql("SELECT * FROM user_asks")))).not.toContain(
        marker,
      );
      expect(
        JSON.stringify(await app.db.all(sql("SELECT * FROM idempotency_records"))),
      ).not.toContain(marker);
    }
  });
  it("dismisses once, refuses a later answer, and keeps foreign and expired questions private", async () => {
    const app = await boot();
    const { session } = await app.createSignedInUser();
    const { askId, conversationId } = await question(app, session);
    const stranger = await app.createSignedInUser();
    expect(code(await app.get(`/v1/user-asks/${askId}`, { session: stranger.session }))).toBe(
      "not_found",
    );
    expect(code(await post(app, stranger.session, `/v1/user-asks/${askId}/dismiss`))).toBe(
      "not_found",
    );
    expect(
      code(
        await post(
          app,
          session,
          `/v1/user-asks/${askId}/answer`,
          { text: "answer" },
          { csrf: null },
        ),
      ),
    ).toBe("auth.csrf_invalid");
    const dismissKey = key();
    const dismissed = await post(app, session, `/v1/user-asks/${askId}/dismiss`, undefined, {
      idempotencyKey: dismissKey,
    });
    expect(dismissed.status, dismissed.text).toBe(200);
    expect(
      (
        await post(app, session, `/v1/user-asks/${askId}/dismiss`, undefined, {
          idempotencyKey: dismissKey,
        })
      ).json(),
    ).toEqual(dismissed.json());
    expect(
      code(await post(app, session, `/v1/user-asks/${askId}/answer`, { text: "too late" })),
    ).toBe("user_ask.stale");
    expect(await app.db.all(sql("SELECT id FROM runs"))).toHaveLength(2);
    await app.db.run(
      sql("UPDATE conversations SET expires_at = 1 WHERE id = :id", { id: conversationId }),
    );
    expect(code(await app.get(`/v1/user-asks/${askId}`, { session }))).toBe("not_found");
  });
});

describe("Simon conversation commands", () => {
  it("creates a quick chat, accepts and queues messages, stops, and exposes only the public run view", async () => {
    const app = await boot();
    const user = await app.createSignedInUser();
    const conversation = await quick(app, user.session);
    const path = `/v1/conversations/${conversation}/messages`;
    const first = await post(app, user.session, path, {
      text: "private-http-marker",
      tier: "smart",
    });
    expect(first.status, first.text).toBe(202);
    const accepted = simonMessageAcceptedSchema.parse(first.json());
    expect(accepted.status).toBe("accepted");
    const second = await post(app, user.session, path, { text: "follow up" });
    expect(second.status).toBe(202);
    expect(simonMessageAcceptedSchema.parse(second.json())).toMatchObject({
      status: "queued",
      runId: null,
    });
    const view = await app.get(`/v1/runs/${accepted.runId}`, { session: user.session });
    expect(view.status).toBe(200);
    expect(simonRunViewSchema.parse(view.json())).toMatchObject({
      status: "queued",
      tier: "smart",
      stopRequested: false,
    });
    const stopped = await post(app, user.session, `/v1/runs/${accepted.runId}/stop`);
    expect(stopped.status, stopped.text).toBe(200);
    expect(stopped.json()).toEqual({ runId: accepted.runId });
    const current = await app.get(`/v1/runs/${accepted.runId}`, { session: user.session });
    expect(simonRunViewSchema.parse(current.json())).toMatchObject({
      status: "stopped",
      stopRequested: true,
    });
    expect(await app.db.all(sql("SELECT * FROM runs"))).toHaveLength(2);
    expect(app.logs.text()).not.toContain("private-http-marker");
    expect(JSON.stringify(await app.db.all(sql("SELECT * FROM messages")))).not.toContain(
      "private-http-marker",
    );
  });
  it("replays create and message outcomes without duplicate quick chats or dispatch", async () => {
    const app = await boot();
    const { session } = await app.createSignedInUser();
    const creationKey = key();
    const create = () =>
      post(app, session, "/v1/conversations", { kind: "quick" }, { idempotencyKey: creationKey });
    const first = await create();
    const retry = await create();
    expect(retry.json()).toEqual(first.json());
    expect(retry.headers.get("idempotency-replayed")).toBe("true");
    const conversation = simonConversationCreatedSchema.parse(first.json()).conversationId;
    const messageKey = key();
    const send = () =>
      post(
        app,
        session,
        `/v1/conversations/${conversation}/messages`,
        { text: "hello" },
        { idempotencyKey: messageKey },
      );
    const responses = await Promise.all([send(), send(), send()]);
    for (const response of responses) {
      expect(response.status, response.text).toBe(202);
      expect(response.json()).toEqual(responses[0]?.json());
    }
    const replay = await send();
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await app.db.all(sql("SELECT id FROM conversations"))).toHaveLength(1);
    expect(await app.db.all(sql("SELECT id FROM messages"))).toHaveLength(1);
    expect(
      await app.db.all(sql("SELECT id FROM dispatch_intents WHERE kind = 'simon_run'")),
    ).toHaveLength(1);
    const mismatch = await post(
      app,
      session,
      `/v1/conversations/${conversation}/messages`,
      { text: "changed" },
      { idempotencyKey: messageKey },
    );
    expect(mismatch.status).toBe(422);
    expect(code(mismatch)).toBe("idempotency.mismatch");
  });
  it("returns the task's single conversation and refuses archived writes", async () => {
    const app = await boot();
    const user = await app.createSignedInUser();
    const created = await post(app, user.session, "/v1/tasks", {
      title: "Task",
      collection: "now",
    });
    expect(created.status, created.text).toBe(201);
    const task = taskCreateResponseSchema.parse(created.json()).task.id;
    const first = await post(app, user.session, "/v1/conversations", {
      kind: "task",
      taskId: task,
    });
    const again = await post(app, user.session, "/v1/conversations", {
      kind: "task",
      taskId: task,
    });
    expect(first.status, first.text).toBe(201);
    expect(again.json()).toEqual(first.json());
    const conversation = simonConversationCreatedSchema.parse(first.json()).conversationId;
    const archived = await post(app, user.session, `/v1/tasks/${task}/complete`, {
      mode: "all",
      stopRun: false,
    });
    expect(archived.status, archived.text).toBe(200);
    const refused = await post(app, user.session, `/v1/conversations/${conversation}/messages`, {
      text: "do not run",
    });
    expect(code(refused)).toBe("task.archived");
    expect(await app.db.all(sql("SELECT id FROM runs"))).toHaveLength(0);
  });
  it("requires session, trusted origin, CSRF, valid input and an idempotency key", async () => {
    const app = await boot();
    const { session } = await app.createSignedInUser();
    const path = "/v1/conversations";
    const body = { kind: "quick" };
    expect(code(await app.post(path, { body, idempotencyKey: key() }))).toBe(
      "auth.session_required",
    );
    expect(code(await post(app, session, path, body, { origin: "https://evil.test" }))).toBe(
      "auth.origin_forbidden",
    );
    expect(code(await post(app, session, path, body, { csrf: null }))).toBe("auth.csrf_invalid");
    expect(code(await app.post(path, { session, body }))).toBe("idempotency.key_required");
    expect(code(await post(app, session, path, { kind: "quick", ownerId: session.userId }))).toBe(
      "validation",
    );
    expect(await app.db.all(sql("SELECT id FROM conversations"))).toHaveLength(0);
    expect(await app.db.all(sql("SELECT key FROM idempotency_records"))).toHaveLength(0);
  });
  it("refuses foreign conversations and runs without leaking their existence", async () => {
    const app = await boot();
    const owner = await app.createSignedInUser();
    const other = await app.createSignedInUser();
    const conversation = await quick(app, owner.session);
    const sent = await post(app, owner.session, `/v1/conversations/${conversation}/messages`, {
      text: "secret",
    });
    const run = simonMessageAcceptedSchema.parse(sent.json()).runId;
    for (const id of [conversation, uuidv7()])
      expect(
        code(
          await post(app, other.session, `/v1/conversations/${id}/messages`, { text: "attack" }),
        ),
      ).toBe("not_found");
    for (const id of [run, uuidv7()]) {
      expect(code(await app.get(`/v1/runs/${id}`, { session: other.session }))).toBe("not_found");
      expect(code(await post(app, other.session, `/v1/runs/${id}/stop`))).toBe("not_found");
    }
    expect(
      (await app.db.first(sql("SELECT status FROM runs WHERE id = :run", { run })))?.status,
    ).toBe("queued");
  });
  it.each(["locked", "relocked", "suspended"] as const)("refuses a %s account", async (state) => {
    const app = await boot();
    const { session } = await app.createSignedInUser(state);
    const response = await post(app, session, "/v1/conversations", { kind: "quick" });
    expect(response.status).toBe(403);
    expect(code(response)).toBe(`access.${state}`);
    expect(await app.db.all(sql("SELECT id FROM conversations"))).toHaveLength(0);
  });
  it("replays Stop and retries executor cancellation after an outage without another mutation", async () => {
    const app = await boot();
    const { session } = await app.createSignedInUser();
    const conversation = await quick(app, session);
    const sent = await post(app, session, `/v1/conversations/${conversation}/messages`, {
      text: "hello",
    });
    const run = simonMessageAcceptedSchema.parse(sent.json()).runId;
    const cancel = vi
      .spyOn(app.app.get(ExecutionDispatcher), "cancel")
      .mockRejectedValueOnce(new Error("secret provider details"));
    const stopKey = key();
    const first = await post(app, session, `/v1/runs/${run}/stop`, undefined, {
      idempotencyKey: stopKey,
    });
    expect(first.status).toBe(200);
    const stored = await app.db.first(sql("SELECT write_id FROM runs WHERE id = :run", { run }));
    const retry = await post(app, session, `/v1/runs/${run}/stop`, undefined, {
      idempotencyKey: stopKey,
    });
    expect(retry.status).toBe(200);
    expect(retry.headers.get("idempotency-replayed")).toBe("true");
    expect(await app.db.first(sql("SELECT write_id FROM runs WHERE id = :run", { run }))).toEqual(
      stored,
    );
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(app.logs.text()).not.toContain("secret provider details");
  });
  it("denies expired quick chat messages without dispatching", async () => {
    const app = await boot();
    const { session } = await app.createSignedInUser();
    const conversation = await quick(app, session);
    await app.db.run(
      sql("UPDATE conversations SET expires_at = 1 WHERE id = :id", { id: conversation }),
    );
    const response = await post(app, session, `/v1/conversations/${conversation}/messages`, {
      text: "too late",
    });
    expect(response.status).toBe(410);
    expect(code(response)).toBe("simon.conversation_expired");
    expect(await app.db.all(sql("SELECT id FROM runs"))).toHaveLength(0);
  });
  it("creates one explicit retry and replays its id without another dispatch", async () => {
    const app = await boot();
    const { session } = await app.createSignedInUser();
    const conversation = await quick(app, session);
    const sent = await post(app, session, `/v1/conversations/${conversation}/messages`, {
      text: "retry me",
    });
    const previous = simonMessageAcceptedSchema.parse(sent.json()).runId;
    expect(code(await post(app, session, `/v1/runs/${previous}/retry`))).toBe("simon.stale");
    expect((await post(app, session, `/v1/runs/${previous}/stop`)).status).toBe(200);
    const retryKey = key();
    const first = await post(app, session, `/v1/runs/${previous}/retry`, undefined, {
      idempotencyKey: retryKey,
    });
    expect(first.status, first.text).toBe(202);
    const runId = first.json<{ runId: string }>().runId;
    expect(runId).not.toBe(previous);
    const again = await post(app, session, `/v1/runs/${previous}/retry`, undefined, {
      idempotencyKey: retryKey,
    });
    expect(again.status).toBe(202);
    expect(again.json()).toEqual(first.json());
    expect(again.headers.get("idempotency-replayed")).toBe("true");
    expect(
      await app.db.first(
        sql("SELECT kind, continues_run_id FROM runs WHERE id = :id", { id: runId }),
      ),
    ).toMatchObject({ kind: "retry", continues_run_id: previous });
    expect(await app.db.all(sql("SELECT id FROM runs"))).toHaveLength(2);
    expect(
      await app.db.all(sql("SELECT id FROM dispatch_intents WHERE kind = 'simon_run'")),
    ).toHaveLength(2);
    const other = await app.createSignedInUser();
    expect(code(await post(app, other.session, `/v1/runs/${previous}/retry`))).toBe("not_found");
  });
  it("folds a fresh access check into message acceptance after the HTTP guard", async () => {
    const app = await boot();
    const { session, id: owner } = await app.createSignedInUser();
    const conversation = await quick(app, session);
    const repository = app.app.get(SimonRepository);
    const load = repository.loadConversation.bind(repository);
    vi.spyOn(repository, "loadConversation").mockImplementationOnce(async (...args) => {
      const loaded = await load(...args);
      await app.db.run(
        sql("UPDATE users SET beta_state = 'relocked' WHERE id = :owner", { owner }),
      );
      return loaded;
    });
    const response = await post(app, session, `/v1/conversations/${conversation}/messages`, {
      text: "refuse race",
    });
    expect(response.status, response.text).toBe(409);
    expect(code(response)).toBe("simon.stale");
    expect(await app.db.all(sql("SELECT id FROM messages"))).toHaveLength(0);
    expect(
      await app.db.all(sql("SELECT key FROM idempotency_records WHERE scope LIKE '%messages%'")),
    ).toHaveLength(0);
  });
});
