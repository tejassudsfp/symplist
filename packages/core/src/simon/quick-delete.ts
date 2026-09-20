import { int, type Statement, sql } from "@symplist/db";
import type { MaintenanceFence } from "../maintenance-fence.ts";
import type { SimonRepository } from "./repository.ts";

/** One conversation per transaction. Never load/decrypt its history to delete it. */
export function quickDeleteStatements(
  conversationId: string,
  ownerId: string,
  now: number,
  guard: { readonly sql: string; readonly params: Readonly<Record<string, string>> },
): Statement[] {
  const params = { qd_id: conversationId, qd_owner: ownerId, ...guard.params };
  const conversation = `SELECT id FROM conversations WHERE id=:qd_id AND owner_id=:qd_owner AND kind='quick' AND (${guard.sql})`;
  const runs = `SELECT id FROM runs WHERE conversation_id IN (${conversation}) AND owner_id=:qd_owner`;
  const messages = `SELECT id FROM messages WHERE conversation_id IN (${conversation}) AND owner_id=:qd_owner`;
  return [
    sql(
      `UPDATE dispatch_intents SET status='cancelled',cancelled_at=:qd_now,updated_at=:qd_now
       WHERE kind='simon_run' AND owner_id=:qd_owner AND subject_id IN (${runs})`,
      { ...params, qd_now: int(now) },
    ),
    sql(`DELETE FROM tool_invocations WHERE owner_id=:qd_owner AND run_id IN (${runs})`, params),
    sql(
      `DELETE FROM idempotency_records WHERE user_id=:qd_owner AND scope IN ('simon.native.task','simon.native.sharing')
       AND substr(key,1,36) IN (${runs})`,
      params,
    ),
    sql(
      `DELETE FROM message_parts WHERE owner_id=:qd_owner AND message_id IN (${messages})`,
      params,
    ),
    sql(
      `DELETE FROM messages WHERE owner_id=:qd_owner AND conversation_id IN (${conversation})`,
      params,
    ),
    // Whole-conversation statements also remove supersedes/continuation chains together.
    sql(
      `DELETE FROM approvals WHERE owner_id=:qd_owner AND conversation_id IN (${conversation})`,
      params,
    ),
    sql(
      `DELETE FROM user_asks WHERE owner_id=:qd_owner AND conversation_id IN (${conversation})`,
      params,
    ),
    sql(
      `DELETE FROM read_receipts WHERE owner_id=:qd_owner AND reader_kind='conversation' AND reader_id IN (${conversation})`,
      params,
    ),
    sql(
      `DELETE FROM runs WHERE owner_id=:qd_owner AND conversation_id IN (${conversation})`,
      params,
    ),
    sql(`DELETE FROM conversations WHERE id IN (${conversation})`, params),
  ];
}

/** Five expired conversations per hourly pass, with a fresh mode fence in every deletion. */
export async function cleanupQuickChats(repository: SimonRepository, fence: MaintenanceFence) {
  const { db, now } = repository.options;
  if (!(await fence.current())) return 0;
  const candidates = await db.all(
    sql(
      "SELECT id,owner_id FROM conversations WHERE kind='quick' AND expires_at<=:now ORDER BY expires_at,id LIMIT 5",
      { now: int(now()) },
    ),
  );
  let deleted = 0;
  for (const row of candidates) {
    if (fence.execution.signal?.aborted) break;
    const active = fence.guard();
    const guard = {
      sql: `expires_at<=CAST(:qd_expiry AS INTEGER) AND (${active.sql})`,
      params: { ...active.params, qd_expiry: int(now()) },
    };
    const results = await db.batch([
      sql(`SELECT id FROM conversations WHERE id=:id AND (${guard.sql})`, {
        id: String(row.id),
        ...guard.params,
      }),
      ...quickDeleteStatements(String(row.id), String(row.owner_id), now(), guard),
      sql("SELECT id FROM conversations WHERE id=:id", { id: String(row.id) }),
    ]);
    if (results[0]?.results[0] && !results.at(-1)?.results[0]) deleted++;
  }
  return deleted;
}
