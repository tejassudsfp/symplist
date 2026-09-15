import { zeroize } from "@symplist/crypto";
import { sql, uuidv7, verifiedRow } from "@symplist/db";
import {
  buildSectionIndex,
  classifyConflict,
  compareSectionIndexes,
  contentDigest,
  DocumentError,
  type DocumentSnapshot,
  decodeCursor,
  encodeCursor,
  type IndexedSection,
  isDocumentError,
  markdown as md,
  type PublicationFold,
  type PublicationOutcome,
  pageDiffHunks,
  type SectionIndex,
  type SqlGuard,
} from "@symplist/docs";
import type { UserDocumentActor } from "./actor.ts";
import {
  deleteDraftStatement,
  draftFromRow,
  type StoredDraft,
  selectDraftStatement,
  upsertDraftStatement,
} from "./drafts.ts";
import type { DocumentRepository } from "./repository.ts";
import {
  type HistoryItem,
  type PublishResult,
  publishResult,
  type SectionSummary,
  sectionSummary,
} from "./views.ts";

/** Bounds of the owner-facing document operations. */
export interface DocumentServiceLimits {
  /** Minimum interval between draft writes for one task (§9.3 "throttled"). */
  readonly draftMinIntervalMs: number;
  readonly historyDefault: number;
  readonly historyMax: number;
  /** Diff line bytes per compare page. */
  readonly compareHunkBytes: number;
  /** Section changes listed by compare. */
  readonly compareMaxChanges: number;
  /** Section texts returned by conflict review. */
  readonly conflictTextBytes: number;
}

export const DEFAULT_DOCUMENT_SERVICE_LIMITS: DocumentServiceLimits = Object.freeze({
  draftMinIntervalMs: 2_000,
  historyDefault: 20,
  historyMax: 50,
  compareHunkBytes: 32_768,
  compareMaxChanges: 200,
  conflictTextBytes: 131_072,
});

const EMPTY_REVISION = "0".repeat(40);
const DRAFT_REVISION = "f".repeat(40);

export interface HeadDocument {
  readonly taskId: string;
  readonly revision: string | null;
  readonly generation: number;
  readonly author: DocumentSnapshot["author"] | null;
  readonly updatedAt: number | null;
  readonly markdown: string;
  readonly bytes: number;
  readonly canonical: boolean | null;
  readonly hasRawHtml: boolean;
  readonly parseMode: "parsed" | "fallback";
  readonly sections: readonly SectionSummary[];
  readonly draft: StoredDraft | null;
}

/** A folded publication either produced its result or found an exact retry of an earlier request. */
export type FoldedResult<Result> =
  | { readonly kind: "result"; readonly result: Result }
  | { readonly kind: "replay"; readonly body: unknown };

/**
 * The owner's document operations behind the app API (§9.2, §9.3): read the head, save with an
 * expected base, drafts, history, revision previews, compare, restore and conflict review. Every
 * operation authorizes the owner and reads task, access, key and head in one D1 batch; writes fold the
 * active-task and access guards into the publication (§2.1, §3.1).
 */
export class DocumentService {
  private readonly limits: DocumentServiceLimits;
  private readonly lastDraftWrite = new Map<string, number>();

  constructor(
    private readonly repository: DocumentRepository,
    limits: Partial<DocumentServiceLimits> = {},
  ) {
    this.limits = Object.freeze({ ...DEFAULT_DOCUMENT_SERVICE_LIMITS, ...limits });
  }

  /** The published head, its sections and the stored draft. */
  async getHead(actor: UserDocumentActor, taskId: string): Promise<HeadDocument> {
    const loaded = await this.repository.load(actor, taskId, "read", [
      selectDraftStatement(actor.userId, taskId),
    ]);
    try {
      const draft = draftFromRow(
        loaded.extra[0]?.results[0],
        loaded.accountKey,
        actor.userId,
        taskId,
      );
      if (!loaded.repo) {
        return {
          taskId,
          revision: null,
          generation: 0,
          author: null,
          updatedAt: null,
          markdown: "",
          bytes: 0,
          canonical: true,
          hasRawHtml: false,
          parseMode: "parsed",
          sections: [],
          draft,
        };
      }
      const snapshot = await this.repository.snapshot(
        loaded.accountKey,
        actor.userId,
        taskId,
        loaded.repo.headCommitId,
      );
      return {
        taskId,
        revision: snapshot.commitId,
        generation: snapshot.generation,
        author: snapshot.author,
        updatedAt: loaded.repo.updatedAt,
        markdown: snapshot.markdown,
        bytes: snapshot.index.bytes,
        canonical: snapshot.index.canonical,
        hasRawHtml: snapshot.index.hasRawHtml,
        parseMode: snapshot.index.mode,
        sections: snapshot.index.sections.map(sectionSummary),
        draft,
      };
    } finally {
      zeroize(loaded.accountKey.key);
    }
  }

  private checkSize(markdown: string): number {
    const bytes = md.utf8ByteLength(markdown);
    if (bytes > this.repository.docMaxBytes) {
      throw new DocumentError("document.too_large", {
        details: { maxBytes: this.repository.docMaxBytes },
      });
    }
    return bytes;
  }

  /**
   * Publishes the editor's document as a commit on top of `baseRevision` (§9.3). Identical content
   * publishes nothing. A conflict keeps the candidate as the draft and fails with
   * `document.conflict`; the draft the save covered (`draftSeq`) is cleared with the publication.
   */
  async save(
    actor: UserDocumentActor,
    input: {
      readonly taskId: string;
      readonly baseRevision: string | null;
      readonly markdown: string;
      readonly kind: "edit" | "normalization";
      readonly draftSeq?: number;
    },
    request: { readonly id: string; readonly fold?: PublicationFold },
  ): Promise<FoldedResult<PublishResult>> {
    const bytes = this.checkSize(input.markdown);
    const { repository } = this;
    const ownerId = actor.userId;
    const now = repository.now();
    const outcome = await repository.publisher.publish({
      ownerId,
      taskId: input.taskId,
      scope: "save",
      requestId: request.id,
      fingerprint: {
        taskId: input.taskId,
        base: input.baseRevision,
        content: contentDigest(input.markdown),
        kind: input.kind,
        draftSeq: input.draftSeq ?? null,
      },
      expectedBase: input.baseRevision,
      author: "user",
      now,
      context: {
        statements: repository.context.statements(ownerId, input.taskId),
        verify: (results) => repository.context.verify(results, { write: true }),
        guards: repository.context.guards(ownerId, input.taskId),
      },
      edit: () => ({ kind: input.kind, markdown: input.markdown }),
      dependents: (guard) =>
        input.draftSeq === undefined
          ? []
          : [
              deleteDraftStatement({
                ownerId,
                taskId: input.taskId,
                clientSeq: input.draftSeq,
                guards: [guard],
              }),
            ],
      ...(request.fold ? { fold: request.fold } : {}),
    });
    return this.finishPublication(outcome, {
      ownerId,
      taskId: input.taskId,
      conflict: async (current) => {
        const preserved = await this.preserveCandidate(actor, input, bytes, now);
        throw new DocumentError("document.conflict", {
          details: {
            currentRevision: current.currentCommitId,
            currentGeneration: current.currentGeneration,
            draftPreserved: preserved,
          },
        });
      },
      unchanged: async () => {
        if (input.draftSeq === undefined) return;
        await repository.db.run(
          deleteDraftStatement({
            ownerId,
            taskId: input.taskId,
            clientSeq: input.draftSeq,
            guards: repository.context.guards(ownerId, input.taskId),
          }),
        );
      },
    });
  }

  private async finishPublication(
    outcome: PublicationOutcome,
    handlers: {
      readonly ownerId: string;
      readonly taskId: string;
      conflict(current: Extract<PublicationOutcome, { status: "conflict" }>): Promise<never>;
      unchanged?(): Promise<void>;
    },
  ): Promise<FoldedResult<PublishResult>> {
    switch (outcome.status) {
      case "fold_replay":
        return { kind: "replay", body: outcome.body };
      case "conflict":
        return handlers.conflict(outcome);
      case "unchanged":
        await handlers.unchanged?.();
        return { kind: "result", result: publishResult(handlers.taskId, outcome) };
      case "published":
        if (!outcome.replayed) {
          await this.repository.announce({
            ownerId: handlers.ownerId,
            taskId: handlers.taskId,
            revision: outcome.document.commitId,
            generation: outcome.document.generation,
            author: outcome.document.author,
            changedSectionIds: outcome.document.changedSectionIds,
          });
        }
        return { kind: "result", result: publishResult(handlers.taskId, outcome) };
    }
  }

  /** Keeps a conflicting save's candidate as the draft unless a newer draft is stored (§9.2). */
  private async preserveCandidate(
    actor: UserDocumentActor,
    input: {
      readonly taskId: string;
      readonly baseRevision: string | null;
      readonly markdown: string;
      readonly draftSeq?: number;
    },
    bytes: number,
    now: number,
  ): Promise<boolean> {
    const loaded = await this.repository.load(actor, input.taskId, "write", [
      selectDraftStatement(actor.userId, input.taskId),
    ]);
    try {
      const stored = loaded.extra[0]?.results[0];
      const clientSeq =
        input.draftSeq ?? (typeof stored?.client_seq === "number" ? stored.client_seq : 0);
      if (typeof stored?.client_seq === "number" && stored.client_seq > clientSeq) return true;
      const writeId = uuidv7(now);
      const results = await this.repository.db.batch([
        upsertDraftStatement({
          ownerId: actor.userId,
          taskId: input.taskId,
          baseRevision: input.baseRevision,
          clientSeq,
          markdown: input.markdown,
          bytes,
          origin: "conflict",
          accountKey: loaded.accountKey,
          now,
          writeId,
          guards: this.repository.context.guards(actor.userId, input.taskId),
        }),
        sql(
          `SELECT client_seq FROM doc_drafts WHERE owner_id = :owner AND task_id = :task
             AND (write_id = :w OR client_seq > CAST(:seq AS INTEGER))`,
          { owner: actor.userId, task: input.taskId, w: writeId, seq: String(clientSeq) },
        ),
      ]);
      return verifiedRow(results) !== null;
    } finally {
      zeroize(loaded.accountKey.key);
    }
  }

  /** Stores the editor's draft if it is not older than the stored one (§9.3). */
  async putDraft(
    actor: UserDocumentActor,
    input: {
      readonly taskId: string;
      readonly baseRevision: string | null;
      readonly clientSeq: number;
      readonly markdown: string;
    },
  ): Promise<{ readonly clientSeq: number; readonly updatedAt: number }> {
    const bytes = this.checkSize(input.markdown);
    const now = this.repository.now();
    const throttleKey = `${actor.userId}:${input.taskId}`;
    const last = this.lastDraftWrite.get(throttleKey);
    if (last !== undefined && now - last < this.limits.draftMinIntervalMs) {
      throw new DocumentError("rate.limited", {
        retryAfter: Math.max(1, Math.ceil((this.limits.draftMinIntervalMs - (now - last)) / 1000)),
      });
    }
    const loaded = await this.repository.load(actor, input.taskId, "write");
    try {
      const writeId = uuidv7(now);
      const results = await this.repository.db.batch([
        upsertDraftStatement({
          ownerId: actor.userId,
          taskId: input.taskId,
          baseRevision: input.baseRevision,
          clientSeq: input.clientSeq,
          markdown: input.markdown,
          bytes,
          origin: "editor",
          accountKey: loaded.accountKey,
          now,
          writeId,
          guards: this.repository.context.guards(actor.userId, input.taskId),
        }),
        sql(
          `SELECT client_seq, updated_at, write_id FROM doc_drafts WHERE owner_id = :owner AND task_id = :task`,
          { owner: actor.userId, task: input.taskId },
        ),
      ]);
      const row = verifiedRow(results);
      if (!row || row.write_id !== writeId) {
        if (row && typeof row.client_seq === "number" && row.client_seq > input.clientSeq) {
          throw new DocumentError("document.draft_stale", {
            details: { clientSeq: row.client_seq },
          });
        }
        throw new DocumentError("task.archived");
      }
      this.rememberDraftWrite(throttleKey, now);
      return { clientSeq: input.clientSeq, updatedAt: now };
    } finally {
      zeroize(loaded.accountKey.key);
    }
  }

  private rememberDraftWrite(key: string, now: number): void {
    this.lastDraftWrite.delete(key);
    this.lastDraftWrite.set(key, now);
    for (const [entry, at] of this.lastDraftWrite) {
      if (this.lastDraftWrite.size <= 10_000 && now - at < this.limits.draftMinIntervalMs) break;
      this.lastDraftWrite.delete(entry);
    }
  }

  /** Clears the draft unless a newer one was stored. Idempotent. */
  async deleteDraft(actor: UserDocumentActor, taskId: string, clientSeq: number): Promise<void> {
    await this.repository.db.run(
      deleteDraftStatement({
        ownerId: actor.userId,
        taskId,
        clientSeq,
        guards: [this.repository.context.accessGuard(actor.userId)],
      }),
    );
  }

  /** A page of history from Git, newest first, with the head pinned in the cursor (§9.2). */
  async history(
    actor: UserDocumentActor,
    input: { readonly taskId: string; readonly cursor?: string; readonly limit?: number },
  ): Promise<{
    readonly headRevision: string | null;
    readonly items: readonly HistoryItem[];
    readonly nextCursor: string | null;
  }> {
    const limit = Math.min(input.limit ?? this.limits.historyDefault, this.limits.historyMax);
    const cursor = input.cursor
      ? decodeCursor(input.cursor, "h", input.taskId, { p: "revision", o: "offset" })
      : null;
    const loaded = await this.repository.load(
      actor,
      input.taskId,
      "read",
      cursor ? [this.repository.commitStatement(actor.userId, input.taskId, cursor.p)] : [],
    );
    try {
      return await historyPage(this.repository, loaded, {
        taskId: input.taskId,
        cursor,
        limit,
        pinnedRow: cursor ? this.repository.commitFrom(loaded.extra[0]) : null,
      });
    } finally {
      zeroize(loaded.accountKey.key);
    }
  }

  /** A readable preview of one published revision. */
  async getRevision(actor: UserDocumentActor, taskId: string, revision: string) {
    const loaded = await this.repository.load(actor, taskId, "read", [
      this.repository.commitStatement(actor.userId, taskId, revision),
    ]);
    try {
      const commit = this.repository.commitFrom(loaded.extra[0]);
      if (!commit || !loaded.repo) throw new DocumentError("not_found");
      const snapshot = await this.repository.snapshot(
        loaded.accountKey,
        actor.userId,
        taskId,
        revision,
      );
      return {
        taskId,
        entry: historyItemFromSnapshot(snapshot),
        headRevision: loaded.repo.headCommitId,
        isHead: loaded.repo.headCommitId === revision,
        markdown: snapshot.markdown,
        sections: snapshot.index.sections.map(sectionSummary),
      };
    } finally {
      zeroize(loaded.accountKey.key);
    }
  }

  /**
   * Compares two published revisions: section changes from their snapshots, and bounded diff hunks
   * from Git, paged with the target pinned in the cursor (§9.4). An unknown baseline, or a baseline
   * newer than the target, requires resynchronization.
   */
  async compare(
    actor: UserDocumentActor,
    input: {
      readonly taskId: string;
      readonly base: string;
      readonly target?: string;
      readonly cursor?: string;
    },
  ) {
    const cursor = input.cursor
      ? decodeCursor(input.cursor, "cmp", input.taskId, {
          b: "revision",
          p: "revision",
          o: "offset",
        })
      : null;
    if (
      cursor &&
      (cursor.b !== input.base || (input.target !== undefined && input.target !== cursor.p))
    ) {
      throw new DocumentError("document.cursor_invalid");
    }
    const pinned = cursor?.p ?? input.target;
    const loaded = await this.repository.load(actor, input.taskId, "read", [
      this.repository.commitStatement(actor.userId, input.taskId, input.base),
      ...(pinned ? [this.repository.commitStatement(actor.userId, input.taskId, pinned)] : []),
    ]);
    try {
      const repo = loaded.repo;
      const base = this.repository.commitFrom(loaded.extra[0]);
      if (!repo || !base) throw new DocumentError("document.resync_required");
      const targetId = pinned ?? repo.headCommitId;
      const targetGeneration = pinned
        ? this.repository.commitFrom(loaded.extra[1])?.generation
        : repo.generation;
      if (targetGeneration === undefined) throw new DocumentError("not_found");
      if (base.generation > targetGeneration) throw new DocumentError("document.resync_required");
      const baseSnapshot = await this.baselineSnapshot(
        loaded.accountKey,
        actor.userId,
        input.taskId,
        base.commitId,
      );
      const targetSnapshot = await this.repository.snapshot(
        loaded.accountKey,
        actor.userId,
        input.taskId,
        targetId,
      );
      const changes = compareSectionIndexes(baseSnapshot.index, targetSnapshot.index).changes;
      const hunks = await this.repository.reader.diff(repo, loaded.accountKey, {
        base: base.commitId,
        target: targetId,
      });
      const page = pageDiffHunks(hunks, cursor?.o ?? 0, this.limits.compareHunkBytes);
      return {
        taskId: input.taskId,
        baseRevision: base.commitId,
        targetRevision: targetId,
        headRevision: repo.headCommitId,
        commitsBetween: targetGeneration - base.generation,
        changes: changes.slice(0, this.limits.compareMaxChanges).map((change) => ({
          status: change.status,
          sectionId: change.targetSectionId,
          baselineSectionId: change.baselineSectionId,
          kind: change.kind,
          depth: change.depth,
          heading: change.heading,
          bytes: change.bytes,
        })),
        hunks: page.hunks,
        nextCursor:
          page.nextOffset === null
            ? null
            : encodeCursor("cmp", input.taskId, {
                b: base.commitId,
                p: targetId,
                o: page.nextOffset,
              }),
      };
    } finally {
      zeroize(loaded.accountKey.key);
    }
  }

  private async baselineSnapshot(
    accountKey: Parameters<DocumentRepository["snapshot"]>[0],
    ownerId: string,
    taskId: string,
    commitId: string,
  ): Promise<DocumentSnapshot> {
    try {
      return await this.repository.snapshot(accountKey, ownerId, taskId, commitId);
    } catch (error) {
      if (isDocumentError(error, "document.integrity_failed")) {
        throw new DocumentError("document.resync_required");
      }
      throw error;
    }
  }

  /**
   * Restores an earlier revision as a new commit on top of `expectedRevision` (note 11 "Autosave,
   * history, and restore"); a newer head is a restore conflict and nothing is discarded.
   */
  async restore(
    actor: UserDocumentActor,
    input: {
      readonly taskId: string;
      readonly revision: string;
      readonly expectedRevision: string;
    },
    request: { readonly id: string; readonly fold?: PublicationFold },
  ): Promise<FoldedResult<PublishResult>> {
    const outcome = await publishRestore(this.repository, actor, input, {
      scope: "restore",
      id: request.id,
      guards: [],
      ...(request.fold ? { fold: request.fold } : {}),
    });
    return this.finishPublication(outcome, {
      ownerId: actor.userId,
      taskId: input.taskId,
      conflict: async (current) => {
        throw new DocumentError("document.conflict", {
          details: {
            currentRevision: current.currentCommitId,
            currentGeneration: current.currentGeneration,
            draftPreserved: false,
          },
        });
      },
    });
  }

  /**
   * Conflict review (document_history brief): the draft, the saved version, and for each section
   * whether the saved version, the draft or both changed it since the draft's base. Texts are
   * returned only for sections both changed, within a byte bound.
   */
  async conflict(
    actor: UserDocumentActor,
    input: { readonly taskId: string; readonly base: string | null },
  ) {
    const loaded = await this.repository.load(actor, input.taskId, "read", [
      selectDraftStatement(actor.userId, input.taskId),
      ...(input.base
        ? [this.repository.commitStatement(actor.userId, input.taskId, input.base)]
        : []),
    ]);
    try {
      const draft = draftFromRow(
        loaded.extra[0]?.results[0],
        loaded.accountKey,
        actor.userId,
        input.taskId,
      );
      const saved = loaded.repo
        ? await this.repository.snapshot(
            loaded.accountKey,
            actor.userId,
            input.taskId,
            loaded.repo.headCommitId,
          )
        : null;
      let baseIndex: SectionIndex = buildSectionIndex("", EMPTY_REVISION);
      if (input.base) {
        if (!this.repository.commitFrom(loaded.extra[1]))
          throw new DocumentError("document.resync_required");
        const base = await this.baselineSnapshot(
          loaded.accountKey,
          actor.userId,
          input.taskId,
          input.base,
        );
        baseIndex = base.index;
      }
      const savedIndex = saved?.index ?? buildSectionIndex("", EMPTY_REVISION);
      const savedMarkdown = saved?.markdown ?? "";
      const draftMarkdown = draft?.markdown ?? savedMarkdown;
      const draftIndex = buildSectionIndex(draftMarkdown, DRAFT_REVISION);
      const byId = (index: SectionIndex) =>
        new Map(index.sections.map((section) => [section.id, section]));
      const savedById = byId(savedIndex);
      const draftById = byId(draftIndex);
      let budget = this.limits.conflictTextBytes;
      let truncated = false;
      const text = (source: string, section: IndexedSection | undefined) => {
        if (!section) return null;
        const size = section.bytes;
        if (size > budget) {
          truncated = true;
          return null;
        }
        budget -= size;
        return source.slice(section.start, section.end);
      };
      const sections = classifyConflict(baseIndex, savedIndex, draftIndex).map((section) => {
        const both = section.status === "both_changed";
        return {
          status: section.status,
          kind: section.kind,
          depth: section.depth,
          heading: section.heading,
          savedSectionId: section.savedSectionId,
          draftText: both ? text(draftMarkdown, draftById.get(section.draftSectionId ?? "")) : null,
          savedText: both ? text(savedMarkdown, savedById.get(section.savedSectionId ?? "")) : null,
        };
      });
      return {
        taskId: input.taskId,
        baseRevision: input.base,
        currentRevision: loaded.repo?.headCommitId ?? null,
        currentGeneration: loaded.repo?.generation ?? 0,
        draft,
        savedMarkdown,
        sections,
        truncated,
      };
    } finally {
      zeroize(loaded.accountKey.key);
    }
  }
}

/** One history page read from Git for a loaded head (shared by the service and the history tool). */
export async function historyPage(
  repository: DocumentRepository,
  loaded: Awaited<ReturnType<DocumentRepository["load"]>>,
  input: {
    readonly taskId: string;
    readonly cursor: { readonly p: string; readonly o: number } | null;
    readonly limit: number;
    readonly pinnedRow: { readonly generation: number } | null;
  },
): Promise<{
  readonly headRevision: string | null;
  readonly items: readonly HistoryItem[];
  readonly nextCursor: string | null;
}> {
  const repo = loaded.repo;
  if (!repo) {
    if (input.cursor) throw new DocumentError("document.resync_required");
    return { headRevision: null, items: [], nextCursor: null };
  }
  if (input.cursor && !input.pinnedRow) throw new DocumentError("document.resync_required");
  const pinnedHead = input.cursor?.p ?? repo.headCommitId;
  const pinnedGeneration = input.pinnedRow?.generation ?? repo.generation;
  const skip = input.cursor?.o ?? 0;
  if (skip >= pinnedGeneration)
    return { headRevision: repo.headCommitId, items: [], nextCursor: null };
  const commits = await repository.reader.history(repo, loaded.accountKey, {
    pinnedHead,
    skip,
    limit: input.limit,
  });
  const items = commits.map((commit, index) => ({
    revision: commit.commitId,
    parentRevision: commit.parentCommitId,
    generation: pinnedGeneration - skip - index,
    author: commit.author,
    kind: commit.kind,
    restoredFrom: commit.restoredFrom,
    subject: commit.subject,
    committedAt: commit.committedAt,
  }));
  const next = skip + items.length;
  return {
    headRevision: repo.headCommitId,
    items,
    nextCursor:
      items.length > 0 && next < pinnedGeneration
        ? encodeCursor("h", input.taskId, { p: pinnedHead, o: next })
        : null,
  };
}

function historyItemFromSnapshot(snapshot: DocumentSnapshot): HistoryItem {
  return {
    revision: snapshot.commitId,
    parentRevision: snapshot.parentCommitId,
    generation: snapshot.generation,
    author: snapshot.author,
    kind: snapshot.kind,
    restoredFrom: snapshot.restoredFrom,
    subject: snapshot.subject,
    committedAt: snapshot.committedAt,
  };
}

/** Publishes a restore of `revision` for any actor (the owner's restore and the restore tool). */
export async function publishRestore(
  repository: DocumentRepository,
  actor: { readonly userId: string; readonly kind: "user" | "simon" | "mcp" },
  input: { readonly taskId: string; readonly revision: string; readonly expectedRevision: string },
  request: {
    readonly scope: string;
    readonly id: string;
    readonly guards: readonly SqlGuard[];
    readonly fold?: PublicationFold;
  },
): Promise<PublicationOutcome> {
  const ownerId = actor.userId;
  return repository.publisher.publish({
    ownerId,
    taskId: input.taskId,
    scope: request.scope,
    requestId: request.id,
    fingerprint: {
      taskId: input.taskId,
      revision: input.revision,
      expected: input.expectedRevision,
    },
    expectedBase: input.expectedRevision,
    author: actor.kind,
    now: repository.now(),
    context: {
      statements: repository.context.statements(ownerId, input.taskId),
      verify: (results) => repository.context.verify(results, { write: true }),
      guards: [...repository.context.guards(ownerId, input.taskId), ...request.guards],
    },
    edit: async ({ repository: git, current }) => {
      if (!current) throw new DocumentError("not_found");
      if (
        !(await git.hasCommit(input.revision)) ||
        !(await git.isAncestor(input.revision, current.repo.headCommitId))
      ) {
        throw new DocumentError("not_found");
      }
      const [entry] = await git.log(input.revision, 0, 1);
      const document = await git.readDocument(input.revision);
      try {
        return {
          kind: "restore",
          markdown: document.toString("utf8"),
          restoredFrom: input.revision,
          restoredFromCommittedAt: entry ? entry.authoredAt * 1000 : null,
        };
      } finally {
        zeroize(document);
      }
    },
    ...(request.fold ? { fold: request.fold } : {}),
  });
}
