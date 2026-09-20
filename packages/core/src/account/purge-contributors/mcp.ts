import type { PurgeContributor } from "./types.ts";

/** MCP purge statements (§5.6). MCP grants, OAuth requests, codes and refresh tokens. */
export const mcpPurgeContributor: PurgeContributor = {
  domain: "mcp",
  statements: ({ userId, batchLimit }) => [
    sql(
      "DELETE FROM oauth_refresh_tokens WHERE id IN (SELECT id FROM oauth_refresh_tokens WHERE owner_id = :owner LIMIT :limit)",
      { owner: userId, limit: int(batchLimit) },
    ),
    sql(
      "DELETE FROM oauth_codes WHERE id IN (SELECT id FROM oauth_codes WHERE owner_id = :owner LIMIT :limit)",
      { owner: userId, limit: int(batchLimit) },
    ),
    sql(
      "DELETE FROM oauth_requests WHERE id IN (SELECT r.id FROM oauth_requests r WHERE r.owner_id = :owner AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.request_id = r.id) LIMIT :limit)",
      { owner: userId, limit: int(batchLimit) },
    ),
    sql(
      "DELETE FROM mcp_grants WHERE id IN (SELECT g.id FROM mcp_grants g WHERE g.owner_id = :owner AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens t WHERE t.grant_id = g.id) AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.grant_id = g.id) AND NOT EXISTS (SELECT 1 FROM oauth_requests r WHERE r.grant_id = g.id) LIMIT :limit)",
      { owner: userId, limit: int(batchLimit) },
    ),
  ],
  remaining: ({ userId }) => [
    sql(
      `SELECT (EXISTS (SELECT 1 FROM mcp_grants WHERE owner_id = :owner) OR EXISTS (SELECT 1 FROM oauth_requests WHERE owner_id = :owner) OR EXISTS (SELECT 1 FROM oauth_codes WHERE owner_id = :owner) OR EXISTS (SELECT 1 FROM oauth_refresh_tokens WHERE owner_id = :owner)) AS remaining`,
      { owner: userId },
    ),
  ],
};

import { int, sql } from "@symplist/db";
