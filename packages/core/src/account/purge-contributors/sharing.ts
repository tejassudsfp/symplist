import { int, sql } from "@symplist/db";
import type { PurgeContributor } from "./types.ts";

const tables = [
  "share_sessions",
  "share_limits",
  "share_approvals",
  "share_audit",
  "share_grants",
  "artifacts",
] as const;

/** Sharing purge statements (§5.6). Artifacts, share grants, sessions, approvals, audit rows and limits. */
export const sharingPurgeContributor: PurgeContributor = {
  domain: "sharing",
  statements: ({ userId, batchLimit }) =>
    tables.map((table) => {
      const children =
        table === "share_grants"
          ? ["share_sessions", "share_limits"]
              .map((child) => `AND NOT EXISTS (SELECT 1 FROM ${child} c WHERE c.grant_id = p.id)`)
              .join(" ")
          : table === "artifacts"
            ? ["share_grants", "share_approvals", "share_audit"]
                .map(
                  (child) => `AND NOT EXISTS (SELECT 1 FROM ${child} c WHERE c.artifact_id = p.id)`,
                )
                .join(" ")
            : "";
      return sql(
        `DELETE FROM ${table} WHERE rowid IN (SELECT p.rowid FROM ${table} p WHERE p.owner_id = :owner ${children} LIMIT CAST(:limit AS INTEGER))`,
        { owner: userId, limit: int(batchLimit) },
      );
    }),
  remaining: ({ userId }) => [
    sql(
      `SELECT (${tables.map((table) => `EXISTS (SELECT 1 FROM ${table} WHERE owner_id = :owner)`).join(" OR ")}) AS remaining`,
      { owner: userId },
    ),
  ],
};
