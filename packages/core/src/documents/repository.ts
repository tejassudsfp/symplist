import type { AccountDataKey, KeyProvider, RandomOptions } from "@symplist/crypto";
import { zeroize } from "@symplist/crypto";
import type { DbClient, Statement, StatementResult } from "@symplist/db";
import {
  ArtifactIntegrityError,
  type CiphertextCache,
  type CommitRecord,
  commitFromRow,
  DocumentArtifacts,
  DocumentError,
  DocumentHistoryReader,
  DocumentPublisher,
  type DocumentSnapshot,
  type GitService,
  type PublicationHooks,
  type PublicationLimits,
  type RepoRecord,
  repoFromRow,
  selectCommitStatement,
  selectRepoStatement,
} from "@symplist/docs";
import type { ObjectStore } from "@symplist/storage";
import type { AccessPolicy } from "../access/evaluate.ts";
import { AccountKeyStore } from "../account/keys.ts";
import { authorizeActor, type DocumentActor } from "./actor.ts";
import { DocumentAccessContext } from "./context.ts";
import type { DocumentEventSink } from "./events.ts";

export interface DocumentRepositoryOptions {
  readonly db: DbClient;
  readonly objects: ObjectStore;
  readonly keys: KeyProvider;
  readonly git: GitService;
  readonly accessPolicy: AccessPolicy;
  readonly now: () => number;
  /** `DOC_MAX_BYTES`. */
  readonly docMaxBytes: number;
  readonly events?: DocumentEventSink;
  readonly cache?: CiphertextCache;
  readonly publication?: {
    readonly limits?: Partial<Omit<PublicationLimits, "maxDocumentBytes">>;
    readonly hooks?: PublicationHooks;
    readonly maxUploadAgeMs?: number;
  };
  readonly random?: RandomOptions;
}

/** What one authorized read batch returned. The caller zeroizes `accountKey`. */
export interface LoadedDocument {
  readonly accountKey: AccountDataKey;
  readonly repo: RepoRecord | null;
  /** Results of the caller's extra statements, in order. */
  readonly extra: readonly StatementResult[];
}

/**
 * The shared plumbing of the document services: one authorized D1 read batch per operation (task,
 * access, key and head), snapshot loading, the publisher and the Git history reader, all wired to one
 * set of drivers so the api and the `document-git` task behave identically (§9.1).
 */
export class DocumentRepository {
  readonly db: DbClient;
  readonly artifacts: DocumentArtifacts;
  readonly publisher: DocumentPublisher;
  readonly reader: DocumentHistoryReader;
  readonly context: DocumentAccessContext;
  readonly accountKeys: AccountKeyStore;
  readonly events: DocumentEventSink | undefined;
  readonly now: () => number;
  readonly docMaxBytes: number;
  readonly git: GitService;

  constructor(options: DocumentRepositoryOptions) {
    this.db = options.db;
    this.now = options.now;
    this.docMaxBytes = options.docMaxBytes;
    this.events = options.events;
    this.git = options.git;
    this.accountKeys = new AccountKeyStore({ db: options.db, keys: options.keys });
    this.context = new DocumentAccessContext(this.accountKeys, options.accessPolicy);
    this.artifacts = new DocumentArtifacts({
      objects: options.objects,
      ...(options.cache ? { cache: options.cache } : {}),
      ...(options.random ? { random: options.random } : {}),
    });
    this.publisher = new DocumentPublisher({
      db: options.db,
      git: options.git,
      artifacts: this.artifacts,
      limits: { ...options.publication?.limits, maxDocumentBytes: options.docMaxBytes },
      ...(options.publication?.hooks ? { hooks: options.publication.hooks } : {}),
      ...(options.publication?.maxUploadAgeMs === undefined
        ? {}
        : { maxUploadAgeMs: options.publication.maxUploadAgeMs }),
      ...(options.random ? { random: options.random } : {}),
    });
    this.reader = new DocumentHistoryReader({ git: options.git, artifacts: this.artifacts });
  }

  /**
   * Authorizes the actor for the task and reads task, access, key and head in one batch with the
   * caller's extra statements. Unknown and foreign tasks are `not_found`.
   */
  async load(
    actor: DocumentActor,
    taskId: string,
    operation: "read" | "write",
    extra: readonly Statement[] = [],
  ): Promise<LoadedDocument> {
    authorizeActor(actor, taskId, operation);
    const results = await this.db.batch([
      ...this.context.statements(actor.userId, taskId),
      selectRepoStatement(actor.userId, taskId),
      ...extra,
    ]);
    const accountKey = this.context.verify(results.slice(0, 2), { write: operation === "write" });
    try {
      const row = results[2]?.results[0];
      return { accountKey, repo: row ? repoFromRow(row) : null, extra: results.slice(3) };
    } catch (error) {
      zeroize(accountKey.key);
      throw error;
    }
  }

  /** A published commit row of the owner's task, as an extra statement for {@link load}. */
  commitStatement(ownerId: string, taskId: string, commitId: string): Statement {
    return selectCommitStatement(ownerId, taskId, commitId);
  }

  commitFrom(result: StatementResult | undefined): CommitRecord | null {
    const row = result?.results[0];
    return row ? commitFromRow(row) : null;
  }

  /**
   * The head snapshot of a published commit. A missing or unauthenticated snapshot of the head is an
   * integrity failure; for a baseline the caller maps it to `document.resync_required`.
   */
  async snapshot(
    accountKey: AccountDataKey,
    ownerId: string,
    taskId: string,
    commitId: string,
  ): Promise<DocumentSnapshot> {
    try {
      return await this.artifacts.getSnapshot(accountKey, { ownerId, taskId, commitId });
    } catch (error) {
      if (error instanceof ArtifactIntegrityError)
        throw new DocumentError("document.integrity_failed");
      throw error;
    }
  }

  /** Announces a publication after it committed; failures never undo or fail the write (§7). */
  async announce(event: Parameters<DocumentEventSink["headChanged"]>[0]): Promise<void> {
    if (!this.events) return;
    try {
      await this.events.headChanged(event);
    } catch (error) {
      this.events.onError?.(error);
    }
  }
}
