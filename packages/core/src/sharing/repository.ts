import { createHash } from "node:crypto";
import type {
  HandoffRequest,
  SharingArtifact,
  SharingList,
  SharingListQuery,
  SharingPreview,
  SharingSnapshotRequest,
} from "@symplist/contracts";
import {
  type AccountDataKey,
  canonicalJson,
  decryptObject,
  encryptObject,
  zeroize,
} from "@symplist/crypto";
import { type DbRow, int, type Statement, sql, uuidv7 } from "@symplist/db";
import { DocumentArtifacts, type SqlGuard } from "@symplist/docs";
import { accessCondition } from "../access/index.ts";
import { AccountKeyStore } from "../account/index.ts";
import { actorGuards, authorizeActor, type DocumentActor } from "../documents/actor.ts";
import { exportMarkdown, handoffTemplate } from "./content.ts";
import {
  artifactObjectContext,
  artifactView,
  grantView,
  sharingDecrypt,
  sharingEncrypt,
} from "./fields.ts";
import { SharingError, type SharingFold, type SharingOptions } from "./types.ts";

export class SharingRepository {
  readonly accountKeys: AccountKeyStore;
  readonly snapshots: DocumentArtifacts;
  constructor(readonly options: SharingOptions) {
    this.accountKeys = new AccountKeyStore(options);
    this.snapshots = new DocumentArtifacts({ objects: options.objects });
  }

  access(ownerId: string): SqlGuard {
    return {
      sql: accessCondition({
        level: "admitted",
        policy: this.options.policy,
        userParam: "share_owner",
      }),
      params: { share_owner: ownerId },
    };
  }
  active(ownerId: string, taskId: string): SqlGuard {
    const access = this.access(ownerId);
    return {
      sql: `${access.sql} AND EXISTS (SELECT 1 FROM tasks WHERE id = :share_task AND owner_id = :share_owner AND status = 'active') AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = :share_owner)`,
      params: { ...access.params, share_task: taskId },
    };
  }
  guards(...guards: readonly (SqlGuard | undefined)[]): SqlGuard {
    return {
      sql: guards
        .filter(Boolean)
        .map((guard) => `(${guard?.sql})`)
        .join(" AND "),
      params: Object.assign({}, ...guards.map((guard) => guard?.params ?? {})),
    };
  }
  effect(
    table: "artifacts" | "share_grants" | "share_approvals",
    id: string,
    write: string,
  ): SqlGuard {
    return {
      sql: `EXISTS (SELECT 1 FROM ${table} WHERE id = :effect_id AND write_id = :effect_write)`,
      params: { effect_id: id, effect_write: write },
    };
  }
  async write<T>(input: {
    key: AccountDataKey;
    body: T;
    statements: readonly Statement[];
    effect: SqlGuard;
    fold?: SharingFold;
    onApplied?: () => Promise<void>;
    failure?: "sharing.stale" | "sharing.expiry_invalid";
  }): Promise<T> {
    const results = await this.options.db.batch([
      ...(input.fold?.prefix ?? []),
      ...input.statements,
      ...(input.fold?.complete(input.body, input.key, input.effect) ?? []),
      sql(`SELECT 1 AS applied WHERE ${input.effect.sql}`, input.effect.params),
    ]);
    const decision = input.fold?.decide(results, input.key);
    if (decision) return decision.replay as T;
    if (!results.at(-1)?.results[0]) throw new SharingError(input.failure ?? "sharing.stale");
    try {
      await input.onApplied?.();
    } catch {
      // Analytics is best-effort and must never turn a committed write into a failed action.
    }
    return input.body;
  }
  fingerprint(input: unknown): string {
    return createHash("sha256").update(canonicalJson(input)).digest("hex");
  }

  async snapshot(
    actor: DocumentActor,
    taskId: string,
    input: SharingSnapshotRequest,
    requestId: string,
    fold?: SharingFold,
    handoff?: HandoffRequest,
  ): Promise<SharingArtifact> {
    authorizeActor(actor, taskId, "write");
    const owner = actor.userId;
    const startedAt = this.options.now();
    const guard = this.guards(this.active(owner, taskId), ...actorGuards(actor));
    const read = await this.options.db.batch([
      sql(
        `SELECT k.*, r.head_commit_id AS current_head FROM account_keys k
        JOIN doc_repos r ON r.owner_id = k.owner_id AND r.task_id = :task
        WHERE k.owner_id = :owner AND ${guard.sql}
        AND EXISTS (SELECT 1 FROM doc_commits WHERE owner_id = :owner AND task_id = :task AND commit_id = :revision)`,
        { ...guard.params, owner, task: taskId, revision: input.revision },
      ),
      sql(
        "SELECT a.*, r.head_commit_id AS current_head FROM artifacts a LEFT JOIN doc_repos r ON r.task_id = a.task_id WHERE a.owner_id = :owner AND a.request_id = :request",
        { owner, request: requestId },
      ),
      ...(handoff
        ? [
            sql(
              "SELECT id FROM artifacts WHERE owner_id = :owner AND task_id = :task AND deleted_at IS NULL AND id IN (:ids)",
              { owner, task: taskId, ids: handoff.artifactIds },
            ),
          ]
        : []),
    ]);
    const row = read[0]?.results[0];
    if (!row) throw new SharingError("not_found");
    const key = this.accountKeys.unwrapRow(row);
    try {
      const fingerprint = this.fingerprint({ taskId, input, handoff });
      const existing = read[1]?.results[0];
      if (existing) {
        if (
          sharingDecrypt(
            key,
            "artifacts",
            String(existing.id),
            "fingerprint_enc",
            String(existing.fingerprint_enc),
          ) !== fingerprint
        )
          throw new SharingError("idempotency.mismatch");
        if (!fold) return artifactView(existing, key);
        // Folded HTTP replay is decided below; reuse the immutable object and original metadata.
      }
      if (handoff && new Set(handoff.artifactIds).size !== read[2]?.results.length)
        throw new SharingError("not_found");
      const snapshot = await this.snapshots.getSnapshot(key, {
        ownerId: owner,
        taskId,
        commitId: input.revision,
      });
      const selected = [...new Set(input.sectionIds)];
      const sections = snapshot.index.sections.filter((section) => selected.includes(section.id));
      if (sections.length !== selected.length) throw new SharingError("not_found");
      const markdown = handoff
        ? handoffTemplate(handoff.prompt, handoff.artifactIds, this.options.privateOrigins)
        : exportMarkdown(
            selected.length === 0
              ? snapshot.markdown
              : sections
                  .map((section) => snapshot.markdown.slice(section.start, section.end))
                  .join("\n\n"),
            this.options.privateOrigins,
          );
      const bytes = Buffer.byteLength(markdown);
      if (bytes > (this.options.maxBytes ?? 1_048_576))
        throw new SharingError("document.too_large");
      const id = existing ? String(existing.id) : uuidv7();
      const now = existing ? Number(existing.created_at) : this.options.now();
      const write = uuidv7();
      const objectKey = `u/${owner}/artifacts/${id}.md.sym`;
      if (!existing)
        await this.options.objects.put({
          key: objectKey,
          body: encryptObject(key, artifactObjectContext(owner, id), Buffer.from(markdown)),
          ifNoneMatch: "*",
          metadata: { "write-id": write },
          contentType: "application/octet-stream",
        });
      const body: SharingArtifact = existing
        ? artifactView(existing, key)
        : {
            id,
            taskId,
            title: input.title,
            sourceRevision: input.revision,
            currentHead: String(row.current_head),
            sectionIds: selected,
            bytes,
            createdAt: now,
            kind: handoff ? "handoff" : "document",
          };
      // Refresh trusted actor guards after object I/O: expiry may cross during upload.
      const deciding = this.guards(this.active(owner, taskId), ...actorGuards(actor), fold?.guard, {
        sql: "EXISTS (SELECT 1 FROM doc_repos WHERE owner_id = :snapshot_owner AND task_id = :snapshot_task AND head_commit_id = :snapshot_head)",
        params: {
          snapshot_owner: owner,
          snapshot_task: taskId,
          snapshot_head: String(row.current_head),
        },
      });
      const effect = this.effect("artifacts", id, write);
      // A delayed upload may never publish after the orphan collector's 24-hour grace period.
      if (!existing && this.options.now() - startedAt >= 600_000)
        throw new SharingError("sharing.stale");
      return await this.write({
        key,
        body,
        effect,
        ...(fold ? { fold } : {}),
        ...(handoff
          ? {
              onApplied: async () => {
                await this.options.onConfirmed?.(
                  owner,
                  "handoff_prepared",
                  {
                    target: handoff.target,
                    sections: "whole_document",
                    author: actor.kind === "simon" ? "simon" : "user",
                  },
                  write,
                );
              },
            }
          : {}),
        statements: [
          sql(
            `INSERT INTO artifacts (id, owner_id, task_id, kind, title_enc, source_revision, selection_json, object_key, bytes, request_id, fingerprint_enc, created_at, write_id)
          SELECT :id, :owner, :task, :kind, :title, :revision, :selection, :object, :bytes, :request, :fingerprint, :now, :write WHERE ${deciding.sql} ON CONFLICT DO NOTHING`,
            {
              ...deciding.params,
              id,
              owner,
              task: taskId,
              kind: body.kind,
              title: sharingEncrypt(key, "artifacts", id, "title_enc", input.title),
              revision: input.revision,
              selection: JSON.stringify(selected),
              object: objectKey,
              bytes: int(bytes),
              request: requestId,
              fingerprint: sharingEncrypt(key, "artifacts", id, "fingerprint_enc", fingerprint),
              now: int(now),
              write,
            },
          ),
          sql(
            `INSERT INTO share_audit (id, owner_id, artifact_id, action, created_at) SELECT :id, :owner, :artifact, :action, :now WHERE ${effect.sql}`,
            {
              ...effect.params,
              id: uuidv7(),
              owner,
              artifact: id,
              action: handoff ? "handoff" : "snapshot",
              now: int(now),
            },
          ),
        ],
      });
    } finally {
      zeroize(key.key);
    }
  }

  async list(
    actor: DocumentActor,
    taskId: string,
    query: SharingListQuery = {},
  ): Promise<SharingList> {
    authorizeActor(actor, taskId, "read");
    const guard = this.guards(this.access(actor.userId), ...actorGuards(actor));
    const results = await this.options.db.batch([
      sql(
        `SELECT k.* FROM account_keys k WHERE k.owner_id = :owner AND ${guard.sql} AND EXISTS (SELECT 1 FROM tasks WHERE id = :task AND owner_id = :owner)`,
        { ...guard.params, owner: actor.userId, task: taskId },
      ),
      sql(
        `SELECT a.*, r.head_commit_id AS current_head FROM artifacts a LEFT JOIN doc_repos r ON r.task_id = a.task_id WHERE a.owner_id = :owner AND a.task_id = :task AND a.deleted_at IS NULL ${query.beforeArtifact === "end" ? "AND 0" : query.beforeArtifact ? "AND a.id < :before" : ""} ORDER BY a.id DESC LIMIT 51`,
        {
          owner: actor.userId,
          task: taskId,
          ...(query.beforeArtifact && query.beforeArtifact !== "end"
            ? { before: query.beforeArtifact }
            : {}),
        },
      ),
      sql(
        `SELECT g.* FROM share_grants g JOIN artifacts a ON a.id = g.artifact_id WHERE g.owner_id = :owner AND a.task_id = :task AND a.deleted_at IS NULL ${query.beforeGrant === "end" ? "AND 0" : query.beforeGrant ? "AND g.id < :before" : ""} ORDER BY g.id DESC LIMIT 201`,
        {
          owner: actor.userId,
          task: taskId,
          ...(query.beforeGrant && query.beforeGrant !== "end"
            ? { before: query.beforeGrant }
            : {}),
        },
      ),
    ]);
    const row = results[0]?.results[0];
    if (!row) throw new SharingError("not_found");
    const key = this.accountKeys.unwrapRow(row);
    try {
      return {
        artifacts: (results[1]?.results ?? []).slice(0, 50).map((row) => artifactView(row, key)),
        grants: (results[2]?.results ?? [])
          .slice(0, 200)
          .map((row) => grantView(row, this.options.now())),
        hasMore: (results[1]?.results.length ?? 0) > 50 || (results[2]?.results.length ?? 0) > 200,
        nextArtifact:
          (results[1]?.results.length ?? 0) > 50 ? String(results[1]?.results[49]?.id) : null,
        nextGrant:
          (results[2]?.results.length ?? 0) > 200 ? String(results[2]?.results[199]?.id) : null,
      };
    } finally {
      zeroize(key.key);
    }
  }

  async loadArtifact(
    owner: string,
    id: string,
    extra: readonly Statement[] = [],
    actorConditions: readonly SqlGuard[] = [],
  ) {
    const guard = this.guards(this.access(owner), ...actorConditions);
    const results = await this.options.db.batch([
      sql(
        `SELECT a.*, r.head_commit_id AS current_head, k.kek_version, k.wrapped_key FROM artifacts a
        JOIN account_keys k ON k.owner_id = a.owner_id LEFT JOIN doc_repos r ON r.task_id = a.task_id
        WHERE a.id = :id AND a.owner_id = :owner AND a.deleted_at IS NULL AND ${guard.sql}`,
        { ...guard.params, id, owner },
      ),
      ...extra,
    ]);
    const row = results[0]?.results[0];
    if (!row) throw new SharingError("not_found");
    return { row, key: this.accountKeys.unwrapRow(row), extra: results.slice(1) };
  }
  async content(row: DbRow, key: AccountDataKey): Promise<string> {
    const stored = await this.options.objects.get(String(row.object_key));
    if (!stored) throw new SharingError("sharing.unavailable");
    return Buffer.from(
      decryptObject(key, artifactObjectContext(key.ownerId, String(row.id)), stored.body),
    ).toString("utf8");
  }
  async preview(owner: string, id: string): Promise<SharingPreview> {
    const loaded = await this.loadArtifact(owner, id, [
      sql(
        "SELECT id FROM share_grants WHERE owner_id = :owner AND artifact_id = :id AND mode = 'public' AND status = 'active' AND (expires_at IS NULL OR expires_at > :now) LIMIT 1",
        { owner, id, now: int(this.options.now()) },
      ),
    ]);
    try {
      return {
        artifact: artifactView(loaded.row, loaded.key),
        markdown: await this.content(loaded.row, loaded.key),
        hasPublicCopy: Boolean(loaded.extra[0]?.results[0]),
      };
    } finally {
      zeroize(loaded.key.key);
    }
  }
}
