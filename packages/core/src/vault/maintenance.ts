import { type DbClient, int, sql, uuidv7 } from "@symplist/db";
/** Bounded cleanup seam for cleanup-hourly. Resolution refuses expired grants before this runs. */
export async function cleanupVault(db: DbClient, now: number, limit = 100) {
  const size = Math.max(1, Math.min(100, Math.trunc(limit)));
  const params = { now: int(now), w: uuidv7(now), limit: int(size) };
  await db.batch([
    sql(
      `UPDATE vault_grants SET status='expired',value_enc=NULL,write_id=:w WHERE id IN (SELECT id FROM vault_grants WHERE status='active' AND expires_at<=CAST(:now AS INTEGER) LIMIT :limit)`,
      params,
    ),
    sql(
      `DELETE FROM vault_sessions WHERE id IN (SELECT id FROM vault_sessions WHERE expires_at<=CAST(:now AS INTEGER) OR revoked_at IS NOT NULL LIMIT :limit)`,
      params,
    ),
    sql(
      `DELETE FROM vault_reset_authorizations WHERE id IN (SELECT id FROM vault_reset_authorizations WHERE expires_at<=CAST(:now AS INTEGER) LIMIT :limit)`,
      params,
    ),
  ]);
}
