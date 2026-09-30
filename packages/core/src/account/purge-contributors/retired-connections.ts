import { int, sql } from "@symplist/db";
import type { PurgeContributor } from "./types.ts";

/**
 * The tables the connector layer left behind (§5.6, note 18).
 *
 * Composio is gone. It existed so a server-side agent could act on the owner's behalf in Gmail, Slack
 * and the rest, gated by an approval; with no agent on the server there was nothing to gate and nothing
 * calling a connector — the executor had been dead code since chat left. The person's own MCP client
 * brings its own integrations, and better ones.
 *
 * Migrations are expand-only, so `connections`, `connection_attempts`, `connection_state`,
 * `connection_revoke_jobs` and `composio_sessions` stay in the schema, and every row an account wrote
 * before the removal is still sitting in them. Account deletion promises an owner's rows are *gone*,
 * not merely unreachable, so the purge still has to reach them. These are the statements the former
 * `connections` contributor ran.
 *
 * What is not here is its `purgeProvider`. That step revoked the account's connected accounts at
 * Composio and deleted its session there before the local rows went — the one part of a purge that
 * reached outside Symplist. There is no client to call and no credential to call it with, so a purge
 * now completes on the local deletions alone. Any connected account still live at Composio is the
 * operator's to clean up with their own key; there is no code path here that could.
 */
export const retiredConnectionsPurgeContributor: PurgeContributor = {
  domain: "retired-connections",
  statements: ({ userId, batchLimit }) => [
    sql(
      `DELETE FROM connection_revoke_jobs WHERE connected_account_id IN (SELECT connected_account_id FROM connection_revoke_jobs WHERE owner_id = :owner LIMIT :limit)`,
      { owner: userId, limit: int(batchLimit) },
    ),
    sql(
      `DELETE FROM connection_attempts WHERE id IN (SELECT id FROM connection_attempts WHERE user_id = :owner LIMIT :limit)`,
      { owner: userId, limit: int(batchLimit) },
    ),
    sql("DELETE FROM composio_sessions WHERE user_id = :owner", { owner: userId }),
    sql(
      `DELETE FROM connections WHERE id IN
    (SELECT id FROM connections WHERE owner_id = :owner LIMIT :limit)`,
      { owner: userId, limit: int(batchLimit) },
    ),
    sql(
      `DELETE FROM connection_state WHERE owner_id = :owner AND NOT EXISTS (SELECT 1 FROM connections WHERE owner_id = :owner)`,
      { owner: userId },
    ),
  ],
  remaining: ({ userId }) => [
    sql(
      `SELECT (EXISTS (SELECT 1 FROM connections WHERE owner_id = :owner)
      OR EXISTS (SELECT 1 FROM connection_attempts WHERE user_id = :owner)
      OR EXISTS (SELECT 1 FROM composio_sessions WHERE user_id = :owner)
      OR EXISTS (SELECT 1 FROM connection_revoke_jobs WHERE owner_id = :owner)
      OR EXISTS (SELECT 1 FROM connection_state WHERE owner_id = :owner)) AS remaining`,
      {
        owner: userId,
      },
    ),
  ],
};
