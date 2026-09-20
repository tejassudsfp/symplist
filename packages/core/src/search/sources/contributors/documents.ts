import type { AccountDataKey } from "@symplist/crypto";
import { type DbClient, int, sql } from "@symplist/db";
import {
  ArtifactIntegrityError,
  DocumentArtifacts,
  type DocumentSnapshot,
  markdown,
  snapshotObjectKey,
} from "@symplist/docs";
import type { SearchDocumentInput, SearchSectionInput } from "@symplist/search";
import type { ObjectStore } from "@symplist/storage";
import { accessCondition } from "../../../access/sql.ts";
import type { SearchPage, SearchSourceContributor } from "../types.ts";

/** One source page is deliberately small enough for a D1 response and R2 read budget. */
export const DOCUMENT_HEAD_PAGE_LIMIT = 100;
/** Head reads use a single bounded list per request, never one D1 query per task. */
export const DOCUMENT_HEAD_READ_CHUNK = 50;

function admitted(policy: { readonly betaAccessRequired: boolean } | undefined): string {
  return accessCondition({
    level: "admitted",
    policy: policy ?? { betaAccessRequired: true },
    userParam: "search_document_owner",
  });
}

function checkedPage(page: SearchPage): { readonly after: string; readonly limit: number } {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > DOCUMENT_HEAD_PAGE_LIMIT)
    throw new RangeError("Search document page is outside its bounded limit");
  return { after: page.after ?? "", limit: page.limit };
}

/** The snapshot already contains the bounded structural section index; no Git/history is read here. */
function sections(snapshot: DocumentSnapshot): readonly SearchSectionInput[] {
  return snapshot.index.sections.map((section, ordinal) => {
    const source = snapshot.markdown.slice(section.start, section.end);
    const parsed = markdown.parseDocument(source);
    const text = parsed.mode === "parsed" ? markdown.plainTextOf(parsed.tree) : source;
    return { sectionId: section.id, ordinal, heading: section.heading, text };
  });
}

/**
 * Reads only the owner's current encrypted head snapshots. The D1 row names an immutable snapshot;
 * `DocumentArtifacts` authenticates its owner/task/revision AAD before a section reaches the index.
 */
export class D1DocumentTextSource {
  private readonly artifacts: DocumentArtifacts;

  constructor(
    private readonly db: DbClient,
    objects: ObjectStore,
    private readonly policy?: { readonly betaAccessRequired: boolean },
  ) {
    this.artifacts = new DocumentArtifacts({ objects });
  }

  async listHeads(ownerId: string, page: SearchPage) {
    const checked = checkedPage(page);
    const rows = await this.db.all(
      sql(
        `SELECT r.task_id, r.head_commit_id
         FROM doc_repos r JOIN tasks t ON t.id = r.task_id AND t.owner_id = r.owner_id
         WHERE r.owner_id = :owner AND r.task_id > :after AND ${admitted(this.policy)}
         ORDER BY r.task_id LIMIT :limit`,
        {
          owner: ownerId,
          after: checked.after,
          limit: int(checked.limit),
          search_document_owner: ownerId,
        },
      ),
    );
    return rows.flatMap((row) =>
      typeof row.task_id === "string" && typeof row.head_commit_id === "string"
        ? [{ taskId: row.task_id, revision: row.head_commit_id }]
        : [],
    );
  }

  async readHeads(ownerId: string, taskIds: readonly string[], key: AccountDataKey) {
    const found = new Map<string, SearchDocumentInput>();
    const unique = [...new Set(taskIds)];
    for (let start = 0; start < unique.length; start += DOCUMENT_HEAD_READ_CHUNK) {
      const ids = unique.slice(start, start + DOCUMENT_HEAD_READ_CHUNK);
      const rows = await this.db.all(
        sql(
          `SELECT r.task_id, r.head_commit_id, r.snapshot_key
           FROM doc_repos r JOIN tasks t ON t.id = r.task_id AND t.owner_id = r.owner_id
           WHERE r.owner_id = :owner AND r.task_id IN (:ids) AND ${admitted(this.policy)}`,
          { owner: ownerId, ids, search_document_owner: ownerId },
        ),
      );
      for (const row of rows) {
        if (
          typeof row.task_id !== "string" ||
          typeof row.head_commit_id !== "string" ||
          typeof row.snapshot_key !== "string"
        )
          continue;
        const ref = { ownerId, taskId: row.task_id, commitId: row.head_commit_id };
        // The D1 key is metadata, not authority: reject a row that points outside its frozen key.
        if (row.snapshot_key !== snapshotObjectKey(ref)) continue;
        try {
          const snapshot = await this.artifacts.getSnapshot(key, ref);
          found.set(row.task_id, {
            taskId: row.task_id,
            revision: row.head_commit_id,
            sections: sections(snapshot),
          });
        } catch (error) {
          // An immutable snapshot with invalid ciphertext/AAD is unavailable, never plaintext fallback.
          // A store outage still fails the run so the durable intent retries instead of publishing a
          // silently incomplete corpus.
          if (!(error instanceof ArtifactIntegrityError)) throw error;
        }
      }
    }
    return found;
  }

  headRevisionsStatement(ownerId: string, taskIds: readonly string[]) {
    const ids = [...new Set(taskIds)];
    if (ids.length > DOCUMENT_HEAD_READ_CHUNK)
      throw new RangeError("Search head rendering exceeds its bounded task list");
    return sql(
      `SELECT r.task_id, r.head_commit_id AS revision
       FROM doc_repos r JOIN tasks t ON t.id = r.task_id AND t.owner_id = r.owner_id
       WHERE r.owner_id = :owner AND r.task_id IN (:ids) AND ${admitted(this.policy)}`,
      { owner: ownerId, ids, search_document_owner: ownerId },
    );
  }
}

/**
 * The documents feature's search source (§9.2, §10.1). It adds `documents`: a `DocumentTextSource`
 * reading current heads from `doc_repos` and the immutable encrypted head snapshots, returning plain
 * text sections. Until it does, no task has a document, so search indexes titles only.
 */
export const documentsSearchSourceContributor: SearchSourceContributor = {
  domain: "documents",
  documents: ({ db, objects, accessPolicy }) => new D1DocumentTextSource(db, objects, accessPolicy),
};
