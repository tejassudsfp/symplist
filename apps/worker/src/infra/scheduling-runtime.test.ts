import { createKeyProvider } from "@symplist/crypto";
import {
  applyMigrations,
  createLocalSqliteClient,
  type LocalSqliteClient,
  sql,
  uuidv7,
} from "@symplist/db";
import type { ObjectStore } from "@symplist/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as connectionsRuntime from "./connections-runtime.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { runScheduledWork } from "./scheduling-runtime.ts";

let db: LocalSqliteClient | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
  vi.restoreAllMocks();
});

describe("durable cleanup adapter", () => {
  it("uses the worker store and current generation, and refuses work after a mode switch", async () => {
    db = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
    await applyMigrations(db);
    const owner = uuidv7();
    await db.batch([
      sql(
        "UPDATE executor_state SET mode='durable',generation=3,updated_at=0,write_id='test' WHERE id=1",
      ),
      sql(
        "INSERT INTO users(id,email,beta_state,created_at,updated_at,write_id) VALUES(:id,'cleanup@example.test','unlocked',0,0,'test')",
        { id: owner },
      ),
    ]);
    const list = vi.fn<ObjectStore["list"]>(async () => ({ objects: [] }));
    const keys = createKeyProvider({
      CONTENT_KEK: { current: 1, versions: new Map([[1, Buffer.alloc(32, 2)]]) },
    });
    const drain = vi.fn(async () => 1);
    vi.spyOn(connectionsRuntime, "connectionReconcilerFor").mockReturnValue({ drain } as never);
    const runtime = {
      config: {
        DURABLE: true,
        BETA_ACCESS_REQUIRED: true,
        QUICK_CHAT_TTL_HOURS: 24,
        COMPOSIO_API_KEY: "test",
      },
      db,
      keys,
      objects: { list },
    } as unknown as WorkerRuntime;
    try {
      expect(await runScheduledWork(runtime, "cleanup")).toEqual({ noop: false });
      expect(drain).toHaveBeenCalledWith({ mode: "durable", generation: 3 });
      expect(list).toHaveBeenCalledWith({ prefix: `u/${owner}/artifacts/`, limit: 100 });
      expect(await db.first(sql("SELECT owner_id,lease_until FROM cleanup_cursors"))).toEqual({
        owner_id: owner,
        lease_until: 0,
      });
      await db.run(sql("UPDATE executor_state SET mode='local',generation=4 WHERE id=1"));
      list.mockClear();
      drain.mockClear();
      expect(await runScheduledWork(runtime, "cleanup")).toEqual({ noop: true });
      expect(list).not.toHaveBeenCalled();
      expect(drain).not.toHaveBeenCalled();
    } finally {
      keys.destroy();
    }
  });
});
