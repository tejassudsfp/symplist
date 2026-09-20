import { int, sql } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveVaultArguments } from "./grants.ts";
import { vaultFixture } from "./test-support.ts";

const passphrase = "a calm fictional vault key";
let f: Awaited<ReturnType<typeof vaultFixture>>;
beforeEach(async () => {
  f = await vaultFixture();
});
afterEach(() => f.close());
describe("Vault sessions and encrypted items", () => {
  it("paginates bounded encrypted-note batches without losing or repeating an item", async () => {
    const actor = await f.actor();
    const token = (await f.sessions.setup(actor, passphrase)).token ?? "";
    for (let index = 0; index < 16; index++)
      await f.items.save(actor, token, {
        type: "note",
        title: `Note ${index}`,
        value: index === 0 ? "\u0001".repeat(64000) : "content",
      });
    const first = await f.items.list(actor, token);
    expect(first.items).toHaveLength(15);
    expect(first.nextCursor).toBe(first.items.at(-1)?.id);
    const last = await f.items.list(actor, token, first.nextCursor ?? undefined);
    expect(last.items).toHaveLength(1);
    expect(last.nextCursor).toBeNull();
    expect(new Set([...first.items, ...last.items].map((item) => item.id)).size).toBe(16);
    expect(JSON.stringify(first)).not.toContain("value");
  });
  it("requires a separate key, encrypts all content/wrappers and survives an unlock", async () => {
    const actor = await f.actor();
    expect((await f.sessions.status(actor)).state).toBe("not_created");
    const setup = await f.sessions.setup(actor, passphrase);
    expect(setup.token).toMatch(/^[\w-]{43}$/);
    expect((await f.sessions.status(actor)).state).toBe("locked");
    const token = setup.token ?? "";
    const created = await f.items.save(actor, token, {
      type: "secret",
      title: "Private label marker",
      value: "private value marker",
    });
    const stored = await f.db.first(
      sql("SELECT * FROM vault_items WHERE id=:id", { id: created.id }),
    );
    expect(stored?.data_enc).toMatch(/^sym1\./);
    expect(JSON.stringify(stored)).not.toContain("marker");
    const wraps = await f.db.first(
      sql("SELECT * FROM vaults WHERE owner_id=:owner", { owner: actor.userId }),
    );
    expect(wraps?.pass_wrap_enc).toMatch(/^sym1\./);
    expect(wraps?.recovery_wrap_enc).toMatch(/^sym1\./);
    expect(JSON.stringify(wraps)).not.toContain(passphrase);
    expect((await f.items.list(actor, token)).items[0]).not.toHaveProperty("value");
    await f.sessions.lock(actor, token);
    await expect(f.items.read(actor, token, created.id)).rejects.toMatchObject({
      code: "vault.locked",
    });
    const unlocked = await f.sessions.unlock(actor, passphrase);
    expect((await f.items.read(actor, unlocked.token ?? "", created.id)).value).toBe(
      "private value marker",
    );
  });
  it("first setup wins a race without replacing keys", async () => {
    const actor = await f.actor();
    const results = await Promise.allSettled([
      f.sessions.setup(actor, passphrase),
      f.sessions.setup(actor, "another fictional vault key"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await f.db.first(sql("SELECT COUNT(*) AS n FROM vaults"))).toEqual({ n: 1 });
  });
  it("wrong key creates no session; five guesses survive new service instances", async () => {
    const actor = await f.actor();
    await f.sessions.setup(actor, passphrase);
    for (let i = 0; i < 5; i++)
      await expect(f.sessions.unlock(actor, "incorrect key")).rejects.toMatchObject({
        code: "vault.incorrect_key",
      });
    await expect(f.sessions.unlock(actor, passphrase)).rejects.toMatchObject({
      code: "vault.throttled",
    });
    expect(await f.db.first(sql("SELECT failures,day_failures FROM vault_unlock_limits"))).toEqual({
      failures: 5,
      day_failures: 5,
    });
    f.time.now += 900001;
    expect((await f.sessions.unlock(actor, passphrase)).status).toBe("unlocked");
  });
  it("concurrent guesses reserve at most five failures", async () => {
    const actor = await f.actor();
    await f.sessions.setup(actor, passphrase);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => f.sessions.unlock(actor, "wrong")),
    );
    expect(
      results.filter((r) => r.status === "rejected" && r.reason.code === "vault.incorrect_key"),
    ).toHaveLength(5);
    expect(
      results.filter((r) => r.status === "rejected" && r.reason.code === "vault.throttled"),
    ).toHaveLength(3);
  });
  it("cross-user and cross-login tokens fail", async () => {
    const actor = await f.actor();
    const other = await f.actor();
    const token = (await f.sessions.setup(actor, passphrase)).token ?? "";
    await expect(f.items.list(other, token)).rejects.toMatchObject({ code: "vault.locked" });
    await expect(
      f.items.list({ ...actor, sessionId: other.sessionId }, token),
    ).rejects.toMatchObject({ code: "vault.locked" });
  });
  it("idle lock and absolute expiry are enforced server-side", async () => {
    const actor = await f.actor();
    let token = (await f.sessions.setup(actor, passphrase)).token ?? "";
    f.time.now += 300000;
    await expect(f.items.list(actor, token)).rejects.toMatchObject({ code: "vault.locked" });
    token = (await f.sessions.unlock(actor, passphrase)).token ?? "";
    for (let i = 0; i < 14; i++) {
      f.time.now += 240000;
      await f.items.list(actor, token);
    }
    f.time.now += 240000;
    await expect(f.items.list(actor, token)).rejects.toMatchObject({ code: "vault.locked" });
  });
  it.each(["relock", "logout", "shred"])("refuses old tokens after %s", async (kind) => {
    const actor = await f.actor();
    const token = (await f.sessions.setup(actor, passphrase)).token ?? "";
    if (kind === "relock")
      await f.db.run(
        sql("UPDATE users SET beta_state='relocked' WHERE id=:id", { id: actor.userId }),
      );
    if (kind === "logout")
      await f.db.run(
        sql("UPDATE auth_sessions SET revoked_at=:now WHERE id=:id", {
          id: actor.sessionId,
          now: int(f.time.now),
        }),
      );
    if (kind === "shred")
      await f.db.run(sql("DELETE FROM account_keys WHERE owner_id=:id", { id: actor.userId }));
    await expect(f.items.list(actor, token)).rejects.toMatchObject({ code: "vault.locked" });
  });
  it("edits are versioned and delete clears ciphertext", async () => {
    const actor = await f.actor();
    const token = (await f.sessions.setup(actor, passphrase)).token ?? "";
    const item = await f.items.save(actor, token, { type: "note", title: "Notes", value: "first" });
    await f.items.save(actor, token, { type: "note", title: "Notes", value: "second" }, item);
    await expect(
      f.items.save(actor, token, { type: "note", title: "Notes", value: "stale" }, item),
    ).rejects.toMatchObject({ code: "vault.conflict" });
    expect((await f.items.read(actor, token, item.id)).value).toBe("second");
    await f.items.delete(actor, token, item.id, 2);
    await expect(f.items.read(actor, token, item.id)).rejects.toMatchObject({ code: "not_found" });
    expect(
      (await f.db.first(sql("SELECT data_enc FROM vault_items WHERE id=:id", { id: item.id })))
        ?.data_enc,
    ).toBe("");
  });
});
describe("Recovery and narrowly scoped grants", () => {
  it("fresh purpose-bound OTP changes the wrapper, preserves items and revokes old sessions", async () => {
    const actor = await f.actor();
    const token = (await f.sessions.setup(actor, passphrase)).token ?? "";
    const item = await f.items.save(actor, token, {
      type: "note",
      title: "Retained",
      value: "content retained",
    });
    const challenge = await f.reset.sendCode(actor);
    const auth = await f.reset.verifyCode(actor, {
      challengeId: challenge.challengeId,
      code: f.mail.at(-1)?.code ?? "",
    });
    await f.reset.reset(actor, {
      authorizationId: auth.authorizationId,
      passphrase: "new fictional vault key",
    });
    await expect(f.items.read(actor, token, item.id)).rejects.toMatchObject({
      code: "vault.locked",
    });
    await expect(f.sessions.unlock(actor, passphrase)).rejects.toMatchObject({
      code: "vault.incorrect_key",
    });
    const next = (await f.sessions.unlock(actor, "new fictional vault key")).token ?? "";
    expect((await f.items.read(actor, next, item.id)).value).toBe("content retained");
    expect(f.notices).toEqual([actor.userId]);
    await expect(
      f.reset.reset(actor, {
        authorizationId: auth.authorizationId,
        passphrase: "another fictional vault key",
      }),
    ).rejects.toMatchObject({ code: "vault.reset_expired" });
  });
  it("a login OTP cannot authorize reset", async () => {
    const actor = await f.actor();
    await f.sessions.setup(actor, passphrase);
    const challenge = await f.otp.sendLogin(`${actor.userId}@example.test`);
    await expect(
      f.reset.verifyCode(actor, {
        challengeId: challenge.challengeId,
        code: f.mail.at(-1)?.code ?? "",
      }),
    ).rejects.toMatchObject({ code: "otp.expired" });
  });
  it("resolves only exact tool/path/task and redacts all required encodings", async () => {
    const actor = await f.actor();
    const token = (await f.sessions.setup(actor, passphrase)).token ?? "";
    const item = await f.items.save(actor, token, {
      type: "secret",
      title: "API key",
      value: "secret / value!",
    });
    const task = await f.task(actor.userId);
    const grant = await f.grants.create(actor, token, {
      ...task,
      itemId: item.id,
      itemVersion: 1,
      toolSlug: "API_SEND",
      argumentPath: "/headers/key",
      expiresAt: f.time.now + 3600000,
    });
    const key = await f.key(actor.userId);
    try {
      const context = {
        kind: "task" as const,
        ownerId: actor.userId,
        ...task,
        toolSlug: "API_SEND",
        accountKey: key,
        now: f.time.now,
        guard: { exists: "1=1", params: {} },
      };
      const resolved = await resolveVaultArguments(f.db, { betaAccessRequired: true }, context, {
        headers: { key: grant.handle },
      });
      expect(resolved.arguments).toEqual({ headers: { key: "secret / value!" } });
      for (const form of [
        "secret / value!",
        Buffer.from("secret / value!").toString("base64"),
        Buffer.from("secret / value!").toString("base64url"),
        encodeURIComponent("secret / value!"),
      ])
        expect(resolved.redact({ error: form })).toEqual({ error: "[vault:API key]" });
      await expect(
        resolveVaultArguments(f.db, { betaAccessRequired: true }, context, { body: grant.handle }),
      ).rejects.toMatchObject({ code: "vault.grant_revoked" });
      await expect(
        resolveVaultArguments(
          f.db,
          { betaAccessRequired: true },
          { ...context, toolSlug: "OTHER" },
          { headers: { key: grant.handle } },
        ),
      ).rejects.toMatchObject({ code: "vault.grant_revoked" });
      await f.items.save(
        actor,
        token,
        { type: "secret", title: "API key", value: "changed" },
        item,
      );
      expect(
        await f.db.first(
          sql("SELECT status,value_enc FROM vault_grants WHERE id=:id", { id: grant.id }),
        ),
      ).toEqual({ status: "revoked", value_enc: null });
      await expect(
        resolveVaultArguments(f.db, { betaAccessRequired: true }, context, {
          headers: { key: grant.handle },
        }),
      ).rejects.toMatchObject({ code: "vault.grant_revoked" });
    } finally {
      f.zeroize(key.key);
    }
  });
});
