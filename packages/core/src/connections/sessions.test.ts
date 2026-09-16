import { int, sql, uuidv7 } from "@symplist/db";
import { FakeComposioClient } from "@symplist/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { ComposioSessions } from "./sessions.ts";

let env: DocumentsTestEnvironment;
let client: FakeComposioClient;
let sessions: ComposioSessions;
let owner: string;
beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
  owner = await env.createUser();
  client = new FakeComposioClient();
  sessions = new ComposioSessions({
    db: env.db,
    client,
    policy: { betaAccessRequired: true },
    now: () => env.clock,
  });
});
afterEach(async () => env?.close());

async function connection(account = "ca_one") {
  const id = uuidv7();
  await env.db.run(
    sql(
      `INSERT INTO connections (id, owner_id, toolkit, connected_account_id, status, confirmed_at, created_at, updated_at, write_id)
    VALUES (:id, :owner, 'gmail', :account, 'active', 1, 1, 1, :id)`,
      { id, owner, account },
    ),
  );
  return id;
}

describe("durable per-owner session authority", () => {
  it("creates once with confirmed pins and reuses without redundant updates", async () => {
    await connection();
    const first = await sessions.use(owner);
    expect((await sessions.use(owner)).sessionId).toBe(first.sessionId);
    expect(client.sessionsCreated).toHaveLength(1);
    expect(client.sessionsCreated[0]).toMatchObject({
      userId: owner,
      config: {
        connectedAccounts: { gmail: ["ca_one"] },
        sandbox: { enable: false },
        manageConnections: false,
      },
    });
    expect(client.sessionUpdates).toHaveLength(0);
  });

  it("updates pins after every connection generation, including removing the last account", async () => {
    const id = await connection();
    await sessions.use(owner);
    await env.db.run(
      sql(
        "UPDATE connections SET status = 'disconnected', generation = generation + 1 WHERE id = :id",
        { id },
      ),
    );
    await sessions.use(owner);
    expect(client.sessionUpdates).toHaveLength(1);
    expect(client.sessionUpdates[0]?.patch.connectedAccounts).toEqual({});
  });

  it("isolates sessions and pins by owner", async () => {
    await connection();
    const stranger = await env.createUser();
    const one = await sessions.use(owner);
    const two = await sessions.use(stranger);
    expect(two.sessionId).not.toBe(one.sessionId);
    expect(client.sessionsCreated[1]).toMatchObject({
      userId: stranger,
      config: { connectedAccounts: {} },
    });
  });

  it.each([
    "UPDATE users SET beta_state = 'relocked' WHERE id = :owner",
    "DELETE FROM account_keys WHERE owner_id = :owner",
  ])("refuses lost admission/key before any provider call: %s", async (query) => {
    await env.db.run(sql(query, { owner }));
    await expect(sessions.use(owner)).rejects.toMatchObject({ code: "integration.unavailable" });
    expect(client.sessionsCreated).toHaveLength(0);
  });

  it("fences a connection change while the provider is creating the session", async () => {
    const id = await connection();
    const create = client.sessions.create;
    vi.spyOn(client.sessions, "create").mockImplementation(async (user, config) => {
      const session = await create(user, config);
      await env.db.run(
        sql("UPDATE connections SET generation = generation + 1 WHERE id = :id", { id }),
      );
      return session;
    });
    await expect(sessions.use(owner)).rejects.toMatchObject({ code: "integration.unavailable" });
    expect(
      await env.db.first(
        sql("SELECT session_id, lease_until FROM composio_sessions WHERE user_id = :owner", {
          owner,
        }),
      ),
    ).toMatchObject({ session_id: null, lease_until: 0 });
    const created = client.sessionsCreated[0];
    await expect(client.sessions.use(created?.sessionId ?? "")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("refuses a concurrent writer's live lease and cannot release it", async () => {
    await sessions.use(owner);
    await env.db.run(
      sql(
        "UPDATE composio_sessions SET lease_until = :until, write_id = 'other' WHERE user_id = :owner",
        { owner, until: int(env.clock + 60000) },
      ),
    );
    await expect(sessions.use(owner)).rejects.toMatchObject({ code: "integration.unavailable" });
    expect(
      await env.db.first(
        sql("SELECT write_id, lease_until FROM composio_sessions WHERE user_id = :owner", {
          owner,
        }),
      ),
    ).toMatchObject({ write_id: "other", lease_until: env.clock + 60000 });
  });

  it("recreates a definitively missing session but not a transient upstream failure", async () => {
    const one = await sessions.use(owner);
    await one.delete();
    const two = await sessions.use(owner);
    expect(two.sessionId).not.toBe(one.sessionId);
    vi.spyOn(client.sessions, "use").mockRejectedValueOnce({
      status: 503,
      message: "private marker",
    });
    await expect(sessions.use(owner)).rejects.toMatchObject({
      code: "integration.provider_failed",
    });
    expect(client.sessionsCreated).toHaveLength(2);
  });

  it("fences an expired lease after a slow provider response", async () => {
    const create = client.sessions.create;
    vi.spyOn(client.sessions, "create").mockImplementation(async (user, config) => {
      const session = await create(user, config);
      env.clock += 60001;
      return session;
    });
    await expect(sessions.use(owner)).rejects.toThrow("integration.unavailable");
    expect(
      await env.db.first(
        sql("SELECT session_id FROM composio_sessions WHERE user_id = :owner", { owner }),
      ),
    ).toMatchObject({ session_id: null });
  });
});
