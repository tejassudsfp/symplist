import { int, sql } from "@symplist/db";
import type { ConnectionPurgeProvider } from "@symplist/integrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionsPurgeContributor } from "../account/purge-contributors/connections.ts";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";

let env: DocumentsTestEnvironment;
let owner: string;
let provider: ConnectionPurgeProvider;
beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
  owner = await env.createUser();
  await env.db.run(
    sql(
      "INSERT INTO composio_sessions (user_id,session_id,updated_at,write_id) VALUES (:owner,'session_deleted',:now,:owner)",
      { owner, now: int(env.clock) },
    ),
  );
  provider = {
    accounts: vi.fn(async () => ({ items: [], cursor: null })),
    revoke: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
  };
});
afterEach(async () => env.close());

function purge(connections?: ConnectionPurgeProvider) {
  return connectionsPurgeContributor.purgeProvider?.(
    { userId: owner, composioUserId: owner },
    { db: env.db, now: () => env.clock, ...(connections ? { connections } : {}) },
  );
}

describe("connection provider purge after shredding", () => {
  it("does not complete a known provider account when credentials are removed", async () => {
    expect(await purge()).toBe("incomplete");
  });

  it("allows a never-connected account to purge without provider configuration", async () => {
    await env.db.run(sql("DELETE FROM composio_sessions WHERE user_id = :owner", { owner }));
    expect(await purge()).toBe("done");
  });

  it("deletes the provider session without needing the shredded account key", async () => {
    await env.db.run(sql("DELETE FROM account_keys WHERE owner_id = :owner", { owner }));
    expect(await purge(provider)).toBe("done");
    expect(provider.accounts).toHaveBeenCalledWith(owner);
    expect(provider.deleteSession).toHaveBeenCalledWith("session_deleted");
  });

  it("deletes twenty accounts per invocation and re-reads the first shrinking page", async () => {
    const pending = Array.from({ length: 45 }, (_, n) => ({
      id: `ca_${n}`,
      toolkit: "gmail",
      status: "ACTIVE",
    }));
    provider.accounts = vi.fn(async () => ({ items: [...pending], cursor: null }));
    provider.revoke = vi.fn(async (id) => {
      pending.splice(
        pending.findIndex((item) => item.id === id),
        1,
      );
    });
    expect(await purge(provider)).toBe("incomplete");
    expect(provider.revoke).toHaveBeenCalledTimes(20);
    expect(await purge(provider)).toBe("incomplete");
    expect(provider.revoke).toHaveBeenCalledTimes(40);
    expect(await purge(provider)).toBe("incomplete");
    expect(provider.revoke).toHaveBeenCalledTimes(45);
    expect(await purge(provider)).toBe("done");
    expect(provider.accounts).toHaveBeenCalledTimes(4);
    expect(provider.deleteSession).toHaveBeenCalledOnce();
  });

  it("keeps provider failure incomplete and never exposes its content", async () => {
    provider.deleteSession = vi.fn(async () => {
      throw new Error("private session content");
    });
    expect(await purge(provider)).toBe("incomplete");
    expect(await env.count("composio_sessions")).toBe(1);
  });
});
