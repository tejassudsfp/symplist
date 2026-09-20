import { int, sql, uuidv7 } from "@symplist/db";
import type { ObjectStore } from "@symplist/storage";
import { type MaintenanceGuard, maintenanceStatement } from "../maintenance-fence.ts";
import { cleanupMcp } from "../mcp/maintenance.ts";
import { SharingMaintenance } from "../sharing/maintenance.ts";
import { cleanupVault } from "../vault/maintenance.ts";
import type { CleanupContext } from "./cleanup.ts";

/** One artifact-owner page (at most 100 object keys), not one page per owner in the database. */
export async function cleanupSharedFeatures(context: CleanupContext, objects: ObjectStore) {
  const { db, fence, now } = context;
  if (!(await fence.current())) return;
  await cleanupVault(db, now(), 100, fence.guard());
  const sharing = new SharingMaintenance(db, objects);
  await sharing.sweep(now(), fence.guard());
  if (!(await fence.current())) return;
  await cleanupMcp({
    db,
    now: now(),
    mode: fence.execution.executor === "trigger" ? "durable" : "local",
    generation: fence.execution.generation,
  });
  const token = uuidv7(now());
  const leaseUntil = now() + 300_000;
  const guard = fence.guard();
  const claimed = await db.batch([
    sql(
      `INSERT INTO cleanup_cursors(id,lease_token,lease_until,write_id)
       SELECT 'artifacts',:token,CAST(:until AS INTEGER),:token WHERE ${guard.sql}
       ON CONFLICT(id) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until,write_id=excluded.write_id
       WHERE cleanup_cursors.lease_until<=CAST(:now AS INTEGER) AND ${guard.sql}`,
      { token, until: int(leaseUntil), now: int(now()), ...guard.params },
    ),
    sql(
      "SELECT owner_id,object_cursor FROM cleanup_cursors WHERE id='artifacts' AND lease_token=:token",
      { token },
    ),
  ]);
  const row = claimed[1]?.results[0];
  if (!row) return;
  const leaseGuard = (): MaintenanceGuard => {
    const executor = fence.guard();
    return {
      sql: `${executor.sql} AND EXISTS (SELECT 1 FROM cleanup_cursors WHERE id='artifacts' AND lease_token=:cleanup_token AND lease_until>CAST(:cleanup_now AS INTEGER))`,
      params: { ...executor.params, cleanup_token: token, cleanup_now: int(now()) },
    };
  };
  const current = async () => {
    if (fence.execution.signal?.aborted) return false;
    const active = leaseGuard();
    return (
      !!(await db.first(sql(`SELECT 1 WHERE ${active.sql}`, active.params))) &&
      now() < leaseUntil &&
      !fence.execution.signal?.aborted
    );
  };
  const after = String(row.owner_id);
  const previousCursor = typeof row.object_cursor === "string" ? row.object_cursor : undefined;
  const owner = previousCursor
    ? after
    : (await db.first(sql("SELECT id FROM users WHERE id>:after ORDER BY id LIMIT 1", { after })))
        ?.id;
  const result =
    typeof owner === "string"
      ? await sharing.collectOwner(owner, now(), previousCursor, current)
      : { deleted: 0 };
  if (result.interrupted) return;
  const write = uuidv7(now());
  await db.batch([
    maintenanceStatement(
      `UPDATE cleanup_cursors SET owner_id=:owner,object_cursor=${result.cursor ? ":cursor" : "NULL"},lease_until=0,write_id=:write WHERE id='artifacts'`,
      {
        owner: typeof owner === "string" ? owner : "",
        ...(result.cursor ? { cursor: result.cursor } : {}),
        write,
      },
      leaseGuard(),
    ),
    sql("SELECT write_id FROM cleanup_cursors WHERE id='artifacts' AND write_id=:write", { write }),
  ]);
}
