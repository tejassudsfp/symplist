import { int, sql, uuidv7 } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultRestrictContributor } from "../access/restrict-contributors/vault.ts";
import { vaultSessionRevokeContributor } from "../access/session-revoke-contributors/vault.ts";
import { vaultPurgeContributor } from "../account/purge-contributors/vault.ts";
import { vaultArchiveContributor } from "../tasks/archive-contributors/vault.ts";
import { resolveVaultArguments } from "./grants.ts";
import { cleanupVault } from "./maintenance.ts";
import { vaultFixture } from "./test-support.ts";

const phrase = "a fictional key for edge tests";
let f: Awaited<ReturnType<typeof vaultFixture>>;
beforeEach(async () => {
  f = await vaultFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  f.close();
});
async function seeded() {
  const actor = await f.actor();
  const token = (await f.sessions.setup(actor, phrase)).token ?? "";
  const item = await f.items.save(actor, token, {
    type: "secret",
    title: "Granted item",
    value: "edge-case secret",
  });
  const task = await f.task(actor.userId);
  const grant = await f.grants.create(actor, token, {
    ...task,
    itemId: item.id,
    itemVersion: 1,
    toolSlug: "API_SEND",
    argumentPath: "/key",
    expiresAt: f.time.now + 3600000,
  });
  return { actor, token, item, task, grant };
}
describe("Vault security boundaries", () => {
  it("never reintroduces a secret through its label and bounds cyclic tool output", async () => {
    const { actor, token, item, task } = await seeded();
    await f.items.save(
      actor,
      token,
      { type: "secret", title: "edge-case secret", value: "edge-case secret" },
      item,
    );
    const grant = await f.grants.create(actor, token, {
      ...task,
      itemId: item.id,
      itemVersion: 2,
      toolSlug: "API_SEND",
      argumentPath: "/key",
      expiresAt: f.time.now + 10000,
    });
    const key = await f.key(actor.userId);
    try {
      const resolved = await resolveVaultArguments(
        f.db,
        { betaAccessRequired: true },
        {
          kind: "task",
          ownerId: actor.userId,
          ...task,
          toolSlug: "API_SEND",
          accountKey: key,
          now: f.time.now,
          guard: { exists: "1=1", params: {} },
        },
        { key: grant.handle },
      );
      const output: Record<string, unknown> = { "edge-case secret": "edge-case secret" };
      output.cycle = output;
      const redacted = JSON.stringify(resolved.redact(output));
      expect(redacted).not.toContain("edge-case secret");
      expect(redacted).toContain("[vault:item]");
      expect(redacted).toContain("circular reference");
    } finally {
      f.zeroize(key.key);
    }
  });
  it("does not accept login expiry while waiting for key derivation", async () => {
    const actor = await f.actor();
    const original = f.repository.context.bind(f.repository);
    vi.spyOn(f.repository, "context").mockImplementation(async (...args) => {
      const context = await original(...args);
      f.time.now += 86400001;
      return context;
    });
    await expect(f.sessions.setup(actor, phrase)).rejects.toMatchObject({
      code: "vault.already_created",
    });
    expect(await f.db.first(sql("SELECT COUNT(*) AS n FROM vaults"))).toEqual({ n: 0 });
  });
  it.each([
    "expired",
    "different task",
    "different conversation",
    "different owner",
    "wrong run guard",
    "quick chat",
    "deleted item",
    "archived task",
  ])("refuses %s grants before plaintext output", async (kind) => {
    const { actor, task, grant, item } = await seeded();
    const key = await f.key(actor.userId);
    const context = {
      kind: "task" as const,
      ownerId: actor.userId,
      ...task,
      toolSlug: "API_SEND",
      accountKey: key,
      now: f.time.now,
      guard: { exists: "1=1", params: {} },
    };
    if (kind === "expired") context.now += 3600000;
    if (kind === "different task") context.taskId = uuidv7();
    if (kind === "different conversation") context.conversationId = uuidv7();
    if (kind === "different owner") context.ownerId = uuidv7();
    if (kind === "wrong run guard") context.guard = { exists: "1=0", params: {} };
    if (kind === "quick chat")
      await f.db.run(
        sql("UPDATE conversations SET kind='quick',task_id=NULL,expires_at=:expiry WHERE id=:id", {
          expiry: int(f.time.now + 10000),
          id: task.conversationId,
        }),
      );
    if (kind === "deleted item")
      await f.db.run(
        sql("UPDATE vault_items SET deleted_at=:now WHERE id=:id", {
          now: int(f.time.now),
          id: item.id,
        }),
      );
    if (kind === "archived task")
      await f.db.run(
        sql(
          "UPDATE tasks SET status='archived',archived_at=:now,archived_with_root_id=id WHERE id=:id",
          { now: int(f.time.now), id: task.taskId },
        ),
      );
    try {
      await expect(
        resolveVaultArguments(f.db, { betaAccessRequired: true }, context, { key: grant.handle }),
      ).rejects.toMatchObject({ code: "vault.grant_revoked" });
    } finally {
      f.zeroize(key.key);
    }
  });
  it("restrict/restore cannot revive any grant or session", async () => {
    const { actor, grant, token } = await seeded();
    const writeId = uuidv7();
    await f.db.batch([
      sql(
        "UPDATE users SET beta_state='relocked',access_generation=access_generation+1,write_id=:w WHERE id=:id",
        { w: writeId, id: actor.userId },
      ),
      ...vaultRestrictContributor.statements({
        userId: actor.userId,
        reason: "relocked",
        writeId,
        now: f.time.now,
      }),
    ]);
    await f.db.run(
      sql(
        "UPDATE users SET beta_state='unlocked',access_generation=access_generation+1 WHERE id=:id",
        { id: actor.userId },
      ),
    );
    expect(
      await f.db.first(
        sql("SELECT status,value_enc FROM vault_grants WHERE id=:id", { id: grant.id }),
      ),
    ).toEqual({ status: "revoked", value_enc: null });
    await expect(f.items.list(actor, token)).rejects.toMatchObject({ code: "vault.locked" });
  });
  it("logout contributor revokes only its login's vault sessions", async () => {
    const { actor, token } = await seeded();
    await f.db.batch(
      vaultSessionRevokeContributor.statements({
        userId: actor.userId,
        sessionId: actor.sessionId,
        now: f.time.now,
        guard: null,
      }),
    );
    await expect(f.items.list(actor, token)).rejects.toMatchObject({ code: "vault.locked" });
  });
  it("archive contribution uses the bounded task query and deciding write guard", async () => {
    const { actor, task, grant } = await seeded();
    const writeId = uuidv7();
    const input = {
      ownerId: actor.userId,
      rootTaskId: task.taskId,
      taskIds: [task.taskId],
      mode: "all" as const,
      writeId,
      now: f.time.now,
      stopRun: true,
      archivedTaskIds: {
        sql: "SELECT id FROM tasks WHERE owner_id=:task_owner AND archived_at IS NOT NULL",
        params: { task_owner: actor.userId },
      },
    };
    await f.db.batch(vaultArchiveContributor.statements(input));
    expect(
      (await f.db.first(sql("SELECT status FROM vault_grants WHERE id=:id", { id: grant.id })))
        ?.status,
    ).toBe("active");
    await f.db.batch([
      sql("UPDATE users SET task_tree_write_id=:w WHERE id=:owner", {
        w: writeId,
        owner: actor.userId,
      }),
      sql(
        "UPDATE tasks SET status='archived',archived_at=:now,archived_with_root_id=id WHERE id=:id",
        { now: int(f.time.now), id: task.taskId },
      ),
      ...vaultArchiveContributor.statements(input),
    ]);
    expect(
      await f.db.first(
        sql("SELECT status,value_enc FROM vault_grants WHERE id=:id", { id: grant.id }),
      ),
    ).toEqual({ status: "revoked", value_enc: null });
  });
  it("cleanup expires and clears grants in bounded batches", async () => {
    const { grant } = await seeded();
    await cleanupVault(f.db, f.time.now + 3600000, 1);
    expect(
      await f.db.first(
        sql("SELECT status,value_enc FROM vault_grants WHERE id=:id", { id: grant.id }),
      ),
    ).toEqual({ status: "expired", value_enc: null });
  });
  it("purges children before keys without depending on shredded plaintext", async () => {
    const { actor } = await seeded();
    await f.db.run(sql("DELETE FROM account_keys WHERE owner_id=:id", { id: actor.userId }));
    await f.db.batch(vaultPurgeContributor.statements({ userId: actor.userId, batchLimit: 1 }));
    const remaining = await f.db.batch(
      vaultPurgeContributor.remaining?.({ userId: actor.userId, batchLimit: 1 }) ?? [],
    );
    expect(remaining[0]?.results[0]?.remaining).toBe(0);
  });
  it("generation change during setup refuses the write even when the account is admitted again", async () => {
    const actor = await f.actor();
    const batch = f.db.batch.bind(f.db);
    let changed = false;
    vi.spyOn(f.db, "batch").mockImplementation(async (statements, options) => {
      if (!changed && statements.some((s) => s.sql.startsWith("INSERT INTO vaults"))) {
        changed = true;
        await batch([
          sql("UPDATE users SET access_generation=access_generation+2 WHERE id=:id", {
            id: actor.userId,
          }),
        ]);
      }
      return batch(statements, options);
    });
    await expect(f.sessions.setup(actor, phrase)).rejects.toMatchObject({
      code: "vault.already_created",
    });
    expect(await f.db.first(sql("SELECT COUNT(*) AS n FROM vaults"))).toEqual({ n: 0 });
  });
  it("twenty failures across windows exhaust the daily budget", async () => {
    const actor = await f.actor();
    await f.sessions.setup(actor, phrase);
    for (let window = 0; window < 4; window++) {
      for (let guess = 0; guess < 5; guess++)
        await expect(f.sessions.unlock(actor, "wrong")).rejects.toMatchObject({
          code: "vault.incorrect_key",
        });
      f.time.now += 900001;
    }
    await expect(f.sessions.unlock(actor, phrase)).rejects.toMatchObject({
      code: "vault.throttled",
    });
    expect(
      (await f.db.first(sql("SELECT day_failures FROM vault_unlock_limits")))?.day_failures,
    ).toBe(20);
  });
  it("two resets from the same authorization commit exactly one version", async () => {
    const { actor } = await seeded();
    const challenge = await f.reset.sendCode(actor);
    const auth = await f.reset.verifyCode(actor, {
      challengeId: challenge.challengeId,
      code: f.mail.at(-1)?.code ?? "",
    });
    const results = await Promise.allSettled([
      f.reset.reset(actor, {
        authorizationId: auth.authorizationId,
        passphrase: "new first fictional phrase",
      }),
      f.reset.reset(actor, {
        authorizationId: auth.authorizationId,
        passphrase: "new second fictional phrase",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await f.db.first(sql("SELECT version FROM vaults")))?.version).toBe(2);
    expect(f.notices).toHaveLength(1);
  });
  it("reset authorization expires without changing the old vault", async () => {
    const { actor } = await seeded();
    const challenge = await f.reset.sendCode(actor);
    const auth = await f.reset.verifyCode(actor, {
      challengeId: challenge.challengeId,
      code: f.mail.at(-1)?.code ?? "",
    });
    f.time.now += 600000;
    await expect(
      f.reset.reset(actor, {
        authorizationId: auth.authorizationId,
        passphrase: "new first fictional phrase",
      }),
    ).rejects.toMatchObject({ code: "vault.reset_expired" });
    expect((await f.sessions.unlock(actor, phrase)).status).toBe("unlocked");
  });
});
