import { randomBytes } from "node:crypto";
import {
  bool,
  DbError,
  DbStatementError,
  type FetchLike,
  int,
  json,
  type MigrationTarget,
  parseRateLimitHeaders,
  type Statement,
  sql,
  verifiedRow,
  verifyInsert,
  writeGuard,
} from "@symplist/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** A response seen by a REST transport under test. */
export interface ObservedResponse {
  readonly status: number;
  readonly headers: Headers;
}

export interface DbContractTarget {
  readonly client: MigrationTarget;
  /**
   * Responses observed on the wire, for REST clients. Enables the batch error shape, rate-limit
   * header and "rejected before sending" request-count checks.
   */
  readonly responses?: readonly ObservedResponse[];
  readonly close?: () => void | Promise<void>;
}

/** Wraps a transport and records every response status and header set. */
export function observingFetch(inner: FetchLike): {
  fetch: FetchLike;
  responses: ObservedResponse[];
} {
  const responses: ObservedResponse[] = [];
  return {
    responses,
    fetch: async (url, init) => {
      const response = await inner(url, init);
      responses.push({ status: response.status, headers: response.headers });
      return response;
    },
  };
}

export interface LiveD1Settings {
  readonly accountId: string;
  readonly databaseId: string;
  readonly apiToken: string;
  /** A second token (the worker token) for the per-token rate limit check, when configured. */
  readonly secondToken?: string;
}

/** Live D1 settings when `LIVE_D1=1` and credentials are present; otherwise the reason to skip. */
export function liveD1Settings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { readonly settings: LiveD1Settings } | { readonly skipReason: string } {
  if (env.LIVE_D1 !== "1") return { skipReason: "set LIVE_D1=1 to run the live D1 contract" };
  const apiToken = env.CLOUDFLARE_D1_API_TOKEN ?? env.CLOUDFLARE_D1_MIGRATE_API_TOKEN;
  const missing = [
    env.CLOUDFLARE_ACCOUNT_ID ? undefined : "CLOUDFLARE_ACCOUNT_ID",
    env.D1_DATABASE_ID ? undefined : "D1_DATABASE_ID",
    apiToken ? undefined : "CLOUDFLARE_D1_API_TOKEN",
  ].filter((name): name is string => name !== undefined);
  if (missing.length > 0) return { skipReason: `LIVE_D1=1 but ${missing.join(", ")} missing` };
  return {
    settings: {
      accountId: env.CLOUDFLARE_ACCOUNT_ID as string,
      databaseId: env.D1_DATABASE_ID as string,
      apiToken: apiToken as string,
      secondToken: env.CLOUDFLARE_D1_WORKER_API_TOKEN,
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject");
}

/**
 * The DbClient contract (§3.2, §17): run against the local `node:sqlite` client always, the REST
 * client over the fake D1 API, and live D1 when `LIVE_D1=1`. Every check uses scratch tables with
 * random names and drops them afterwards.
 */
export function describeDbClientContract(
  name: string,
  createTarget: () => Promise<DbContractTarget>,
): void {
  describe(`DbClient contract: ${name}`, () => {
    const suffix = randomBytes(6).toString("hex");
    const table = `contract_${suffix}`;
    const child = `contract_${suffix}_child`;
    let target: DbContractTarget;
    let client: MigrationTarget;

    const sentCount = () => target.responses?.length ?? 0;

    beforeAll(async () => {
      target = await createTarget();
      client = target.client;
      await client.batch([
        sql(
          `CREATE TABLE ${table} (id TEXT PRIMARY KEY, n INTEGER, flag INTEGER CHECK (flag IN (0, 1)), label TEXT, doc TEXT, write_id TEXT) STRICT`,
        ),
        sql(
          `CREATE TABLE ${child} (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE) STRICT`,
        ),
      ]);
    });

    afterAll(async () => {
      if (!target) return;
      try {
        await client.batch([
          sql(`DROP TABLE IF EXISTS ${child}`),
          sql(`DROP TABLE IF EXISTS ${table}`),
        ]);
      } finally {
        await target.close?.();
      }
    });

    const insert = (
      id: string,
      fields: { n?: number; label?: string | null; writeId?: string } = {},
    ): Statement =>
      sql(
        `INSERT INTO ${table} (id, n, flag, label, doc, write_id) VALUES (:id, :n, :flag, :label, :doc, :w)`,
        {
          id,
          n: fields.n === undefined ? null : int(fields.n),
          flag: bool(false),
          label: fields.label ?? null,
          doc: null,
          w: fields.writeId ?? null,
        },
      );

    it("returns one REST-shaped result per statement, in order", async () => {
      const results = await client.batch([
        insert("shape-1", { n: 1 }),
        sql(`SELECT id, n FROM ${table} WHERE id = :id`, { id: "shape-1" }),
      ]);
      expect(results).toHaveLength(2);
      for (const result of results) {
        expect(result.success).toBe(true);
        expect(Array.isArray(result.results)).toBe(true);
        expect(typeof result.meta).toBe("object");
      }
      expect(results[1]?.results).toEqual([{ id: "shape-1", n: 1 }]);
    });

    it("binds int, bool and JSON params as strings and writes absent values as NULL literals", async () => {
      const document = { a: 1, list: [true, null, "x"] };
      const statement = sql(
        `INSERT INTO ${table} (id, n, flag, label, doc) VALUES (:id, :n, :flag, :label, :doc)`,
        {
          id: "typed-1",
          n: int(9_007_199_254_740_991),
          flag: bool(true),
          label: undefined,
          doc: json(document),
        },
      );
      expect(statement.params.every((param) => typeof param === "string")).toBe(true);
      expect(statement.sql).toContain("NULL");
      await client.run(statement);

      const row = await client.first(
        sql(
          `SELECT n, flag, label, doc, typeof(n) AS n_type, typeof(flag) AS flag_type FROM ${table} WHERE id = :id AND n = :n AND flag = :flag LIMIT :limit`,
          {
            id: "typed-1",
            n: int(9_007_199_254_740_991),
            flag: bool(true),
            limit: int(1),
          },
        ),
      );
      expect(row).toEqual({
        n: 9_007_199_254_740_991,
        flag: 1,
        label: null,
        doc: JSON.stringify(document),
        n_type: "integer",
        flag_type: "integer",
      });
      const extracted = await client.first(
        sql(`SELECT json_extract(doc, '$.list[2]') AS third FROM ${table} WHERE id = :id`, {
          id: "typed-1",
        }),
      );
      expect(extracted).toEqual({ third: "x" });
    });

    it("rejects lossy string params in STRICT columns as a statement failure", async () => {
      const error = await rejection(
        client.run(
          sql(`INSERT INTO ${table} (id, n) VALUES (:id, :n)`, {
            id: "lossy-1",
            n: "not-a-number",
          }),
        ),
      );
      expect(error).toBeInstanceOf(DbStatementError);
      expect((error as DbStatementError).kind).toBe("type");
    });

    it("rolls back statement 1 when statement 2 fails (batch atomicity)", async () => {
      await client.run(insert("rollback-existing"));
      const error = await rejection(
        client.batch([insert("rollback-new"), insert("rollback-existing")]),
      );
      expect(error).toBeInstanceOf(DbStatementError);
      expect(["unique", "primary_key"]).toContain((error as DbStatementError).constraint);
      await expect(
        client.first(sql(`SELECT id FROM ${table} WHERE id = :id`, { id: "rollback-new" })),
      ).resolves.toBeNull();
    });

    it("populates RETURNING rows", async () => {
      const [result] = await client.batch([
        sql(`INSERT INTO ${table} (id, n) VALUES (:id, :n) RETURNING id, n`, {
          id: "returning-1",
          n: int(7),
        }),
      ]);
      expect(result?.results).toEqual([{ id: "returning-1", n: 7 }]);
    });

    it("decides conditional writes from the write-id verification SELECT", async () => {
      await client.run(insert("guarded-1", { writeId: "w-initial" }));
      const attempt = async (expected: string, requestId: string) => {
        const guard = writeGuard({ table, id: "guarded-1" });
        const results = await client.batch([
          sql(
            `UPDATE ${table} SET label = :label, write_id = :w WHERE id = :id AND write_id = :expected`,
            {
              label: requestId,
              w: guard.writeId,
              id: "guarded-1",
              expected,
            },
          ),
          sql(
            `INSERT INTO ${child} (id, parent_id, request_id) SELECT :cid, :pid, :req WHERE ${guard.exists}`,
            {
              cid: `${requestId}-child`,
              pid: "guarded-1",
              req: requestId,
              ...guard.params,
            },
          ),
          verifyInsert({ table: child, column: "request_id", value: requestId }),
          guard.verify(),
        ]);
        return { guard, results };
      };

      const first = await attempt("w-initial", "req-1");
      expect(verifiedRow(first.results)).toEqual({
        id: "guarded-1",
        write_id: first.guard.writeId,
      });
      expect(verifiedRow(first.results, 2)).toEqual({ request_id: "req-1" });

      const stale = await attempt("w-initial", "req-2");
      expect(verifiedRow(stale.results)).toBeNull();
      expect(verifiedRow(stale.results, 2)).toBeNull();
    });

    it("reports statement failures with a stable shape that carries no SQL or values", async () => {
      const marker = `marker-${randomBytes(8).toString("hex")}`;
      await client.run(insert("shape-error", { label: marker }));
      const error = await rejection(client.run(insert("shape-error", { label: marker })));
      expect(error).toBeInstanceOf(DbStatementError);
      const failure = error as DbStatementError;
      expect(failure.code).toBe("db.statement_failed");
      expect(failure.kind).toBe("constraint");
      for (const text of [failure.message, JSON.stringify(failure), String(failure.stack)]) {
        expect(text).not.toContain(marker);
        expect(text).not.toContain("INSERT");
      }
      if (target.responses) {
        // D1 answers invalid SQL with HTTP 400; a 200 with success: false is also a failed batch.
        expect([200, 400]).toContain(failure.httpStatus);
      }
    });

    it("rejects malformed and oversize statements before sending", async () => {
      const before = sentCount();
      const cases: Array<[Statement, string]> = [
        [{ sql: "SELECT 1; SELECT 2", params: [] }, "db.invalid_statement"],
        [{ sql: "BEGIN", params: [] }, "db.invalid_statement"],
        [{ sql: "SAVEPOINT contract", params: [] }, "db.invalid_statement"],
        [{ sql: "ATTACH DATABASE 'x.db' AS other", params: [] }, "db.invalid_statement"],
        [{ sql: "SELECT ?", params: [] }, "db.invalid_statement"],
        [{ sql: "SELECT :named", params: ["1"] }, "db.invalid_statement"],
        [
          { sql: `SELECT ${"?, ".repeat(100)}?`, params: Array.from({ length: 101 }, () => "1") },
          "db.limit_exceeded",
        ],
        [{ sql: `SELECT '${"x".repeat(100_001)}'`, params: [] }, "db.limit_exceeded"],
        [{ sql: "SELECT ?", params: ["x".repeat(2_000_001)] }, "db.limit_exceeded"],
        [{ sql: "SELECT ?", params: [42 as unknown as string] }, "db.invalid_statement"],
      ];
      for (const [statement, code] of cases) {
        const error = await rejection(client.batch([statement]));
        expect(error).toBeInstanceOf(DbError);
        expect((error as DbError).code).toBe(code);
      }
      await expect(client.batch([])).rejects.toMatchObject({ code: "db.limit_exceeded" });
      expect(sentCount()).toBe(before);
    });

    it("rejects UPDATE, DELETE and REPLACE on append-only tables before sending", async () => {
      const before = sentCount();
      const statements = [
        "UPDATE beta_admin_events SET action = 'x' WHERE id = 'e'",
        "DELETE FROM beta_admin_events WHERE id = 'e'",
        "REPLACE INTO beta_admin_events (id) VALUES ('e')",
        "INSERT OR REPLACE INTO main.beta_admin_events (id) VALUES ('e')",
        `INSERT INTO "beta_admin_events" (id) VALUES ('e') ON CONFLICT (id) DO UPDATE SET action = 'x'`,
        "DROP TABLE beta_admin_events",
        "DROP TRIGGER IF EXISTS beta_admin_events_no_update",
      ];
      for (const text of statements) {
        await expect(client.batch([{ sql: text, params: [] }])).rejects.toMatchObject({
          code: "db.append_only",
        });
      }
      expect(sentCount()).toBe(before);
    });

    it("implements all, first and run on top of batch", async () => {
      await client.run(insert("helpers-1", { n: 1 }));
      await client.run(insert("helpers-2", { n: 2 }));
      const rows = await client.all(
        sql(`SELECT id FROM ${table} WHERE id IN (:ids) ORDER BY id`, {
          ids: ["helpers-1", "helpers-2"],
        }),
      );
      expect(rows).toEqual([{ id: "helpers-1" }, { id: "helpers-2" }]);
      await expect(
        client.first(sql(`SELECT id FROM ${table} WHERE id IN (:ids)`, { ids: [] })),
      ).resolves.toBeNull();
      const result = await client.run(
        sql(`UPDATE ${table} SET n = n + 1 WHERE id = :id`, { id: "helpers-1" }),
      );
      expect(result.success).toBe(true);
      expect(result.results).toEqual([]);
    });

    it("returns rows keyed by column for read-only batches on the raw endpoint", async () => {
      await client.run(insert("raw-1", { n: 5, label: "five" }));
      const rows = await client.all(
        sql(`SELECT id, n, label FROM ${table} WHERE id = :id`, { id: "raw-1" }),
        { raw: true },
      );
      expect(rows).toEqual([{ id: "raw-1", n: 5, label: "five" }]);
      await expect(client.batch([insert("raw-2")], { raw: true })).rejects.toMatchObject({
        code: "db.invalid_statement",
      });
    });

    it("runs multi-statement scripts atomically through executeScript", async () => {
      await client.executeScript(
        `INSERT INTO ${table} (id, n) VALUES ('script-1', 1);\nINSERT INTO ${table} (id, n) VALUES ('script-2', 2);`,
      );
      await expect(
        client.all(sql(`SELECT id FROM ${table} WHERE id LIKE 'script-%' ORDER BY id`)),
      ).resolves.toEqual([{ id: "script-1" }, { id: "script-2" }]);
      await expect(
        client.executeScript(
          `INSERT INTO ${table} (id) VALUES ('script-3');\nINSERT INTO ${table} (id) VALUES ('script-1');`,
        ),
      ).rejects.toBeInstanceOf(DbStatementError);
      await expect(
        client.first(sql(`SELECT id FROM ${table} WHERE id = 'script-3'`)),
      ).resolves.toBeNull();
    });

    it("exposes Cloudflare rate-limit headers on REST responses", async (context) => {
      if (!target.responses) {
        context.skip("rate-limit headers exist only on REST transports");
        return;
      }
      await client.first(sql("SELECT 1 AS one"));
      const last = target.responses[target.responses.length - 1];
      expect(last?.status).toBe(200);
      const policies = parseRateLimitHeaders(last?.headers ?? new Headers());
      expect(policies.some((policy) => typeof policy.remaining === "number")).toBe(true);
    });
  });
}

/**
 * Live only: whether Cloudflare's API rate limit is shared between two D1 tokens (per user or
 * account) or independent (per token), measured from `Ratelimit` remaining counts (§3.1 open item).
 * The finding is logged; the check fails only when the headers are missing.
 */
export function describeLiveD1RateLimitScope(
  createClient: (apiToken: string, fetch: FetchLike) => MigrationTarget,
  settings: LiveD1Settings,
): void {
  const secondToken = settings.secondToken;
  describe.skipIf(!secondToken)(
    `live D1 rate-limit scope${secondToken ? "" : " (skipped: CLOUDFLARE_D1_WORKER_API_TOKEN not set)"}`,
    () => {
      it("reports whether two tokens share one rate-limit budget", async () => {
        const first = observingFetch((url, init) => fetch(url, init));
        const second = observingFetch((url, init) => fetch(url, init));
        const primary = createClient(settings.apiToken, first.fetch);
        const other = createClient(secondToken as string, second.fetch);
        const remaining = (responses: readonly ObservedResponse[]) => {
          const last = responses[responses.length - 1];
          const values = parseRateLimitHeaders(last?.headers ?? new Headers())
            .map((policy) => policy.remaining)
            .filter((value): value is number => typeof value === "number");
          expect(values.length).toBeGreaterThan(0);
          return Math.min(...values);
        };
        const probe = sql("SELECT 1 AS one");
        await other.first(probe);
        const otherBefore = remaining(second.responses);
        for (let index = 0; index < 3; index += 1) await primary.first(probe);
        remaining(first.responses);
        await other.first(probe);
        const otherAfter = remaining(second.responses);
        const shared = otherBefore - otherAfter >= 3;
        console.info(
          JSON.stringify({ check: "d1.rate_limit_scope", shared, otherBefore, otherAfter }),
        );
        expect(typeof shared).toBe("boolean");
      });
    },
  );
}

export interface RawD1Transport {
  /** The database `/query` URL. */
  readonly url: string;
  readonly apiToken: string;
  readonly fetch: FetchLike;
}

/**
 * Records how D1 binds JSON numbers, booleans and null sent directly as `params` (§3.2 live check,
 * research risk R3). The DbClient never sends them, so this bypasses the client with one raw request.
 */
export function describeRawD1ParamTypes(name: string, transport: RawD1Transport): void {
  describe(`D1 raw param types: ${name}`, () => {
    it("records how JSON number, boolean and null params bind next to string params", async () => {
      const response = await transport.fetch(transport.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${transport.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          batch: [
            {
              sql: "SELECT typeof(?) AS number_type, typeof(?) AS boolean_type, typeof(?) AS null_type, typeof(?) AS string_type",
              params: [42, true, null, "42"],
            },
          ],
        }),
      });
      const body = (await response.json()) as {
        success?: boolean;
        result?: Array<{ results?: Array<Record<string, unknown>> }>;
      };
      const row = body.result?.[0]?.results?.[0] ?? null;
      console.info(
        JSON.stringify({
          check: "d1.param_types",
          status: response.status,
          success: body.success,
          row,
        }),
      );
      expect([200, 400]).toContain(response.status);
      if (response.status === 200) expect(row?.string_type).toBe("text");
    });
  });
}
