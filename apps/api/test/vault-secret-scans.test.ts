import { simonConversationCreatedSchema, vaultGrantResponseSchema } from "@symplist/contracts";
import { int, sql, uuidv7 } from "@symplist/db";
import { afterEach, describe, expect, it } from "vitest";
import { idempotencyKey, lastOtpMessage } from "./access/helpers.ts";
import { bootTestApp, type TestApp } from "./harness.ts";
import { assertSecretAbsent, issuedCookie } from "./secret-scan.ts";

const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
const passphrase = "fake-vault-setup-passphrase-37ad";
async function fixture() {
  const app = await bootTestApp();
  apps.push(app);
  const owner = await app.createSignedInUser();
  const options = {
    session: owner.session,
    body: { passphrase, confirmation: passphrase },
    idempotencyKey: idempotencyKey(),
  };
  const response = await app.post("/v1/vault/setup", options);
  expect(response.status, response.text).toBe(200);
  const session = issuedCookie(response, "sym_vault");
  expect(response.text).not.toContain(passphrase);
  expect(response.text).not.toContain(session.token);
  await assertSecretAbsent(app, [passphrase, session.token]);
  return { app, owner, options, session };
}

describe("§6.1 Vault capability and passphrase scans", () => {
  it("setup and unlock issue cookie-only tokens, with no second cookie on either exact retry", async () => {
    const { app, owner, options, session } = await fixture();
    const setupReplay = await app.post("/v1/vault/setup", options);
    expect(setupReplay.status).toBe(200);
    expect(setupReplay.headers.getSetCookie()).toEqual([]);
    expect(setupReplay.headers.get("Idempotency-Replayed")).toBe("true");
    await app.post("/v1/vault/lock", {
      session: owner.session,
      headers: { cookie: session.cookie },
    });
    const unlockOptions = {
      session: owner.session,
      body: { passphrase },
      idempotencyKey: idempotencyKey(),
    };
    const unlocked = await app.post("/v1/vault/unlock", unlockOptions);
    expect(unlocked.status, unlocked.text).toBe(200);
    const second = issuedCookie(unlocked, "sym_vault");
    expect(second.token).not.toBe(session.token);
    const retry = await app.post("/v1/vault/unlock", unlockOptions);
    expect(retry.status).toBe(200);
    expect(retry.headers.getSetCookie()).toEqual([]);
    const status = await app.get("/v1/vault", {
      session: owner.session,
      headers: { cookie: second.cookie },
    });
    const items = await app.get("/v1/vault/items", {
      session: owner.session,
      headers: { cookie: second.cookie },
    });
    expect(status.status).toBe(200);
    expect(items.status).toBe(200);
    expect(
      await assertSecretAbsent(
        app,
        [passphrase, session.token, second.token],
        [setupReplay, retry, status, items],
      ),
    ).toBe(2);
    const mismatch = await app.post("/v1/vault/unlock", {
      ...unlockOptions,
      body: { passphrase: "wrong-vault-passphrase" },
    });
    expect(mismatch.status).toBe(422);
    await assertSecretAbsent(app, [passphrase, session.token, second.token], [mismatch]);
  });
  it("item creation and grant creation/replay expose only safe ids, never the underlying value", async () => {
    const { app, owner, session } = await fixture();
    const value = "fake-vault-value-nonreplayable-71ba";
    const options = {
      session: owner.session,
      headers: { cookie: session.cookie },
      idempotencyKey: idempotencyKey(),
      body: { type: "secret", title: "Test credential", value },
    };
    const created = await app.post("/v1/vault/items", options);
    expect(created.status, created.text).toBe(201);
    const item = created.json<{ id: string; version: number }>();
    const replay = await app.post("/v1/vault/items", options);
    expect(replay.json()).toEqual(item);
    const task = uuidv7();
    await app.db.run(
      sql(
        "INSERT INTO tasks(id,owner_id,collection,position,source,write_id,title_enc,created_at,updated_at) VALUES(:task,:owner,'now','a0','user','seed','sym1.1.x.y',:now,:now)",
        { task, owner: owner.id, now: int(app.clock.now()) },
      ),
    );
    const conversation = await app.post("/v1/conversations", {
      session: owner.session,
      idempotencyKey: idempotencyKey(),
      body: { kind: "task", taskId: task },
    });
    expect(conversation.status, conversation.text).toBe(201);
    const conversationId = simonConversationCreatedSchema.parse(conversation.json()).conversationId;
    const grantOptions = {
      session: owner.session,
      headers: { cookie: session.cookie },
      idempotencyKey: idempotencyKey(),
      body: {
        itemId: item.id,
        itemVersion: item.version,
        taskId: task,
        conversationId,
        toolSlug: "TEST_SEND",
        argumentPath: "/credential",
        expiresAt: app.clock.now() + 3600000,
      },
    };
    const grant = await app.post("/v1/vault/grants", grantOptions);
    expect(grant.status, grant.text).toBe(201);
    const grantResult = vaultGrantResponseSchema.parse(grant.json());
    expect(grantResult.handle).toEqual({ $vault: grantResult.id });
    const grantReplay = await app.post("/v1/vault/grants", grantOptions);
    expect(grantReplay.status).toBe(201);
    expect(grantReplay.json()).toEqual(grantResult);
    const list = await app.get("/v1/vault/items", {
      session: owner.session,
      headers: { cookie: session.cookie },
    });
    expect(list.status).toBe(200);
    expect(
      await assertSecretAbsent(
        app,
        [value, passphrase, session.token],
        [created, replay, grant, grantReplay, list],
      ),
    ).toBe(4);
    // An authorized explicit item read is intentionally plaintext. This is not a one-time secret
    // response, and retaining encrypted item/grant values is required by the Vault design.
    const read = await app.get(`/v1/vault/items/${item.id}`, {
      session: owner.session,
      headers: { cookie: session.cookie },
    });
    expect(read.status).toBe(200);
    expect(read.json()).toMatchObject({ value });
    await assertSecretAbsent(app, [value, passphrase, session.token]);
  });
  it("reset OTP and new passphrase stay out of reset/replay/status and encrypted response records", async () => {
    const { app, owner, session } = await fixture();
    const sent = await app.post("/v1/vault/reset/otp", { session: owner.session });
    expect(sent.status).toBe(201);
    const otp = lastOtpMessage(app, owner.email, "vault_reset").otp ?? "";
    const verifyOptions = {
      session: owner.session,
      body: { challengeId: sent.json<{ challengeId: string }>().challengeId, code: otp },
    };
    const verified = await app.post("/v1/vault/reset/verify", verifyOptions);
    expect(verified.status).toBe(200);
    const duplicate = await app.post("/v1/vault/reset/verify", verifyOptions);
    expect(duplicate.status).toBe(410);
    expect(duplicate.json()).toMatchObject({ error: { code: "otp.expired" } });
    const newPassphrase = "fake-vault-reset-passphrase-27cd";
    const resetOptions = {
      session: owner.session,
      idempotencyKey: idempotencyKey(),
      body: {
        authorizationId: verified.json<{ authorizationId: string }>().authorizationId,
        passphrase: newPassphrase,
        confirmation: newPassphrase,
      },
    };
    const reset = await app.post("/v1/vault/reset", resetOptions);
    expect(reset.status, reset.text).toBe(200);
    const replay = await app.post("/v1/vault/reset", resetOptions);
    expect(replay.status).toBe(200);
    expect(replay.json()).toEqual(reset.json());
    const status = await app.get("/v1/vault", { session: owner.session });
    expect(status.status).toBe(200);
    await assertSecretAbsent(
      app,
      [otp, passphrase, newPassphrase, session.token],
      [sent, verified, duplicate, reset, replay, status],
    );
  });
});
