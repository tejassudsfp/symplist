import type { DbClient } from "@symplist/db";
import { int, sql } from "@symplist/db";
import type { ObjectStore } from "@symplist/storage";

/** Shared by cleanup-hourly, never a per-occurrence child task. All work is bounded per call. */
export class SharingMaintenance {
  constructor(
    private readonly db: DbClient,
    private readonly objects: ObjectStore,
  ) {}
  async sweep(now: number): Promise<void> {
    await this.db.batch([
      sql(
        "UPDATE share_approvals SET status = 'expired' WHERE id IN (SELECT id FROM share_approvals WHERE status = 'pending' AND expires_at <= :now ORDER BY expires_at LIMIT 100)",
        { now: int(now) },
      ),
      sql(
        "DELETE FROM share_sessions WHERE id IN (SELECT id FROM share_sessions WHERE expires_at <= :now OR revoked_at IS NOT NULL LIMIT 100)",
        { now: int(now) },
      ),
      sql(
        "DELETE FROM share_limits WHERE rowid IN (SELECT rowid FROM share_limits WHERE window_start < :cutoff LIMIT 100)",
        { cutoff: int(now - 2 * 86400000) },
      ),
    ]);
  }
  async collectOwner(
    owner: string,
    now: number,
    cursor?: string,
  ): Promise<{ deleted: number; cursor?: string }> {
    const prefix = `u/${owner}/artifacts/`;
    const page = await this.objects.list({ prefix, limit: 100, ...(cursor ? { cursor } : {}) });
    const candidates = page.objects.filter(
      (object) =>
        object.key.startsWith(prefix) &&
        /^[0-9a-f-]{36}\.md\.sym$/.test(object.key.slice(prefix.length)) &&
        typeof object.uploadedAt === "number" &&
        object.uploadedAt < now - 86400000,
    );
    const rows = await this.db.all(
      sql(
        "SELECT object_key FROM artifacts WHERE owner_id = :owner AND object_key IN (SELECT value FROM json_each(:keys))",
        { owner, keys: JSON.stringify(candidates.map((object) => object.key)) },
      ),
    );
    const live = new Set(rows.map((row) => row.object_key));
    let deleted = 0;
    for (const object of candidates) {
      if (live.has(object.key)) continue;
      await this.objects.delete(object.key);
      deleted += 1;
    }
    return { deleted, ...(page.cursor ? { cursor: page.cursor } : {}) };
  }
}
