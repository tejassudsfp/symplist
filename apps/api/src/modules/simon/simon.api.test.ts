import {
  errorEnvelopeSchema,
  simonConversationCreatedSchema,
  simonMessageAcceptedSchema,
  simonRunViewSchema,
  taskCreateResponseSchema,
} from "@symplist/contracts";
import { SimonRepository } from "@symplist/core/simon";
import { sql, uuidv7 } from "@symplist/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootTestApp,
  type RequestOptions,
  type TestApp,
  type TestSession,
} from "../../../test/harness.ts";
import { ExecutionDispatcher } from "../../infra/executors/dispatcher.ts";

const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
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
