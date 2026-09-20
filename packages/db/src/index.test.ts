import { describe, expect, it } from "vitest";
import type { DbClient, Statement } from "./index.ts";

describe("db interface", () => {
  it("types a batch of string-parameter statements", async () => {
    const statement: Statement = { sql: "SELECT 1 AS one", params: [] };
    const client: DbClient = {
      batch: async (statements) => statements.map(() => ({ success: true, results: [], meta: {} })),
      all: async () => [],
      first: async () => null,
      run: async () => ({ success: true, results: [], meta: {} }),
    };
    await expect(client.batch([statement])).resolves.toHaveLength(1);
  });
});
