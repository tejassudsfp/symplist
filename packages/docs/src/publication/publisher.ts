import { createHash } from "node:crypto";
import type { AccountDataKey, FieldEnvelopeContext, RandomOptions } from "@symplist/crypto";
import {
  canonicalJson,
  constantTimeEqual,
  DATA_KEY_VERSION,
  decryptFieldText,
  encryptFieldText,
  zeroize,
} from "@symplist/crypto";
import {
  type DbClient,
  DbUnknownOutcomeError,
  int,
  json,
  type Statement,
  type StatementResult,
  sql,
  uuidv7,
  verifiedRow,
} from "@symplist/db";
import { BUNDLE_FORMAT_VERSION } from "../artifacts/keys.ts";
import {
  ArtifactIntegrityError,
  type DocumentAuthorKind,
  type DocumentCommitKind,
  type DocumentSnapshot,
} from "../artifacts/snapshot.ts";
import type { DocumentArtifacts } from "../artifacts/store.ts";
import { DocumentError } from "../errors.ts";
import { GitError } from "../git/errors.ts";
import type { GitRepository } from "../git/repository.ts";
import type { GitService } from "../git/service.ts";
import { utf8ByteLength } from "../markdown/index.ts";
import { compareSectionIndexes, type SectionChange } from "../sections/changes.ts";
import { buildSectionIndex, rebindSectionIndex } from "../sections/section-index.ts";
import { commitMessage, commitSubject, identityFor, reconstructRepository } from "./history.ts";
import {
  type RepoRecord,
  type RequestRecord,
  repoFromRow,
  requestFromRow,
  selectRepoStatement,
  selectRequestStatement,
} from "./records.ts";

/** A SQL condition with its named parameters, folded into a deciding statement. */
export interface SqlGuard {
  readonly sql: string;
  readonly params: Readonly<Record<string, string>>;
}

/** Bounds on what a publication may write (§9.1, note 11 "R2: encrypted Git artifacts"). */
export interface PublicationLimits {
  /** `DOC_MAX_BYTES`. */
  readonly maxDocumentBytes: number;
  /** Largest encrypted bundle; beyond it the write is refused with `document.history_too_large`. */
  readonly maxBundleBytes: number;
  /** How long a request id replays its publication. */
  readonly requestRetentionMs: number;
}

export const DEFAULT_PUBLICATION_LIMITS: PublicationLimits = Object.freeze({
  maxDocumentBytes: 1_048_576,
  maxBundleBytes: 64 * 1024 * 1024,
  requestRetentionMs: 7 * 24 * 60 * 60 * 1000,
});

/** The published head a publication starts from. */
export interface CurrentDocument {
  readonly repo: RepoRecord;
  readonly markdown: string;
  readonly snapshot: DocumentSnapshot;
}

export interface EditContext {
  /** The reconstructed private repository (the head is checked out as `refs/heads/main`). */
  readonly repository: GitRepository;
  /** Null when the task has no published document yet. */
  readonly current: CurrentDocument | null;
}

/** The document a publication commits. */
export interface DocumentEdit {
  readonly kind: Exclude<DocumentCommitKind, "create">;
  readonly markdown: string;
  /** Required for `restore`. */
  readonly restoredFrom?: string | null;
  readonly restoredFromCommittedAt?: number | null;
}

/**
 * Who may publish and the caller's own reads, from the domain service: the task, access state and the
 * account key row are read in the same batch as the head, and the guards (active task, admitted
 * access, executor generation) are folded into the deciding statement (§2.1, §3.1, §5.4).
 */
export interface PublicationContext {
  readonly statements: readonly Statement[];
  /** Throws the caller's error for a missing task, an archived task or lost access; returns the key. */
  verify(results: readonly StatementResult[]): AccountDataKey;
  readonly guards: readonly SqlGuard[];
}

/**
 * An idempotency claim folded into the publication batch (§6.1 folding, api `@Idempotent({ folded:
 * true })`): its statements go first, its guard joins the deciding statement, its completion follows
 * the effect, and `inspect` reads its decision.
 */
export interface PublicationFold {
  readonly prefix: readonly Statement[];
  readonly guard?: SqlGuard;
  suffix(input: {
    readonly outcome: FoldableOutcome;
    /** The head write-id guard; null for a batch that publishes nothing (a replay or no change). */
    readonly headGuard: SqlGuard | null;
    readonly accountKey: AccountDataKey;
  }): readonly Statement[];
  /** Returns the recorded response when the batch found an exact retry; throws for a mismatch. */
  inspect(
    results: readonly StatementResult[],
    accountKey: AccountDataKey,
  ): { readonly replay: unknown } | null;
}

/** The outcomes a folded claim records: a publication (new or replayed) or no change. */
export type FoldableOutcome =
  | { readonly status: "published"; readonly document: PublishedDocument }
  | { readonly status: "unchanged"; readonly commitId: string | null; readonly generation: number };

export interface PublishInput {
  readonly ownerId: string;
  readonly taskId: string;
  /** The request id's scope, for example `save`, `restore`, `simon` or `mcp:<grantId>`. */
  readonly scope: string;
  readonly requestId: string;
  /** The validated input; only an encrypted digest of it is stored. */
  readonly fingerprint: unknown;
  /** The revision the caller edited; null when it expects no published document. */
  readonly expectedBase: string | null;
  readonly author: DocumentAuthorKind;
  readonly now: number;
  readonly context: PublicationContext;
  /** Computes the new document from the reconstructed head. May throw a `DocumentError`. */
  edit(context: EditContext): Promise<DocumentEdit> | DocumentEdit;
  /** Statements that must commit only with the publication (search intent, draft clean-up, receipts). */
  dependents?(guard: SqlGuard, document: PublishedDocument): readonly Statement[];
  readonly fold?: PublicationFold;
}

/** A publication as recorded: ids, generation and provenance only. */
export interface PublishedDocument {
  readonly taskId: string;
  readonly commitId: string;
  readonly parentCommitId: string | null;
  readonly generation: number;
  readonly author: DocumentAuthorKind;
  readonly kind: DocumentCommitKind;
  readonly restoredFrom: string | null;
  readonly committedAt: number;
  /** Sections of the new revision that were added or modified. */
  readonly changedSectionIds: readonly string[];
}

export type PublicationOutcome =
  | {
      readonly status: "published";
      readonly replayed: boolean;
      readonly document: PublishedDocument;
    }
  | { readonly status: "unchanged"; readonly commitId: string | null; readonly generation: number }
  | {
      readonly status: "conflict";
      readonly currentCommitId: string | null;
      readonly currentGeneration: number;
    }
  | { readonly status: "fold_replay"; readonly body: unknown };

/** Hooks that let tests stop a publication at each crash point of note 11's acceptance list. */
export interface PublicationHooks {
  beforeUpload?(): Promise<void> | void;
  afterUpload?(keys: {
    readonly bundleKey: string;
    readonly snapshotKey: string;
  }): Promise<void> | void;
  beforePublish?(): Promise<void> | void;
}

export interface DocumentPublisherOptions {
  readonly db: DbClient;
  readonly git: GitService;
  readonly artifacts: DocumentArtifacts;
  readonly limits?: Partial<PublicationLimits>;
  readonly random?: RandomOptions;
  readonly hooks?: PublicationHooks;
  /**
   * Uploads older than this are never published: orphan collection may delete unreferenced objects
   * once they are older than its grace period, so a publication stalled past half of it gives up
   * (`rate.limited`) and the caller retries with fresh uploads. Defaults to 30 minutes.
   */
  readonly maxUploadAgeMs?: number;
  /** A monotonic clock in milliseconds; defaults to `performance.now`. */
  readonly monotonic?: () => number;
}

const scopePattern = /^[A-Za-z0-9:_-]{1,160}$/;
const requestPattern = /^[A-Za-z0-9._:-]{1,128}$/;

function fingerprintContext(
  ownerId: string,
  scope: string,
  requestId: string,
): FieldEnvelopeContext {
  return {
    purpose: "doc_request_fingerprint",
    ownerId,
    table: "doc_publish_requests",
    rowId: canonicalJson([scope, requestId]),
    column: "fingerprint_enc",
  };
}

function digestInput(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("base64url");
}

/** The digest of document text used in fingerprints, so fingerprints never hash megabytes of JSON. */
export function contentDigest(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("base64url");
}

function guardSql(guards: readonly SqlGuard[]): {
  readonly text: string;
  readonly params: Record<string, string>;
} {
  const params: Record<string, string> = {};
  for (const guard of guards) {
    for (const [name, value] of Object.entries(guard.params)) {
      if (name.startsWith("pub_"))
        throw new TypeError("Guard parameters may not use the pub_ prefix");
      if (Object.hasOwn(params, name) && params[name] !== value) {
        throw new TypeError(`Guard parameter ${name} is bound twice with different values`);
      }
      params[name] = value;
    }
  }
  return { text: guards.map((guard) => `AND ${guard.sql}`).join("\n  "), params };
}

interface PreparedPublication {
  readonly document: PublishedDocument;
  readonly snapshot: DocumentSnapshot;
  readonly bundle: Buffer;
  readonly commitCount: number;
  readonly documentBytes: number;
}

/**
 * The publication protocol (§9.2, note 11 "Atomic publication and concurrency"):
 *
 * 1. One read batch: head row, request row and the caller's task, access and key reads. An exact retry
 *    returns its recorded publication; the same request id with other input is refused; a base that
 *    is not the head is a conflict before any work.
 * 2. Reconstruct the head in a private repository, apply the edit, and create a real child commit with
 *    explicit parent, identity and date; verify, and bundle the complete history.
 * 3. Encrypt and upload the bundle and the immutable head snapshot with `If-None-Match: *`.
 * 4. One publication batch: the head update conditional on base, generation, request id and the
 *    caller's guards, then (guarded by its write id) the commit row, request row, search intent and
 *    dependents, then the verification select. A lost race publishes nothing and is a conflict.
 * 5. An unknown batch outcome is reconciled by request id; uploaded objects are never deleted here
 *    (orphan collection removes unreferenced ones after a grace period).
 */
export class DocumentPublisher {
  private readonly db: DbClient;
  private readonly git: GitService;
  private readonly artifacts: DocumentArtifacts;
  private readonly limits: PublicationLimits;
  private readonly random: RandomOptions | undefined;
  private readonly hooks: PublicationHooks;
  private readonly maxUploadAgeMs: number;
  private readonly monotonic: () => number;

  constructor(options: DocumentPublisherOptions) {
    this.db = options.db;
    this.git = options.git;
    this.artifacts = options.artifacts;
    this.limits = Object.freeze({ ...DEFAULT_PUBLICATION_LIMITS, ...options.limits });
    this.random = options.random;
    this.hooks = options.hooks ?? {};
    this.maxUploadAgeMs = options.maxUploadAgeMs ?? 30 * 60 * 1000;
    this.monotonic = options.monotonic ?? (() => performance.now());
  }

  async publish(input: PublishInput): Promise<PublicationOutcome> {
    if (!scopePattern.test(input.scope) || !requestPattern.test(input.requestId)) {
      throw new TypeError("Invalid publication request id");
    }
    const read = await this.readState(input);
    const accountKey = read.accountKey;
    try {
      if (read.request) return await this.replay(input, read.request, accountKey);
      const head = read.repo?.headCommitId ?? null;
      if (head !== input.expectedBase) {
        return {
          status: "conflict",
          currentCommitId: head,
          currentGeneration: read.repo?.generation ?? 0,
        };
      }
      const prepared = await this.prepare(input, read.repo, accountKey);
      if (prepared === "unchanged") {
        const outcome = {
          status: "unchanged",
          commitId: head,
          generation: read.repo?.generation ?? 0,
        } as const;
        if (input.fold) {
          const results = await this.db.batch([
            ...input.fold.prefix,
            ...input.fold.suffix({ outcome, headGuard: null, accountKey }),
          ]);
          const decision = input.fold.inspect(results, accountKey);
          if (decision) return { status: "fold_replay", body: decision.replay };
        }
        return outcome;
      }
      return await this.upload(input, read.repo, prepared, accountKey);
    } finally {
      zeroize(accountKey.key);
    }
  }

  private async readState(input: PublishInput): Promise<{
    readonly repo: RepoRecord | null;
    readonly request: RequestRecord | null;
    readonly accountKey: AccountDataKey;
  }> {
    const results = await this.db.batch([
      selectRepoStatement(input.ownerId, input.taskId),
      selectRequestStatement(input.ownerId, input.scope, input.requestId),
      ...input.context.statements,
    ]);
    const accountKey = input.context.verify(results.slice(2));
    try {
      const repoRow = results[0]?.results[0];
      const requestRow = results[1]?.results[0];
      return {
        repo: repoRow ? repoFromRow(repoRow) : null,
        request: requestRow ? requestFromRow(requestRow) : null,
        accountKey,
      };
    } catch (error) {
      zeroize(accountKey.key);
      throw error;
    }
  }

  private fingerprintMatches(
    input: PublishInput,
    request: RequestRecord,
    accountKey: AccountDataKey,
  ): boolean {
    if (request.taskId !== input.taskId) return false;
    let stored: string;
    try {
      stored = decryptFieldText(
        accountKey,
        fingerprintContext(input.ownerId, input.scope, input.requestId),
        request.fingerprintEnc,
      );
    } catch {
      throw new DocumentError("document.integrity_failed");
    }
    return constantTimeEqual(stored, digestInput(input.fingerprint));
  }

  /** An exact retry of a recorded publication: return it (and complete a folded claim) without Git. */
  private async replay(
    input: PublishInput,
    request: RequestRecord,
    accountKey: AccountDataKey,
  ): Promise<PublicationOutcome> {
    if (!this.fingerprintMatches(input, request, accountKey)) {
      throw new DocumentError("idempotency.mismatch");
    }
    const commit = await this.db.first(
      sql(
        `SELECT parent_commit_id, author, kind, restored_from_commit_id, committed_at FROM doc_commits
         WHERE task_id = :task AND owner_id = :owner AND commit_id = :commit`,
        { task: input.taskId, owner: input.ownerId, commit: request.commitId },
      ),
    );
    if (!commit) throw new DocumentError("document.integrity_failed");
    const document: PublishedDocument = Object.freeze({
      taskId: input.taskId,
      commitId: request.commitId,
      parentCommitId: (commit.parent_commit_id as string | null) ?? null,
      generation: request.generation,
      author: commit.author as DocumentAuthorKind,
      kind: commit.kind as DocumentCommitKind,
      restoredFrom: (commit.restored_from_commit_id as string | null) ?? null,
      committedAt: commit.committed_at as number,
      changedSectionIds: request.changedSectionIds,
    });
    if (input.fold) {
      const results = await this.db.batch([
        ...input.fold.prefix,
        ...input.fold.suffix({
          outcome: { status: "published", document },
          headGuard: null,
          accountKey,
        }),
      ]);
      const decision = input.fold.inspect(results, accountKey);
      if (decision) return { status: "fold_replay", body: decision.replay };
    }
    return { status: "published", replayed: true, document };
  }

  /** Reconstructs, edits, commits, verifies and bundles inside one private repository. */
  private async prepare(
    input: PublishInput,
    repo: RepoRecord | null,
    accountKey: AccountDataKey,
  ): Promise<PreparedPublication | "unchanged"> {
    try {
      return await this.git.withRepository(async (repository) => {
        let current: CurrentDocument | null = null;
        if (repo) {
          const markdown = await reconstructRepository({
            repository,
            artifacts: this.artifacts,
            accountKey,
            repo,
          });
          const snapshot = await this.artifacts.getSnapshot(accountKey, {
            ownerId: input.ownerId,
            taskId: input.taskId,
            commitId: repo.headCommitId,
          });
          if (snapshot.markdown !== markdown) throw new ArtifactIntegrityError("mismatch");
          current = { repo, markdown, snapshot };
        }
        const edit = await input.edit({ repository, current });
        if (edit.kind === "restore" && !edit.restoredFrom)
          throw new DocumentError("document.edit_invalid");
        if (current && edit.markdown === current.markdown) return "unchanged" as const;
        if (!current && edit.markdown.length === 0) return "unchanged" as const;
        const documentBytes = utf8ByteLength(edit.markdown);
        if (documentBytes > this.limits.maxDocumentBytes) {
          throw new DocumentError("document.too_large", {
            details: { maxBytes: this.limits.maxDocumentBytes },
          });
        }
        const kind: DocumentCommitKind = current ? edit.kind : "create";
        const committedAt = Math.floor(input.now / 1000) * 1000;
        const provisionalIndex = buildSectionIndex(edit.markdown, "0".repeat(40));
        const changes: readonly SectionChange[] = current
          ? compareSectionIndexes(current.snapshot.index, provisionalIndex).changes
          : [];
        const subject = commitSubject({
          kind,
          changes,
          restoredFromCommittedAt: edit.restoredFromCommittedAt ?? null,
        });
        const content = Buffer.from(edit.markdown, "utf8");
        let commitId: string;
        try {
          const blob = await repository.writeBlob(content);
          const tree = await repository.writeDocumentTree(blob);
          commitId = await repository.commitTree({
            tree,
            parents: current ? [current.repo.headCommitId] : [],
            message: commitMessage({
              subject,
              author: input.author,
              kind,
              restoredFrom: edit.kind === "restore" ? (edit.restoredFrom ?? null) : null,
            }),
            identity: identityFor(input.author, committedAt),
          });
        } finally {
          zeroize(content);
        }
        await repository.updateMain(commitId, current?.repo.headCommitId ?? null);
        await repository.fsck();
        const commitCount = await repository.commitCount(commitId);
        if (commitCount !== (current?.repo.commitCount ?? 0) + 1) {
          throw new ArtifactIntegrityError("mismatch");
        }
        let bundle: Buffer;
        try {
          bundle = await repository.createBundle("next.bundle", this.limits.maxBundleBytes);
        } catch (error) {
          if (error instanceof GitError && error.code === "git.limit_exceeded") {
            throw new DocumentError("document.history_too_large", {
              details: { maxBytes: this.limits.maxBundleBytes },
            });
          }
          throw error;
        }
        const index = rebindSectionIndex(provisionalIndex, commitId);
        const changedPaths = new Set(
          changes
            .filter((change) => change.status !== "removed")
            .map((change) => change.targetSectionId),
        );
        const changedSectionIds = current
          ? provisionalIndex.sections.flatMap((section, position) =>
              changedPaths.has(section.id) ? [(index.sections[position] as { id: string }).id] : [],
            )
          : index.sections.map((section) => section.id);
        const document: PublishedDocument = Object.freeze({
          taskId: input.taskId,
          commitId,
          parentCommitId: current?.repo.headCommitId ?? null,
          generation: (current?.repo.generation ?? 0) + 1,
          author: input.author,
          kind,
          restoredFrom: edit.kind === "restore" ? (edit.restoredFrom ?? null) : null,
          committedAt,
          changedSectionIds: Object.freeze(changedSectionIds.slice(0, 100)),
        });
        const snapshot: DocumentSnapshot = Object.freeze({
          taskId: input.taskId,
          commitId,
          parentCommitId: document.parentCommitId,
          generation: document.generation,
          author: input.author,
          kind,
          restoredFrom: document.restoredFrom,
          committedAt,
          subject,
          markdown: edit.markdown,
          index,
        });
        return { document, snapshot, bundle, commitCount, documentBytes };
      });
    } catch (error) {
      if (error instanceof ArtifactIntegrityError)
        throw new DocumentError("document.integrity_failed");
      if (error instanceof GitError) {
        if (error.code === "git.busy") throw new DocumentError("rate.limited", { retryAfter: 2 });
        if (error.code === "git.limit_exceeded") {
          throw new DocumentError("document.too_large", {
            details: { maxBytes: this.limits.maxDocumentBytes },
          });
        }
      }
      throw error;
    }
  }

  private async upload(
    input: PublishInput,
    repo: RepoRecord | null,
    prepared: PreparedPublication,
    accountKey: AccountDataKey,
  ): Promise<PublicationOutcome> {
    const writeId = uuidv7(input.now);
    const { document } = prepared;
    await this.hooks.beforeUpload?.();
    const uploadStarted = this.monotonic();
    let bundleKey: string;
    try {
      bundleKey = await this.artifacts.putBundle(
        accountKey,
        { ownerId: input.ownerId, taskId: input.taskId, generation: document.generation, writeId },
        prepared.bundle,
      );
    } finally {
      zeroize(prepared.bundle);
    }
    const snapshotKey = await this.artifacts.putSnapshot(accountKey, prepared.snapshot, writeId);
    await this.hooks.afterUpload?.({ bundleKey, snapshotKey });

    const statements = this.publicationStatements(input, repo, prepared, {
      writeId,
      bundleKey,
      snapshotKey,
      accountKey,
    });
    await this.hooks.beforePublish?.();
    if (this.monotonic() - uploadStarted > this.maxUploadAgeMs) {
      throw new DocumentError("rate.limited", { retryAfter: 1 });
    }
    let results: readonly StatementResult[];
    try {
      results = await this.db.batch(statements.batch);
    } catch (error) {
      if (!(error instanceof DbUnknownOutcomeError)) throw error;
      return this.reconcile(input, repo, prepared, statements, error);
    }
    return this.decide(input, prepared, results, accountKey);
  }

  private publicationStatements(
    input: PublishInput,
    repo: RepoRecord | null,
    prepared: PreparedPublication,
    keys: {
      readonly writeId: string;
      readonly bundleKey: string;
      readonly snapshotKey: string;
      readonly accountKey: AccountDataKey;
    },
  ): { readonly batch: readonly Statement[]; readonly prefixLength: number } {
    const { document } = prepared;
    const guards = guardSql([
      ...input.context.guards,
      ...(input.fold?.guard ? [input.fold.guard] : []),
    ]);
    const requestMissing = `NOT EXISTS (SELECT 1 FROM doc_publish_requests
      WHERE owner_id = :pub_owner AND scope = :pub_scope AND request_id = :pub_request)`;
    const common = {
      pub_task: input.taskId,
      pub_owner: input.ownerId,
      pub_scope: input.scope,
      pub_request: input.requestId,
      pub_commit: document.commitId,
      pub_generation: int(document.generation),
      pub_count: int(prepared.commitCount),
      pub_bundle_key: keys.bundleKey,
      pub_write_id: keys.writeId,
      pub_bundle_bytes: int(prepared.bundle.byteLength),
      pub_snapshot_key: keys.snapshotKey,
      pub_doc_bytes: int(prepared.documentBytes),
      pub_author: input.author,
      pub_format: int(BUNDLE_FORMAT_VERSION),
      pub_key_version: int(DATA_KEY_VERSION),
      pub_now: int(input.now),
    };
    const deciding = repo
      ? sql(
          `UPDATE doc_repos SET head_commit_id = :pub_commit, generation = :pub_generation,
             commit_count = :pub_count, bundle_key = :pub_bundle_key, bundle_write_id = :pub_write_id,
             bundle_bytes = :pub_bundle_bytes, snapshot_key = :pub_snapshot_key,
             document_bytes = :pub_doc_bytes, head_author = :pub_author, format_version = :pub_format,
             key_version = :pub_key_version, updated_at = :pub_now, write_id = :pub_write_id
           WHERE task_id = :pub_task AND owner_id = :pub_owner AND head_commit_id = :pub_base
             AND generation = :pub_base_generation AND ${requestMissing}
             ${guards.text}`,
          {
            ...common,
            ...guards.params,
            pub_base: repo.headCommitId,
            pub_base_generation: int(repo.generation),
          },
        )
      : sql(
          `INSERT INTO doc_repos (task_id, owner_id, head_commit_id, generation, commit_count, bundle_key,
             bundle_write_id, bundle_bytes, snapshot_key, document_bytes, head_author, format_version,
             key_version, created_at, updated_at, write_id)
           SELECT :pub_task, :pub_owner, :pub_commit, :pub_generation, :pub_count, :pub_bundle_key,
             :pub_write_id, :pub_bundle_bytes, :pub_snapshot_key, :pub_doc_bytes, :pub_author,
             :pub_format, :pub_key_version, :pub_now, :pub_now, :pub_write_id
           WHERE ${requestMissing}
             ${guards.text}
           ON CONFLICT (task_id) DO NOTHING`,
          { ...common, ...guards.params },
        );
    const headGuard: SqlGuard = {
      sql: "EXISTS (SELECT 1 FROM doc_repos WHERE task_id = :pub_guard_task AND write_id = :pub_guard_write_id)",
      params: { pub_guard_task: input.taskId, pub_guard_write_id: keys.writeId },
    };
    const guarded = { ...headGuard.params };
    const fingerprintEnc = encryptFieldText(
      keys.accountKey,
      fingerprintContext(input.ownerId, input.scope, input.requestId),
      digestInput(input.fingerprint),
      this.random,
    );
    const dependent = [
      sql(
        `INSERT INTO doc_commits (task_id, commit_id, owner_id, parent_commit_id, generation, author, kind,
           restored_from_commit_id, bundle_key, snapshot_key, document_bytes, format_version, key_version,
           committed_at, published_at)
         SELECT :task, :commit, :owner, :parent, :generation, :author, :kind, :restored, :bundle_key,
           :snapshot_key, :doc_bytes, :format, :key_version, :committed_at, :now
         WHERE ${headGuard.sql}`,
        {
          ...guarded,
          task: input.taskId,
          commit: document.commitId,
          owner: input.ownerId,
          parent: document.parentCommitId,
          generation: int(document.generation),
          author: document.author,
          kind: document.kind,
          restored: document.restoredFrom,
          bundle_key: keys.bundleKey,
          snapshot_key: keys.snapshotKey,
          doc_bytes: int(prepared.documentBytes),
          format: int(BUNDLE_FORMAT_VERSION),
          key_version: int(DATA_KEY_VERSION),
          committed_at: int(document.committedAt),
          now: int(input.now),
        },
      ),
      sql(
        `INSERT INTO doc_publish_requests (owner_id, scope, request_id, task_id, status, fingerprint_enc,
           base_commit_id, commit_id, generation, changed_section_ids, created_at, expires_at)
         SELECT :owner, :scope, :request, :task, 'published', :fingerprint, :base, :commit, :generation,
           :changed, :now, :expires
         WHERE ${headGuard.sql}`,
        {
          ...guarded,
          owner: input.ownerId,
          scope: input.scope,
          request: input.requestId,
          task: input.taskId,
          fingerprint: fingerprintEnc,
          base: input.expectedBase,
          commit: document.commitId,
          generation: int(document.generation),
          changed: json(document.changedSectionIds),
          now: int(input.now),
          expires: int(input.now + this.limits.requestRetentionMs),
        },
      ),
      sql(
        `INSERT INTO search_intents (owner_id, entity, entity_id, revision_or_seq, op, created_at)
         SELECT :owner, 'document', :task, :generation, 'upsert', :now
         WHERE ${headGuard.sql}`,
        {
          ...guarded,
          owner: input.ownerId,
          task: input.taskId,
          generation: int(document.generation),
          now: int(input.now),
        },
      ),
      ...(input.dependents?.(headGuard, document) ?? []),
    ];
    const prefix = input.fold?.prefix ?? [];
    const suffix =
      input.fold?.suffix({
        outcome: { status: "published", document },
        headGuard,
        accountKey: keys.accountKey,
      }) ?? [];
    return {
      batch: [
        ...prefix,
        deciding,
        ...dependent,
        ...suffix,
        sql(
          `SELECT task_id, head_commit_id, generation FROM doc_repos
           WHERE task_id = :task AND write_id = :write_id`,
          { task: input.taskId, write_id: keys.writeId },
        ),
      ],
      prefixLength: prefix.length,
    };
  }

  private async decide(
    input: PublishInput,
    prepared: PreparedPublication,
    results: readonly StatementResult[],
    accountKey: AccountDataKey,
  ): Promise<PublicationOutcome> {
    const decision = input.fold?.inspect(results, accountKey) ?? null;
    if (verifiedRow(results)) {
      return { status: "published", replayed: false, document: prepared.document };
    }
    if (decision) return { status: "fold_replay", body: decision.replay };
    return this.diagnose(input);
  }

  /**
   * Why a publication batch applied nothing, from a fresh read: lost access or an archived task (the
   * caller's `verify` throws), a concurrent duplicate that already published this request (replayed),
   * or a head that moved (conflict).
   */
  private async diagnose(input: PublishInput): Promise<PublicationOutcome> {
    const read = await this.readState(input);
    try {
      if (read.request) {
        if (!this.fingerprintMatches(input, read.request, read.accountKey)) {
          throw new DocumentError("idempotency.mismatch");
        }
        return await this.replay(
          { ...input, fold: undefined } as PublishInput,
          read.request,
          read.accountKey,
        );
      }
      const head = read.repo?.headCommitId ?? null;
      if (head === input.expectedBase) {
        // The task, access and base still hold, so a caller guard refused the write (a retired
        // executor generation, a revoked grant): nothing was published and retrying cannot help.
        throw new DocumentError("document.read_only");
      }
      return {
        status: "conflict",
        currentCommitId: head,
        currentGeneration: read.repo?.generation ?? 0,
      };
    } finally {
      zeroize(read.accountKey.key);
    }
  }

  /**
   * Resolves a publication batch whose outcome is unknown (§3.1): read by request id. When the request
   * was recorded (by this attempt or a duplicate), the publication stands. When nothing changed, the
   * same batch is sent once more: every statement is conditional on the request id and base, so a
   * second copy can never publish twice. Otherwise the head moved and the outcome is a conflict.
   */
  private async reconcile(
    input: PublishInput,
    repo: RepoRecord | null,
    prepared: PreparedPublication,
    statements: { readonly batch: readonly Statement[] },
    cause: DbUnknownOutcomeError,
  ): Promise<PublicationOutcome> {
    const read = await this.readState(input);
    try {
      if (read.request) {
        if (
          read.request.commitId === prepared.document.commitId &&
          read.repo?.headCommitId === prepared.document.commitId
        ) {
          return { status: "published", replayed: false, document: prepared.document };
        }
        return await this.replay(
          { ...input, fold: undefined } as PublishInput,
          read.request,
          read.accountKey,
        );
      }
      const unchanged =
        (read.repo?.headCommitId ?? null) === (repo?.headCommitId ?? null) &&
        (read.repo?.generation ?? 0) === (repo?.generation ?? 0);
      if (!unchanged) {
        return {
          status: "conflict",
          currentCommitId: read.repo?.headCommitId ?? null,
          currentGeneration: read.repo?.generation ?? 0,
        };
      }
      let results: readonly StatementResult[];
      try {
        results = await this.db.batch(statements.batch);
      } catch (error) {
        if (error instanceof DbUnknownOutcomeError) throw cause;
        throw error;
      }
      return await this.decide(input, prepared, results, read.accountKey);
    } finally {
      zeroize(read.accountKey.key);
    }
  }
}
