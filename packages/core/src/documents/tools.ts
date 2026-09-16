import { createHash } from "node:crypto";
import { zeroize } from "@symplist/crypto";
import type { Statement } from "@symplist/db";
import {
  buildSectionIndex,
  compareSectionIndexes,
  computeReadPositions,
  contentDigest,
  type DiffHunk,
  DocumentError,
  type DocumentSnapshot,
  decodeCursor,
  encodeCursor,
  findSection,
  isDocumentError,
  markdown as md,
  outlinePage,
  pageDiffHunks,
  type ReceiptDraft,
  readSectionChunk,
  receiptFromRow,
  receiptStatement,
  SectionNotFoundError,
  type SectionReadPosition,
  type SqlGuard,
  searchSections,
  searchTerms,
  selectReceiptsStatement,
  spliceSection,
} from "@symplist/docs";
import {
  actorGuards,
  agentRequest,
  authorizeActor,
  contextEpochOf,
  type McpDocumentActor,
  readerOf,
  type SimonDocumentActor,
} from "./actor.ts";
import { clampToBudget, type RetrievalBudget } from "./budgets.ts";
import type { DocumentRepository, LoadedDocument } from "./repository.ts";
import { historyPage, publishRestore } from "./service.ts";
import { type HistoryItem, type PublishResult, publishResult } from "./views.ts";

/** An agent calling a document tool: Simon in a run step, or an MCP grant (§8.7, §14.6). */
export type AgentDocumentActor = SimonDocumentActor | McpDocumentActor;

/** Tool bounds (contracts `documentToolLimits`); callers can only lower them. */
export const DOCUMENT_TOOL_LIMITS = Object.freeze({
  outlineDefault: 50,
  outlineMax: 100,
  searchDefault: 10,
  searchMax: 20,
  snippetChars: 240,
  readDefaultBytes: 8_192,
  readMinBytes: 256,
  readMaxBytes: 16_384,
  diffDefaultBytes: 16_384,
  diffMinBytes: 512,
  diffMaxBytes: 32_768,
  changesDefault: 50,
  changesMax: 100,
  historyDefault: 20,
  historyMax: 50,
  updateMaxChars: 65_536,
  /** Receipts loaded for read positions, and revisions whose snapshots are loaded to map them. */
  positionReceipts: 500,
  positionRevisions: 8,
});

const EMPTY_REVISION = "0".repeat(40);

function queryToken(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("base64url").slice(0, 16);
}

/**
 * The section-based document tools (note 06, note 11, §9.2): outline, search, read section and
 * changes read immutable head snapshots; update section, diff, history and restore reconstruct Git.
 * No tool returns the whole document or runs a model. Reads draw from the caller's retrieval budget
 * and return receipt drafts that Simon writes with its checkpoint (§9.4); MCP writes them with
 * {@link recordReceipts}.
 */
export class DocumentTools {
  constructor(private readonly repository: DocumentRepository) {}

  private async withLoaded<Result>(
    actor: AgentDocumentActor,
    taskId: string,
    operation: "read" | "write",
    extra: readonly Statement[],
    work: (loaded: LoadedDocument) => Promise<Result>,
  ): Promise<Result> {
    const loaded = await this.repository.load(actor, taskId, operation, extra);
    try {
      return await work(loaded);
    } finally {
      zeroize(loaded.accountKey.key);
    }
  }

  /** `task_document_outline`. */
  async outline(
    actor: AgentDocumentActor,
    input: {
      readonly taskId: string;
      readonly revision?: string;
      readonly cursor?: string;
      readonly limit?: number;
    },
  ) {
    const limit = Math.min(
      input.limit ?? DOCUMENT_TOOL_LIMITS.outlineDefault,
      DOCUMENT_TOOL_LIMITS.outlineMax,
    );
    const cursor = input.cursor
      ? decodeCursor(input.cursor, "o", input.taskId, { r: "revision", o: "offset", m: "token" })
      : null;
    if (cursor && input.revision !== undefined && cursor.r !== input.revision) {
      throw new DocumentError("document.cursor_invalid");
    }
    const explicit = input.revision ?? (cursor?.m === "r" ? cursor.r : undefined);
    const extra = explicit
      ? [this.repository.commitStatement(actor.userId, input.taskId, explicit)]
      : [];
    return this.withLoaded(actor, input.taskId, "read", extra, async (loaded) => {
      const repo = loaded.repo;
      if (!repo) {
        if (explicit || cursor) throw new DocumentError("not_found");
        return {
          taskId: input.taskId,
          revision: null,
          headRevision: null,
          isHead: true,
          parseMode: "parsed" as const,
          totalSections: 0,
          entries: [],
          nextCursor: null,
        };
      }
      if (explicit && !this.repository.commitFrom(loaded.extra[0]))
        throw new DocumentError("not_found");
      if (cursor?.m === "h" && cursor.r !== repo.headCommitId) {
        throw new DocumentError("document.stale_cursor", {
          details: { headRevision: repo.headCommitId },
        });
      }
      const revision = explicit ?? repo.headCommitId;
      const snapshot = await this.repository.snapshot(
        loaded.accountKey,
        actor.userId,
        input.taskId,
        revision,
      );
      const page = outlinePage(snapshot.index, cursor?.o ?? 0, limit);
      return {
        taskId: input.taskId,
        revision,
        headRevision: repo.headCommitId,
        isHead: revision === repo.headCommitId,
        parseMode: snapshot.index.mode,
        totalSections: snapshot.index.sections.length,
        entries: page.entries,
        nextCursor:
          page.nextOffset === null
            ? null
            : encodeCursor("o", input.taskId, {
                r: revision,
                o: page.nextOffset,
                m: explicit ? "r" : "h",
              }),
      };
    });
  }

  /** `task_document_search`: snippets from the head snapshot; never a hidden plaintext index. */
  async search(
    actor: AgentDocumentActor,
    input: {
      readonly taskId: string;
      readonly query: string;
      readonly cursor?: string;
      readonly limit?: number;
    },
    options: { readonly budget?: RetrievalBudget } = {},
  ) {
    const limit = Math.min(
      input.limit ?? DOCUMENT_TOOL_LIMITS.searchDefault,
      DOCUMENT_TOOL_LIMITS.searchMax,
    );
    const terms = searchTerms(input.query);
    const token = queryToken(terms);
    const cursor = input.cursor
      ? decodeCursor(input.cursor, "s", input.taskId, { r: "revision", q: "token", o: "offset" })
      : null;
    if (cursor && cursor.q !== token) throw new DocumentError("document.cursor_invalid");
    return this.withLoaded(actor, input.taskId, "read", [], async (loaded) => {
      const repo = loaded.repo;
      if (!repo) {
        if (cursor) throw new DocumentError("not_found");
        return {
          taskId: input.taskId,
          revision: null,
          matches: [],
          nextCursor: null,
          retrievedBytes: 0,
        };
      }
      if (cursor && cursor.r !== repo.headCommitId) {
        throw new DocumentError("document.stale_cursor", {
          details: { headRevision: repo.headCommitId },
        });
      }
      const allowed = clampToBudget(
        options.budget,
        limit * (DOCUMENT_TOOL_LIMITS.snippetChars + 4) * 4,
        256,
      );
      const snapshot = await this.repository.snapshot(
        loaded.accountKey,
        actor.userId,
        input.taskId,
        repo.headCommitId,
      );
      const found = searchSections(snapshot.markdown, snapshot.index, input.query, {
        offset: cursor?.o ?? 0,
        limit,
        snippetChars: DOCUMENT_TOOL_LIMITS.snippetChars,
      });
      const matches: (typeof found.matches)[number][] = [];
      let bytes = 0;
      let nextOffset = found.nextOffset;
      for (const match of found.matches) {
        const size = md.utf8ByteLength(match.snippet) + md.utf8ByteLength(match.heading ?? "");
        if (bytes + size > allowed && matches.length > 0) {
          const position = snapshot.index.sections.findIndex(
            (section) => section.id === match.sectionId,
          );
          nextOffset = position;
          break;
        }
        matches.push(match);
        bytes += size;
      }
      options.budget?.consume(bytes);
      return {
        taskId: input.taskId,
        revision: repo.headCommitId,
        matches,
        nextCursor:
          nextOffset === null
            ? null
            : encodeCursor("s", input.taskId, { r: repo.headCommitId, q: token, o: nextOffset }),
        retrievedBytes: bytes,
      };
    });
  }

  /** `task_document_read_section`: a bounded chunk of one section at an explicit revision. */
  async readSection(
    actor: AgentDocumentActor,
    input: {
      readonly taskId: string;
      readonly sectionId: string;
      readonly revision: string;
      readonly cursor?: string;
      readonly maxBytes?: number;
    },
    options: { readonly budget?: RetrievalBudget } = {},
  ) {
    const requested = Math.min(
      Math.max(
        input.maxBytes ?? DOCUMENT_TOOL_LIMITS.readDefaultBytes,
        DOCUMENT_TOOL_LIMITS.readMinBytes,
      ),
      DOCUMENT_TOOL_LIMITS.readMaxBytes,
    );
    const maxBytes = clampToBudget(options.budget, requested, DOCUMENT_TOOL_LIMITS.readMinBytes);
    const cursor = input.cursor
      ? decodeCursor(input.cursor, "r", input.taskId, { r: "revision", s: "token", o: "offset" })
      : null;
    if (cursor && (cursor.r !== input.revision || cursor.s !== input.sectionId)) {
      throw new DocumentError("document.cursor_invalid");
    }
    return this.withLoaded(
      actor,
      input.taskId,
      "read",
      [this.repository.commitStatement(actor.userId, input.taskId, input.revision)],
      async (loaded) => {
        const repo = loaded.repo;
        if (!repo || !this.repository.commitFrom(loaded.extra[0]))
          throw new DocumentError("not_found");
        const snapshot = await this.repository.snapshot(
          loaded.accountKey,
          actor.userId,
          input.taskId,
          input.revision,
        );
        const section = findSection(snapshot.index, input.sectionId);
        if (!section) throw new DocumentError("not_found");
        const chunk = readSectionChunk(snapshot.markdown, section, cursor?.o ?? 0, maxBytes);
        options.budget?.consume(chunk.deliveredBytes);
        const reader = readerOf(actor);
        const receipt: ReceiptDraft | null =
          reader && chunk.rangeEnd > chunk.rangeStart
            ? {
                ownerId: actor.userId,
                taskId: input.taskId,
                reader,
                sectionId: section.id,
                commitId: input.revision,
                rangeStart: chunk.rangeStart,
                rangeEnd: chunk.rangeEnd,
                sectionLength: section.end - section.start,
                contextEpoch: contextEpochOf(actor),
                runId: actor.kind === "simon" ? actor.runId : null,
                deliveredBytes: chunk.deliveredBytes,
              }
            : null;
        return {
          output: {
            taskId: input.taskId,
            sectionId: section.id,
            revision: input.revision,
            headRevision: repo.headCommitId,
            isHead: input.revision === repo.headCommitId,
            kind: section.kind,
            depth: section.depth,
            heading: section.heading,
            parentId: section.parentId,
            childIds: [...section.childIds],
            text: chunk.text,
            rangeStart: chunk.rangeStart,
            rangeEnd: chunk.rangeEnd,
            sectionLength: section.end - section.start,
            truncated: chunk.truncated,
            nextCursor:
              chunk.nextOffset === null
                ? null
                : encodeCursor("r", input.taskId, {
                    r: input.revision,
                    s: section.id,
                    o: chunk.nextOffset,
                  }),
            retrievedBytes: chunk.deliveredBytes,
            remainingBudgetBytes: options.budget?.remaining() ?? DOCUMENT_TOOL_LIMITS.readMaxBytes,
          },
          receipt,
        };
      },
    );
  }

  /** `task_document_update_section`: a canonical section edit published as a commit (§9.2). */
  async updateSection(
    actor: AgentDocumentActor,
    input: {
      readonly taskId: string;
      readonly expectedRevision: string | null;
      readonly sectionId?: string;
      readonly placement: "replace" | "after" | "end";
      readonly markdown: string;
    },
  ): Promise<PublishResult> {
    authorizeActor(actor, input.taskId, "write");
    if (input.markdown.length > DOCUMENT_TOOL_LIMITS.updateMaxChars) {
      throw new DocumentError("document.too_large", {
        details: { maxChars: DOCUMENT_TOOL_LIMITS.updateMaxChars },
      });
    }
    if (input.placement !== "end" && !input.sectionId)
      throw new DocumentError("document.edit_invalid");
    const request = agentRequest(actor);
    const { repository } = this;
    const outcome = await repository.publisher.publish({
      ownerId: actor.userId,
      taskId: input.taskId,
      scope: request.scope,
      requestId: request.id,
      fingerprint: {
        taskId: input.taskId,
        expected: input.expectedRevision,
        section: input.sectionId ?? null,
        placement: input.placement,
        content: contentDigest(input.markdown),
      },
      expectedBase: input.expectedRevision,
      author: actor.kind,
      now: repository.now(),
      context: {
        statements: repository.context.statements(actor.userId, input.taskId),
        verify: (results) => repository.context.verify(results, { write: true }),
        guards: [...repository.context.guards(actor.userId, input.taskId), ...actorGuards(actor)],
      },
      edit: ({ current }) => {
        if (!current && input.placement !== "end") throw new DocumentError("not_found");
        try {
          return {
            kind: "edit",
            markdown: spliceSection(
              current?.markdown ?? "",
              current?.snapshot.index ?? buildSectionIndex("", EMPTY_REVISION),
              {
                placement: input.placement,
                sectionId: input.sectionId ?? null,
                markdown: input.markdown,
              },
            ),
          };
        } catch (error) {
          if (error instanceof SectionNotFoundError) throw new DocumentError("not_found");
          if (error instanceof md.MarkdownTooComplexError) {
            throw new DocumentError("document.edit_invalid");
          }
          throw error;
        }
      },
    });
    return this.finishAgentWrite(actor, input.taskId, outcome);
  }

  private async finishAgentWrite(
    actor: AgentDocumentActor,
    taskId: string,
    outcome: Awaited<ReturnType<DocumentRepository["publisher"]["publish"]>>,
  ): Promise<PublishResult> {
    switch (outcome.status) {
      case "conflict":
        throw new DocumentError("document.conflict", {
          details: {
            currentRevision: outcome.currentCommitId,
            currentGeneration: outcome.currentGeneration,
            draftPreserved: false,
          },
        });
      case "fold_replay":
        throw new DocumentError("document.edit_invalid");
      case "unchanged":
        return publishResult(taskId, outcome);
      case "published":
        if (!outcome.replayed) {
          await this.repository.announce({
            ownerId: actor.userId,
            taskId,
            revision: outcome.document.commitId,
            generation: outcome.document.generation,
            author: outcome.document.author,
            changedSectionIds: outcome.document.changedSectionIds,
          });
        }
        return publishResult(taskId, outcome);
    }
  }

  /** `task_document_changes`: section changes since a baseline, with the target pinned (§9.4). */
  async changes(
    actor: AgentDocumentActor,
    input: {
      readonly taskId: string;
      readonly baselineRevision: string;
      readonly cursor?: string;
      readonly limit?: number;
    },
  ) {
    const limit = Math.min(
      input.limit ?? DOCUMENT_TOOL_LIMITS.changesDefault,
      DOCUMENT_TOOL_LIMITS.changesMax,
    );
    const cursor = input.cursor
      ? decodeCursor(input.cursor, "c", input.taskId, { b: "revision", p: "revision", o: "offset" })
      : null;
    if (cursor && cursor.b !== input.baselineRevision)
      throw new DocumentError("document.cursor_invalid");
    const extra = [
      this.repository.commitStatement(actor.userId, input.taskId, input.baselineRevision),
      ...(cursor ? [this.repository.commitStatement(actor.userId, input.taskId, cursor.p)] : []),
    ];
    return this.withLoaded(actor, input.taskId, "read", extra, async (loaded) => {
      const repo = loaded.repo;
      const baseline = this.repository.commitFrom(loaded.extra[0]);
      if (!repo || !baseline) throw new DocumentError("document.resync_required");
      const target = cursor ? this.repository.commitFrom(loaded.extra[1]) : null;
      if (cursor && !target) throw new DocumentError("document.resync_required");
      const targetId = target?.commitId ?? repo.headCommitId;
      const targetGeneration = target?.generation ?? repo.generation;
      if (baseline.generation > targetGeneration)
        throw new DocumentError("document.resync_required");
      const baselineSnapshot = await this.baseline(
        loaded,
        actor.userId,
        input.taskId,
        baseline.commitId,
      );
      const targetSnapshot = await this.repository.snapshot(
        loaded.accountKey,
        actor.userId,
        input.taskId,
        targetId,
      );
      const all = compareSectionIndexes(baselineSnapshot.index, targetSnapshot.index).changes;
      const offset = cursor?.o ?? 0;
      const page = all.slice(offset, offset + limit);
      const next = offset + page.length;
      return {
        taskId: input.taskId,
        baselineRevision: baseline.commitId,
        targetRevision: targetId,
        headRevision: repo.headCommitId,
        commitsBetween: targetGeneration - baseline.generation,
        changes: page.map((change) => ({
          status: change.status,
          sectionId: change.targetSectionId,
          baselineSectionId: change.baselineSectionId,
          kind: change.kind,
          depth: change.depth,
          heading: change.heading,
          bytes: change.bytes,
        })),
        nextCursor:
          next < all.length
            ? encodeCursor("c", input.taskId, { b: baseline.commitId, p: targetId, o: next })
            : null,
      };
    });
  }

  private async baseline(
    loaded: LoadedDocument,
    ownerId: string,
    taskId: string,
    commitId: string,
  ): Promise<DocumentSnapshot> {
    try {
      return await this.repository.snapshot(loaded.accountKey, ownerId, taskId, commitId);
    } catch (error) {
      if (isDocumentError(error, "document.integrity_failed"))
        throw new DocumentError("document.resync_required");
      throw error;
    }
  }

  /** `task_document_diff`: bounded hunks between published commits, optionally scoped to sections. */
  async diff(
    actor: AgentDocumentActor,
    input: {
      readonly taskId: string;
      readonly baseRevision: string;
      readonly targetRevision?: string;
      readonly sectionIds?: readonly string[];
      readonly cursor?: string;
      readonly maxBytes?: number;
    },
    options: { readonly budget?: RetrievalBudget } = {},
  ) {
    const requested = Math.min(
      Math.max(
        input.maxBytes ?? DOCUMENT_TOOL_LIMITS.diffDefaultBytes,
        DOCUMENT_TOOL_LIMITS.diffMinBytes,
      ),
      DOCUMENT_TOOL_LIMITS.diffMaxBytes,
    );
    const maxBytes = clampToBudget(options.budget, requested, DOCUMENT_TOOL_LIMITS.diffMinBytes);
    const scope = queryToken([...(input.sectionIds ?? [])].sort());
    const cursor = input.cursor
      ? decodeCursor(input.cursor, "d", input.taskId, {
          b: "revision",
          p: "revision",
          o: "offset",
          q: "token",
        })
      : null;
    if (
      cursor &&
      (cursor.b !== input.baseRevision ||
        cursor.q !== scope ||
        (input.targetRevision !== undefined && input.targetRevision !== cursor.p))
    ) {
      throw new DocumentError("document.cursor_invalid");
    }
    const pinned = cursor?.p ?? input.targetRevision;
    const extra = [
      this.repository.commitStatement(actor.userId, input.taskId, input.baseRevision),
      ...(pinned ? [this.repository.commitStatement(actor.userId, input.taskId, pinned)] : []),
    ];
    return this.withLoaded(actor, input.taskId, "read", extra, async (loaded) => {
      const repo = loaded.repo;
      const base = this.repository.commitFrom(loaded.extra[0]);
      if (!repo || !base) throw new DocumentError("document.resync_required");
      const target = pinned ? this.repository.commitFrom(loaded.extra[1]) : null;
      if (pinned && !target)
        throw new DocumentError(cursor ? "document.resync_required" : "not_found");
      const targetId = target?.commitId ?? repo.headCommitId;
      if (base.generation > (target?.generation ?? repo.generation))
        throw new DocumentError("document.resync_required");
      let hunks: DiffHunk[] = await this.repository.reader.diff(repo, loaded.accountKey, {
        base: base.commitId,
        target: targetId,
      });
      if (input.sectionIds && input.sectionIds.length > 0) {
        const snapshot = await this.repository.snapshot(
          loaded.accountKey,
          actor.userId,
          input.taskId,
          targetId,
        );
        const ranges = input.sectionIds.map((id) => {
          const section = findSection(snapshot.index, id);
          if (!section) throw new DocumentError("not_found");
          return section;
        });
        hunks = hunks.filter((hunk) => {
          // A hunk belongs to a section when one of its added or removed lines falls inside it; a
          // removed line is placed where it was in the target, just before the next target line.
          let position = hunk.targetStart;
          return hunk.lines.some((line) => {
            if (line.kind === "removed") {
              return ranges.some(
                (section) => position >= section.lineStart && position <= section.lineEnd,
              );
            }
            position = (line.targetLine ?? position) + 1;
            return (
              line.kind === "added" &&
              ranges.some(
                (section) =>
                  (line.targetLine ?? 0) >= section.lineStart &&
                  (line.targetLine ?? 0) <= section.lineEnd,
              )
            );
          });
        });
      }
      const page = pageDiffHunks(hunks, cursor?.o ?? 0, maxBytes);
      options.budget?.consume(page.deliveredBytes);
      return {
        taskId: input.taskId,
        baseRevision: base.commitId,
        targetRevision: targetId,
        hunks: page.hunks,
        nextCursor:
          page.nextOffset === null
            ? null
            : encodeCursor("d", input.taskId, {
                b: base.commitId,
                p: targetId,
                o: page.nextOffset,
                q: scope,
              }),
        retrievedBytes: page.deliveredBytes,
      };
    });
  }

  /** `task_document_history`: paginated published commits with provenance from Git. */
  async history(
    actor: AgentDocumentActor,
    input: { readonly taskId: string; readonly cursor?: string; readonly limit?: number },
  ): Promise<{
    readonly taskId: string;
    readonly headRevision: string | null;
    readonly items: readonly HistoryItem[];
    readonly nextCursor: string | null;
  }> {
    const limit = Math.min(
      input.limit ?? DOCUMENT_TOOL_LIMITS.historyDefault,
      DOCUMENT_TOOL_LIMITS.historyMax,
    );
    const cursor = input.cursor
      ? decodeCursor(input.cursor, "h", input.taskId, { p: "revision", o: "offset" })
      : null;
    const extra = cursor
      ? [this.repository.commitStatement(actor.userId, input.taskId, cursor.p)]
      : [];
    return this.withLoaded(actor, input.taskId, "read", extra, async (loaded) => ({
      taskId: input.taskId,
      ...(await historyPage(this.repository, loaded, {
        taskId: input.taskId,
        cursor,
        limit,
        pinnedRow: cursor ? this.repository.commitFrom(loaded.extra[0]) : null,
      })),
    }));
  }

  /** `task_document_restore`: a new commit with an earlier revision's content, guarded by the head. */
  async restore(
    actor: AgentDocumentActor,
    input: {
      readonly taskId: string;
      readonly revision: string;
      readonly expectedRevision: string;
    },
  ): Promise<PublishResult> {
    authorizeActor(actor, input.taskId, "write");
    const request = agentRequest(actor);
    const outcome = await publishRestore(this.repository, actor, input, {
      scope: request.scope,
      id: request.id,
      guards: actorGuards(actor) as SqlGuard[],
    });
    return this.finishAgentWrite(actor, input.taskId, outcome);
  }

  /** Receipt inserts for a checkpoint batch, optionally guarded by the checkpoint's write id (§9.4). */
  receiptStatements(receipts: readonly ReceiptDraft[], guard?: SqlGuard): Statement[] {
    const now = this.repository.now();
    return receipts.map((receipt) => receiptStatement(receipt, now, guard));
  }

  /** Writes receipts for a caller without a checkpoint of its own (an MCP response). */
  async recordReceipts(receipts: readonly ReceiptDraft[]): Promise<void> {
    if (receipts.length === 0) return;
    await this.repository.db.batch(this.receiptStatements(receipts));
  }

  /**
   * The reader's position in the head revision (§9.4): for each section, read, partially read,
   * changed since read, previously read (an earlier context epoch) or unread, and sections read
   * earlier that no longer exist. `task_context` reports this instead of document text.
   */
  async readPositions(
    actor: AgentDocumentActor,
    taskId: string,
  ): Promise<{
    readonly revision: string | null;
    readonly sections: readonly SectionReadPosition[];
    readonly removed: readonly { readonly heading: string | null; readonly readRevision: string }[];
  }> {
    const reader = readerOf(actor);
    if (!reader) throw new DocumentError("not_found");
    return this.withLoaded(
      actor,
      taskId,
      "read",
      [
        selectReceiptsStatement(
          actor.userId,
          taskId,
          reader,
          DOCUMENT_TOOL_LIMITS.positionReceipts,
        ),
      ],
      async (loaded) => {
        if (!loaded.repo) return { revision: null, sections: [], removed: [] };
        const head = await this.repository.snapshot(
          loaded.accountKey,
          actor.userId,
          taskId,
          loaded.repo.headCommitId,
        );
        const receipts = (loaded.extra[0]?.results ?? []).map(receiptFromRow);
        const revisions = [...new Set(receipts.map((receipt) => receipt.commitId))]
          .filter((commitId) => commitId !== head.commitId)
          .slice(0, DOCUMENT_TOOL_LIMITS.positionRevisions);
        const indexes = new Map<string, DocumentSnapshot["index"]>();
        for (const commitId of revisions) {
          try {
            indexes.set(
              commitId,
              (await this.repository.snapshot(loaded.accountKey, actor.userId, taskId, commitId))
                .index,
            );
          } catch (error) {
            if (!isDocumentError(error, "document.integrity_failed")) throw error;
          }
        }
        const positions = computeReadPositions({
          head: head.index,
          receipts,
          indexes,
          contextEpoch: contextEpochOf(actor),
        });
        return {
          revision: head.commitId,
          sections: positions.sections,
          removed: positions.removed.map((section) => ({
            heading: section.heading,
            readRevision: section.readRevision,
          })),
        };
      },
    );
  }
}
