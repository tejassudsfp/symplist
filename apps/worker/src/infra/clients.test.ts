import { randomBytes, randomUUID } from "node:crypto";
import { createAccountKey, createKeyProvider, KeyUnavailableError } from "@symplist/crypto";
import {
  applyMigrations,
  createLocalSqliteClient,
  D1RestClient,
  int,
  newWriteId,
  sql,
  uuidv7,
} from "@symplist/db";
import { R2ObjectStore } from "@symplist/storage";
import { FakeClock } from "@symplist/testing";
import { describe, expect, it } from "vitest";
import { loadAccountKey } from "./account-keys.ts";
import {
  createWorkerDb,
  createWorkerKeyProvider,
  createWorkerObjectStore,
  workerProcessLane,
} from "./clients.ts";
import { loadWorkerRuntimeConfig } from "./config.ts";

const family = () => randomBytes(32).toString("base64url");

function workerEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: "development",
    WEB_ORIGIN: "http://localhost:3000",
    API_ORIGIN: "http://localhost:4000",
    WS_ORIGIN: "ws://localhost:4000",
    DATA_DRIVER: "local",
    EMAIL_DRIVER: "log",
    DURABLE: "false",
    EMAIL_FROM_REMINDERS: "Symplist <reminders@example.com>",
    TRIGGER_AI_SDK_OTEL_AUTOREGISTER: "0",
    CONTENT_KEK_1: family(),
    CONTENT_KEK_CURRENT: "1",
    INTERNAL_EVENT_SECRET_1: family(),
    INTERNAL_EVENT_SECRET_CURRENT: "1",
    REMINDER_UNSUBSCRIBE_SECRET_1: family(),
    REMINDER_UNSUBSCRIBE_SECRET_CURRENT: "1",
    ...overrides,
  };
}

function hostedEnv(token: string) {
  return workerEnv({
    DATA_DRIVER: "d1",
    CLOUDFLARE_ACCOUNT_ID: randomBytes(16).toString("hex"),
    D1_DATABASE_ID: randomUUID(),
    CLOUDFLARE_D1_WORKER_API_TOKEN: token,
    R2_BUCKET: "symplist-objects",
    R2_ACCESS_KEY_ID: randomBytes(12).toString("hex"),
    R2_SECRET_ACCESS_KEY: randomBytes(24).toString("hex"),
  });
}

describe("worker configuration", () => {
  it("loads a valid worker environment", () => {
    const config = loadWorkerRuntimeConfig(workerEnv());
    expect(config.DATA_DRIVER).toBe("local");
    expect(config.INTERNAL_EVENT_SECRET.current).toBe(1);
  });

  it("maps configuration problems to config.invalid without echoing values", () => {
    const leaked = randomBytes(32).toString("base64url");
    const attempt = () =>
      loadWorkerRuntimeConfig(
        workerEnv({ SESSION_DIGEST_SECRET_1: leaked, API_ORIGIN: "not a url" }),
      );
    expect(attempt).toThrow(
      expect.objectContaining({ name: "WorkerError", code: "config.invalid" }),
    );
    try {
      attempt();
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(leaked);
      expect(String((error as Error).stack)).not.toContain(leaked);
    }
  });
});

describe("worker clients", () => {
  it("builds the D1 client with the worker token on the per-process worker lane", async () => {
    const token = randomBytes(24).toString("hex");
    const config = loadWorkerRuntimeConfig(hostedEnv(token));
    const requests: { url: string; authorization: string | null }[] = [];
    const db = createWorkerDb(config, {
      lane: workerProcessLane({ clock: new FakeClock() as never }),
      fetch: async (url, init) => {
        requests.push({ url, authorization: new Headers(init.headers).get("authorization") });
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            messages: [],
            result: [{ success: true, results: [{ one: 1 }], meta: {} }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    expect(db).toBeInstanceOf(D1RestClient);
    expect(await db.first(sql("SELECT 1 AS one"))).toEqual({ one: 1 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.authorization).toBe(`Bearer ${token}`);
    expect(requests[0]?.url).toContain(
      `/accounts/${config.CLOUDFLARE_ACCOUNT_ID}/d1/database/${config.D1_DATABASE_ID}/`,
    );
  });

  it("uses the lane budget from §3.1", () => {
    const lane = workerProcessLane({ clock: new FakeClock() as never });
    expect(lane.name).toBe("worker");
    expect(lane.burst).toBe(4);
    expect(lane.ratePerSecond).toBeCloseTo(1 / 7, 10);
  });

  it("builds R2 for d1 and holds only the worker secret families", () => {
    const config = loadWorkerRuntimeConfig(hostedEnv(randomBytes(24).toString("hex")));
    expect(createWorkerObjectStore(config)).toBeInstanceOf(R2ObjectStore);
    const keys = createWorkerKeyProvider(config);
    expect([...keys.families()].sort()).toEqual([
      "CONTENT_KEK",
      "INTERNAL_EVENT_SECRET",
      "REMINDER_UNSUBSCRIBE_SECRET",
    ]);
    expect(() => keys.current("SESSION_DIGEST_SECRET")).toThrow(KeyUnavailableError);
  });

  it("loads an account data key and fails with a stable code for a shredded account", async () => {
    const db = createLocalSqliteClient({ path: ":memory:", env: { NODE_ENV: "test" } });
    await applyMigrations(db);
    const keys = createKeyProvider({
      CONTENT_KEK: { current: 1, versions: new Map([[1, family()]]) },
    });
    const ownerId = uuidv7();
    const { key, wrapped } = createAccountKey(keys, ownerId);
    await db.batch([
      sql(
        "INSERT INTO users (id, email, created_at, updated_at, write_id) VALUES (:id, 'o@example.com', '1', '1', :w)",
        { id: ownerId, w: newWriteId() },
      ),
      sql(
        "INSERT INTO account_keys (owner_id, kek_version, wrapped_key, created_at, updated_at, write_id) VALUES (:id, :v, :k, '1', '1', :w)",
        {
          id: ownerId,
          v: int(wrapped.kekVersion),
          k: wrapped.wrapped,
          w: newWriteId(),
        },
      ),
    ]);
    const loaded = await loadAccountKey(db, keys, ownerId);
    expect(Buffer.from(loaded.key).equals(Buffer.from(key.key))).toBe(true);
    await expect(loadAccountKey(db, keys, uuidv7())).rejects.toMatchObject({
      name: "WorkerError",
      code: "account.key_missing",
    });
    db.close();
  });
});
