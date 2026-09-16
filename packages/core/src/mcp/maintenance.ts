import { type DbClient, int, sql } from "@symplist/db";

/** Small, generation-fenced housekeeping batch; consumed credentials survive until absolute expiry. */
export async function cleanupMcp(options: {
  readonly db: DbClient;
  readonly now: number;
  readonly mode: "local" | "durable";
  readonly generation: number;
  readonly limit?: number;
}) {
  const params = {
    now: int(options.now),
    mode: options.mode,
    generation: int(options.generation),
    limit: int(Math.min(100, Math.max(1, options.limit ?? 100))),
  };
  const fence =
    "EXISTS (SELECT 1 FROM executor_state WHERE id = 1 AND mode = :mode AND generation = :generation)";
  const results = await options.db.batch([
    sql(
      `DELETE FROM oauth_refresh_tokens WHERE id IN (SELECT id FROM oauth_refresh_tokens WHERE expires_at <= :now LIMIT :limit) AND ${fence}`,
      params,
    ),
    sql(
      `DELETE FROM oauth_codes WHERE id IN (SELECT c.id FROM oauth_codes c JOIN mcp_grants g ON g.id = c.grant_id WHERE (c.consumed_at IS NULL AND c.expires_at <= :now) OR g.expires_at <= :now LIMIT :limit) AND ${fence}`,
      params,
    ),
    sql(
      `DELETE FROM oauth_requests WHERE id IN (SELECT r.id FROM oauth_requests r WHERE r.expires_at <= :now AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.request_id = r.id) LIMIT :limit) AND ${fence}`,
      params,
    ),
    sql(
      `DELETE FROM oauth_clients WHERE id IN (SELECT c.id FROM oauth_clients c WHERE COALESCE(c.last_used_at,c.created_at) <= :before
      AND NOT EXISTS (SELECT 1 FROM mcp_grants g WHERE g.client_id = c.id AND g.revoked_at IS NULL AND g.expires_at > :now)
      AND NOT EXISTS (SELECT 1 FROM oauth_requests r WHERE r.client_id = c.id AND r.expires_at > :now) LIMIT :limit) AND ${fence}`,
      { ...params, before: int(options.now - 86400_000) },
    ),
  ]);
  return { batches: 1, statements: results.length };
}
