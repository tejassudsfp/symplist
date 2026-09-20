import { int, sql, uuidv7 } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { cleanupMcp } from "./maintenance.ts";

let env: DocumentsTestEnvironment;
beforeEach(async () => {
  env = await createDocumentsTestEnvironment();
});
afterEach(async () => {
  await env.close();
});
async function clients(count: number) {
  const statements = Array.from({ length: count }, () => {
    const id = uuidv7();
    return sql(
      "INSERT INTO oauth_clients (id,metadata,created_at,write_id) VALUES (:id,'{}',:before,:id)",
      { id, before: int(env.clock - 86400_001) },
    );
  });
  await env.db.batch(statements);
}
describe("bounded OAuth cleanup", () => {
  it("does not let a stale executor clean public clients, and respects its row bound", async () => {
    await clients(3);
    await env.db.run(
      sql("UPDATE executor_state SET mode = 'durable', generation = 8 WHERE id = 1"),
    );
    await cleanupMcp({ db: env.db, now: env.clock, mode: "local", generation: 8, limit: 2 });
    expect(await env.count("oauth_clients")).toBe(3);
    await cleanupMcp({ db: env.db, now: env.clock, mode: "durable", generation: 7, limit: 2 });
    expect(await env.count("oauth_clients")).toBe(3);
    await cleanupMcp({ db: env.db, now: env.clock, mode: "durable", generation: 8, limit: 2 });
    expect(await env.count("oauth_clients")).toBe(1);
  });
  it("keeps a recently used client even if its registration is older than a day", async () => {
    await clients(1);
    await env.db.run(sql("UPDATE oauth_clients SET last_used_at = :now", { now: int(env.clock) }));
    const state = await env.db.first(
      sql("SELECT mode,generation FROM executor_state WHERE id = 1"),
    );
    await cleanupMcp({
      db: env.db,
      now: env.clock,
      mode: state?.mode === "durable" ? "durable" : "local",
      generation: Number(state?.generation),
    });
    expect(await env.count("oauth_clients")).toBe(1);
  });
});
