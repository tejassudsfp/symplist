import { describe, expect, it } from "vitest";
import { createDocumentsTestEnvironment } from "../documents/test-support.ts";
import { purgeContributors } from "./purge-contributors/index.ts";

/**
 * Account deletion promises that an owner's rows are gone, not merely unreachable (§5.6). A table
 * that carries `owner_id` and is named by no contributor would survive a purge silently, so the
 * schema itself decides what must be covered rather than a list somebody remembers to update.
 */
describe("purge covers every owner-scoped table", () => {
  it("names each table holding owner_id in some contributor's statements", async () => {
    const env = await createDocumentsTestEnvironment();
    try {
      const tables = await env.db.all({
        sql: `SELECT m.name FROM sqlite_master m
              WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
              AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) c WHERE c.name = 'owner_id')
              ORDER BY m.name`,
        params: [],
      });
      expect(tables.length).toBeGreaterThan(10);

      const covered = new Set<string>();
      for (const contributor of purgeContributors) {
        for (const statement of contributor.statements({
          userId: "01929f3e-0000-7000-8000-0000000000ff",
          batchLimit: 10,
          now: 0,
        } as never)) {
          for (const match of statement.sql.matchAll(
            /\b(?:DELETE\s+FROM|UPDATE)\s+"?([a-z_]+)"?/gi,
          ))
            if (match[1]) covered.add(match[1].toLowerCase());
        }
      }

      /**
       * Tables whose `owner_id` is not owned content, each excluded for a stated reason rather than
       * because nobody got to them. A new table may only join this list with one.
       */
      const notOwnedContent = new Set([
        // The account row itself; the tombstone step removes it last, after every contributor.
        "users",
        // A singleton sweep cursor (`id='artifacts'`) whose owner_id is the position a scan reached,
        // not a row belonging to that owner.
        "cleanup_cursors",
        // Holds the purge job itself, which by design outlives the users row it is purging.
        "dispatch_intents",
      ]);
      const missing = tables
        .map((row) => String(row.name))
        .filter((name) => !notOwnedContent.has(name))
        .filter((name) => !covered.has(name));
      expect(missing).toEqual([]);
    } finally {
      await env.close();
    }
  });
});
