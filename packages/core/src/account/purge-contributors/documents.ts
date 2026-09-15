import { int, sql } from "@symplist/db";
import type { PurgeContributor } from "./types.ts";

/**
 * Documents purge statements (§5.6): read receipts, publication requests, drafts, published commits
 * and repositories, children first and at most `batchLimit` rows per statement. A commit row is
 * deleted only once no request or receipt references it, and a repository only once its commits are
 * gone, so every statement satisfies the foreign keys whatever the batch order D1 applies. The
 * encrypted bundles, head snapshots and job objects live under `u/<userId>/` and are deleted by the
 * purge's R2 step (one `DeleteObject` per key, bounded per invocation) before this domain runs; the
 * crypto-shred already made them unreadable.
 */
export const documentsPurgeContributor: PurgeContributor = {
  domain: "documents",
  statements: ({ userId, batchLimit }) => {
    const params = { user: userId, limit: int(batchLimit) };
    return [
      sql(
        `DELETE FROM read_receipts WHERE rowid IN (
           SELECT rowid FROM read_receipts WHERE owner_id = :user LIMIT CAST(:limit AS INTEGER))`,
        params,
      ),
      sql(
        `DELETE FROM doc_publish_requests WHERE rowid IN (
           SELECT rowid FROM doc_publish_requests WHERE owner_id = :user LIMIT CAST(:limit AS INTEGER))`,
        params,
      ),
      sql(
        `DELETE FROM doc_drafts WHERE rowid IN (
           SELECT rowid FROM doc_drafts WHERE owner_id = :user LIMIT CAST(:limit AS INTEGER))`,
        params,
      ),
      sql(
        `DELETE FROM doc_commits WHERE rowid IN (
           SELECT c.rowid FROM doc_commits c WHERE c.owner_id = :user
             AND NOT EXISTS (SELECT 1 FROM doc_publish_requests r
                             WHERE r.task_id = c.task_id AND r.commit_id = c.commit_id)
             AND NOT EXISTS (SELECT 1 FROM read_receipts e
                             WHERE e.task_id = c.task_id AND e.commit_id = c.commit_id)
           LIMIT CAST(:limit AS INTEGER))`,
        params,
      ),
      sql(
        `DELETE FROM doc_repos WHERE rowid IN (
           SELECT p.rowid FROM doc_repos p WHERE p.owner_id = :user
             AND NOT EXISTS (SELECT 1 FROM doc_commits c WHERE c.task_id = p.task_id)
           LIMIT CAST(:limit AS INTEGER))`,
        params,
      ),
    ];
  },
  remaining: ({ userId }) => [
    sql(
      `SELECT (
         EXISTS (SELECT 1 FROM read_receipts WHERE owner_id = :user)
         OR EXISTS (SELECT 1 FROM doc_publish_requests WHERE owner_id = :user)
         OR EXISTS (SELECT 1 FROM doc_drafts WHERE owner_id = :user)
         OR EXISTS (SELECT 1 FROM doc_commits WHERE owner_id = :user)
         OR EXISTS (SELECT 1 FROM doc_repos WHERE owner_id = :user)
       ) AS remaining`,
      { user: userId },
    ),
  ],
};
