import { simonConversationCreatedSchema, simonQuickSavedSchema } from "@symplist/contracts";
import { SimonRepository } from "@symplist/core/simon";
import { int, sql } from "@symplist/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApp, type TestApp } from "../../../test/harness.ts";
import { ExecutionDispatcher } from "../../infra/executors/dispatcher.ts";

const apps: TestApp[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
});

describe("owner quick-chat close route", () => {
  it("removes history before cancellation, and retries cancellation after a lost reply", async () => {
    const { app, owner, conversationId } = await fixture();
    const repo = app.inject<SimonRepository>(SimonRepository);
    const accepted = await repo.acceptMessage(owner.id, conversationId, "close-message", {
      text: "Close secret",
      tier: "fast",
    });
    const cancel = vi
      .spyOn(app.inject<ExecutionDispatcher>(ExecutionDispatcher), "cancel")
      .mockImplementation(async () => {
        expect(
          await app.db.first(
            sql("SELECT id FROM conversations WHERE id=:id", { id: conversationId }),
          ),
        ).toBeNull();
        throw new Error("simulated cancellation outage");
      });
    const close = () =>
      app.request("DELETE", `/v1/conversations/${conversationId}`, {
        session: owner.session,
        idempotencyKey: "close-quick-chat",
      });
    const first = await close();
    expect(first.status, first.text).toBe(200);
    expect(first.json()).toEqual({ conversationId, runId: accepted.runId });
    const replay = await close();
    expect(replay.status, replay.text).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenLastCalledWith("simon_run", accepted.runId);
    for (const table of ["messages", "message_parts", "runs", "conversations"])
      expect(await app.db.first(sql(`SELECT COUNT(*) AS n FROM ${table}`))).toEqual({ n: 0 });
    expect(
      (await app.get(`/v1/conversations/${conversationId}`, { session: owner.session })).status,
    ).toBe(404);
    await app.db.run(
      sql("UPDATE users SET beta_state='relocked' WHERE id=:owner", { owner: owner.id }),
    );
    expect((await close()).status).toBe(404);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("requires CSRF and ownership and cannot delete a saved task chat", async () => {
    const { app, owner, conversationId, path } = await fixture();
    const closePath = `/v1/conversations/${conversationId}`;
    const other = await app.createSignedInUser();
    expect(
      (
        await app.request("DELETE", closePath, {
          session: owner.session,
          csrf: null,
          idempotencyKey: "close-quick-csrf-key",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("DELETE", closePath, {
          session: other.session,
          idempotencyKey: "close-quick-foreign-key",
        })
      ).status,
    ).toBe(404);
    expect(
      (await app.post(path, { session: owner.session, idempotencyKey: "save-before-close", body }))
        .status,
    ).toBe(201);
    expect(
      (
        await app.request("DELETE", closePath, {
          session: owner.session,
          idempotencyKey: "close-quick-saved-key",
        })
      ).status,
    ).toBe(404);
    expect(await app.db.first(sql("SELECT COUNT(*) AS n FROM conversations"))).toEqual({ n: 1 });
    expect(await app.db.first(sql("SELECT COUNT(*) AS n FROM tasks"))).toEqual({ n: 1 });
  });
});
async function fixture() {
  const app = await bootTestApp();
  apps.push(app);
  const owner = await app.createSignedInUser();
  const created = await app.post("/v1/conversations", {
    session: owner.session,
    idempotencyKey: "create-quick-for-save",
    body: { kind: "quick" },
  });
  expect(created.status, created.text).toBe(201);
  const conversationId = simonConversationCreatedSchema.parse(created.json()).conversationId;
  return { app, owner, conversationId, path: `/v1/conversations/${conversationId}/save-as-task` };
}
const body = { title: "Keep this workspace help", collection: "now" };

describe("owner quick-chat save route", () => {
  it("folds task creation and attachment with an exact replayable response", async () => {
    const { app, owner, conversationId, path } = await fixture();
    const first = await app.post(path, {
      session: owner.session,
      body,
      idempotencyKey: "save-quick-same-key",
    });
    expect(first.status, first.text).toBe(201);
    const saved = simonQuickSavedSchema.parse(first.json());
    expect(saved).toMatchObject({ conversationId, collection: "now" });
    const replay = await app.post(path, {
      session: owner.session,
      body,
      idempotencyKey: "save-quick-same-key",
    });
    expect(replay.status, replay.text).toBe(201);
    expect(replay.json()).toEqual(saved);
    expect(
      await app.db.first(
        sql("SELECT COUNT(*) AS n FROM tasks WHERE owner_id=:owner", { owner: owner.id }),
      ),
    ).toEqual({ n: 1 });
    expect(
      (await app.get(`/v1/conversations/${conversationId}`, { session: owner.session })).json(),
    ).toMatchObject({ kind: "task", taskId: saved.taskId });
    expect(
      (await app.get(`/v1/tasks/${saved.taskId}`, { session: owner.session })).json(),
    ).toMatchObject({ task: { title: body.title } });
    const mismatch = await app.post(path, {
      session: owner.session,
      body: { ...body, title: "Different title" },
      idempotencyKey: "save-quick-same-key",
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.json()).toMatchObject({ error: { code: "idempotency.mismatch" } });
  });

  it("rejects missing CSRF, foreign ownership, expiry and replay after relock", async () => {
    const { app, owner, path, conversationId } = await fixture();
    const other = await app.createSignedInUser();
    const csrf = await app.post(path, {
      session: owner.session,
      body,
      idempotencyKey: "csrf-quick-save",
      csrf: null,
    });
    expect(csrf.status).toBe(403);
    const foreign = await app.post(path, {
      session: other.session,
      body,
      idempotencyKey: "foreign-quick-save",
    });
    expect(foreign.status).toBe(404);
    await app.db.run(
      sql("UPDATE conversations SET expires_at=:now WHERE id=:id", {
        now: int(app.clock.now()),
        id: conversationId,
      }),
    );
    expect(
      (await app.post(path, { session: owner.session, body, idempotencyKey: "expired-quick-save" }))
        .status,
    ).toBe(404);
    expect(await app.db.first(sql("SELECT COUNT(*) AS n FROM tasks"))).toEqual({ n: 0 });
    await app.db.run(
      sql("UPDATE conversations SET expires_at=:later WHERE id=:id", {
        later: int(app.clock.now() + 3600000),
        id: conversationId,
      }),
    );
    const saved = await app.post(path, {
      session: owner.session,
      body,
      idempotencyKey: "relock-quick-save",
    });
    expect(saved.status, saved.text).toBe(201);
    await app.db.run(
      sql("UPDATE users SET beta_state='relocked' WHERE id=:owner", { owner: owner.id }),
    );
    const replay = await app.post(path, {
      session: owner.session,
      body,
      idempotencyKey: "relock-quick-save",
    });
    // The task service's folded replay deliberately hides inaccessible resources.
    expect(replay.status).toBe(404);
    expect(replay.json()).toMatchObject({ error: { code: "not_found" } });
    expect(await app.db.first(sql("SELECT COUNT(*) AS n FROM tasks"))).toEqual({ n: 1 });
  });
});
