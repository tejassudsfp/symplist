import {
  createApiLane,
  createD1RestClient,
  createLocalSqliteClient,
  D1CircuitBreaker,
  sql,
} from "@symplist/db";
import { FakeClock } from "@symplist/testing";
import { describe, expect, it } from "vitest";
import {
  FAKE_D1_ACCOUNT_ID,
  FAKE_D1_API_TOKEN,
  FAKE_D1_DATABASE_ID,
  FakeD1Api,
} from "../../../../packages/testing/src/contracts/db/fake-d1-api.ts";

function fixture() {
  const database = createLocalSqliteClient({ path: ":memory:", env: {} });
  const clock = new FakeClock();
  const fake = new FakeD1Api({ database });
  const circuit = new D1CircuitBreaker({ clock });
  const lane = createApiLane({ clock });
  const options = {
    accountId: FAKE_D1_ACCOUNT_ID,
    databaseId: FAKE_D1_DATABASE_ID,
    apiToken: FAKE_D1_API_TOKEN,
    fetch: fake.fetch,
    clock,
    circuit,
    lane,
    random: () => 0,
  };
  return {
    database,
    clock,
    fake,
    circuit,
    client: createD1RestClient(options),
    sibling: createD1RestClient(options),
  };
}
const read = sql("SELECT 1 AS n");

describe("combined-load REST safeguards", () => {
  it("sheds unauthenticated work at 30% and preserves the remaining capacity for admitted work", async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 3; i++) await f.client.first(read, { priority: "unauthenticated" });
      await expect(f.client.first(read, { priority: "unauthenticated" })).rejects.toMatchObject({
        reason: "shed",
      });
      expect(f.fake.requests).toHaveLength(3);
      for (let i = 0; i < 7; i++) await f.client.first(read);
      const waiting = f.client.first(read);
      await expect(f.sibling.first(read, { priority: "unauthenticated" })).rejects.toMatchObject({
        reason: "shed",
      });
      expect(f.fake.requests).toHaveLength(10);
      await f.clock.advance(500);
      expect(await waiting).toEqual({ n: 1 });
      expect(f.fake.requests).toHaveLength(11);
    } finally {
      f.database.close();
    }
  });

  it.each([undefined, "30"])(
    "opens every client in a process after 429 (Retry-After=%s), without extra sends",
    async (retryAfter) => {
      const f = fixture();
      try {
        f.fake.interceptNext(
          () =>
            new Response(null, {
              status: 429,
              headers: retryAfter ? { "retry-after": retryAfter } : {},
            }),
        );
        const duration = retryAfter ? 30000 : 300000;
        await expect(f.client.first(read)).rejects.toMatchObject({
          code: "rate.limited",
          reason: "http_429",
          retryAfterMs: duration,
        });
        await expect(f.sibling.first(read)).rejects.toMatchObject({ reason: "circuit_open" });
        await f.clock.advance(duration - 1);
        await expect(f.client.first(read)).rejects.toMatchObject({ reason: "circuit_open" });
        expect(f.fake.requests).toHaveLength(1);
        await f.clock.advance(1);
        expect(await f.sibling.first(read)).toEqual({ n: 1 });
        expect(f.fake.requests).toHaveLength(2);
      } finally {
        f.database.close();
      }
    },
  );

  it("never resends a write after its committed response is lost, but retries a read", async () => {
    const f = fixture();
    try {
      await f.database.executeScript("CREATE TABLE load_probe(id TEXT PRIMARY KEY) STRICT;");
      f.fake.interceptNext(async (request) => {
        await f.database.batch(request.body.batch ?? []);
        return "network_error" as const;
      });
      await expect(
        f.client.run(sql("INSERT INTO load_probe(id) VALUES ('once')")),
      ).rejects.toMatchObject({ code: "db.unknown_outcome" });
      expect(f.fake.requests).toHaveLength(1);
      expect(await f.database.all(sql("SELECT id FROM load_probe"))).toEqual([{ id: "once" }]);
      f.fake.interceptNext(() => "network_error");
      const pending = f.client.first(read);
      await f.clock.advance(1);
      expect(await pending).toEqual({ n: 1 });
      expect(f.fake.requests).toHaveLength(3);
    } finally {
      f.database.close();
    }
  });
});
