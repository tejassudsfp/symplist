import { int, sql } from "@symplist/db";
import type { PurgeContributor } from "./types.ts";

const tables = [
  "vault_grants",
  "vault_sessions",
  "vault_reset_authorizations",
  "vault_unlock_limits",
  "vault_items",
  "vault_audit",
  "vaults",
] as const;
const ownerColumn = (table: string) =>
  table === "vault_reset_authorizations" ? "user_id" : "owner_id";

/** Vault purge statements (§5.6). Vaults, items, sessions, reset authorizations, unlock limits and grants. */
export const vaultPurgeContributor: PurgeContributor = {
  domain: "vault",
  statements: ({ userId, batchLimit }) =>
    tables.map((table) =>
      sql(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${ownerColumn(table)}=:owner ${table === "vault_items" ? "AND NOT EXISTS (SELECT 1 FROM vault_grants g WHERE g.item_id=vault_items.id)" : table === "vaults" ? "AND NOT EXISTS (SELECT 1 FROM vault_items i WHERE i.owner_id=vaults.owner_id) AND NOT EXISTS (SELECT 1 FROM vault_sessions s WHERE s.owner_id=vaults.owner_id) AND NOT EXISTS (SELECT 1 FROM vault_grants g WHERE g.owner_id=vaults.owner_id)" : ""} LIMIT :limit)`,
        { owner: userId, limit: int(batchLimit) },
      ),
    ),
  remaining: ({ userId }) => [
    sql(
      `SELECT (${tables.map((table) => `EXISTS (SELECT 1 FROM ${table} WHERE ${ownerColumn(table)}=:owner)`).join(" OR ")}) AS remaining`,
      { owner: userId },
    ),
  ],
};
