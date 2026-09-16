import type { DbClient } from "@symplist/db";
import { int, sql } from "@symplist/db";
import type { ObjectStore } from "@symplist/storage";
import { type MaintenanceGuard, maintenanceStatement } from "../maintenance-fence.ts";

/** Shared by cleanup-hourly, never a per-occurrence child task. All work is bounded per call. */
export class SharingMaintenance {
  constructor(
    private readonly db: DbClient,
    private readonly objects: ObjectStore,
  ) {}
  async sweep(now: number, guard?: MaintenanceGuard): Promise<void> {
    await this.db.batch([
      maintenanceStatement(
        "UPDATE share_approvals SET status = 'expired' WHERE id IN (SELECT id FROM share_approvals WHERE status = 'pending' AND expires_at <= :now ORDER BY expires_at LIMIT 100)",
        { now: int(now) },
        guard,
      ),
      maintenanceStatement(
        "DELETE FROM share_sessions WHERE id IN (SELECT id FROM share_sessions WHERE expires_at <= :now OR revoked_at IS NOT NULL LIMIT 100)",
        { now: int(now) },
        guard,
      ),
      maintenanceStatement(
        "DELETE FROM share_limits WHERE rowid IN (SELECT rowid FROM share_limits WHERE window_start < :cutoff LIMIT 100)",
        { cutoff: int(now - 2 * 86400000) },
        guard,
      ),
    ]);
  }
  async collectOwner(
    owner: string,
    now: number,
    cursor?: string,
    authorize?: () => Promise<boolean>,
  ): Promise<{ deleted: number; cursor?: string; interrupted?: true }> {
    if (authorize && !(await authorize())) return { deleted: 0, interrupted: true };
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
    const orphans = candidates.filter((object) => !live.has(object.key));
    // Ten R2 calls at most are in flight. Re-check the durable executor and lease before each group;
    // a mode change can never launch the next group or advance its cursor. Already dispatched deletes
    // are harmless: candidates predate the publication cutoff by more than 23 hours.
    for (let offset = 0; offset < orphans.length; offset += 10) {
      if (authorize && !(await authorize())) return { deleted, interrupted: true };
      const group = orphans.slice(offset, offset + 10);
      await Promise.all(group.map((object) => this.objects.delete(object.key)));
      deleted += group.length;
    }
    return { deleted, ...(page.cursor ? { cursor: page.cursor } : {}) };
  }
}
