import { int, sql, uuidv7 } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { SimonRepository } from "../simon/repository.ts";
import { createOwnerConnectionAuthority, createSimonConnectionAuthority } from "./authority.ts";

let env: DocumentsTestEnvironment;
beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
});
afterEach(async () => env.close());

const schema = vi.fn(async (slug: string) => ({
  slug,
  toolkit: "mail",
  description: "provider text",
  schema: { type: "object" },
  tags: { readOnlyHint: false, destructiveHint: false },
}));

async function addConnection(ownerId: string, account: string, status = "active") {
  const id = uuidv7();
  await env.db.run(
    sql(
      `INSERT INTO connections
      (id,owner_id,toolkit,connected_account_id,status,confirmed_at,created_at,updated_at,write_id)
      VALUES (:id,:owner,'mail',:account,:status,:now,:now,:now,:id)`,
      { id, owner: ownerId, account, status, now: int(env.clock) },
    ),
  );
  return id;
}

describe("Simon connection authority", () => {
  it.each(["local", "trigger"] as const)(
    "binds fresh active records to the claimed %s run and fences mode/access changes",
    async (executor) => {
      const owner = await env.createUser();
      const foreign = await env.createUser();
      const task = await env.createTask(owner);
      const repository = new SimonRepository({
        db: env.db,
        keys: env.keys,
        policy: { betaAccessRequired: true },
        now: () => env.clock,
        quickChatTtlHours: 24,
      });
      await env.db.run(
        sql("UPDATE executor_state SET mode=:mode", {
          mode: executor === "trigger" ? "durable" : "local",
        }),
      );
      const conversation = await repository.createConversation(owner, task);
      const accepted = await repository.acceptMessage(owner, conversation, "authority", {
        text: "Use mail",
        tier: "fast",
      });
      const own = await addConnection(owner, "ca_owner");
      await addConnection(foreign, "ca_foreign");
      const claim = await repository.claim(String(accepted.runId), executor);
      expect(claim).not.toBeNull();
      if (!claim) return;
      try {
        const authority = createSimonConnectionAuthority(repository, claim, schema);
        expect(await authority.check()).toBe(true);
        expect(await authority.connections()).toEqual([
          expect.objectContaining({ id: own, ownerId: owner, connectedAccountId: "ca_owner" }),
        ]);
        await env.db.run(
          sql("UPDATE executor_state SET mode=:mode,generation=generation+1", {
            mode: executor === "trigger" ? "local" : "durable",
          }),
        );
        expect(await authority.check()).toBe(false);
        expect(await authority.connections()).toEqual([]);
      } finally {
        repository.releaseClaim(claim);
      }
    },
  );

  it("keeps trusted-UI metadata authority owner-bound without a model or session", async () => {
    const owner = await env.createUser();
    const foreign = await env.createUser();
    const own = await addConnection(owner, "ca_owner");
    await addConnection(foreign, "ca_foreign");
    const authority = createOwnerConnectionAuthority({
      db: env.db,
      ownerId: owner,
      policy: { betaAccessRequired: true },
      schema,
    });
    expect(await authority.check()).toBe(true);
    expect(await authority.connections()).toEqual([expect.objectContaining({ id: own })]);
    await env.db.run(sql("UPDATE users SET beta_state='relocked' WHERE id=:owner", { owner }));
    expect(await authority.check()).toBe(false);
    expect(await authority.connections()).toEqual([]);
    expect(schema).not.toHaveBeenCalled();
  });
});
