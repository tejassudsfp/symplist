import type {
  DocumentCompareResponse,
  DocumentConflictResponse,
  DocumentDraft,
  DocumentHeadResponse,
  DocumentHistoryEntry,
  DocumentHistoryResponse,
  DocumentPublishResponse,
  DocumentRevisionResponse,
  DocumentSectionSummary,
  TaskId,
} from "@symplist/contracts";
import {
  canonicalizeMarkdown,
  containsRawHtml,
  isCanonicalMarkdown,
  parseDocument,
  splitSections,
} from "@symplist/docs/markdown";
import { ApiError } from "@/lib/api";
import type { DocumentApi, DocumentSaveInput } from "./api.ts";

/**
 * An in-memory stand-in for the task page API, used by the documents component tests. It keeps the
 * parts of §9.2 the browser can observe — expected base revisions, conflicts with the current
 * revision, replayed idempotency keys, drafts ordered by client sequence, history paging, revision
 * previews, comparisons and restores — so the page's behaviour is tested against real answers rather
 * than a mock that always succeeds.
 */

export interface FakeCommit {
  readonly revision: string;
  readonly parentRevision: string | null;
  readonly generation: number;
  readonly author: "user" | "simon" | "mcp";
  readonly kind: "create" | "edit" | "normalization" | "restore";
  readonly restoredFrom: string | null;
  readonly subject: string;
  readonly committedAt: number;
  readonly markdown: string;
}

export interface FakeDocumentsOptions {
  readonly taskId?: string;
  /** Published revisions, oldest first. */
  readonly commits?: ReadonlyArray<Partial<FakeCommit> & { readonly markdown: string }>;
  readonly draft?: DocumentDraft | null;
  readonly now?: () => number;
}

function revisionOf(index: number): string {
  return index.toString(16).padStart(40, "0");
}

function sectionId(index: number): string {
  return `s${index.toString(36).padStart(25, "a")}`;
}

function sectionsOf(markdown: string): DocumentSectionSummary[] {
  return splitSections(markdown).sections.map((section, index) => ({
    sectionId: sectionId(index) as DocumentSectionSummary["sectionId"],
    parentId: null,
    kind: section.kind,
    depth: section.depth,
    heading: section.heading,
    bytes: section.end - section.start,
    subtreeBytes: section.subtreeEnd - section.start,
    childCount: 0,
    lineStart: section.lineStart,
    lineEnd: section.lineEnd,
  }));
}

function apiError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiError {
  return new ApiError({
    status,
    code,
    message,
    requestId: "test-request",
    ...(details ? { details } : {}),
  });
}

function subjectFor(previous: string, next: string, kind: FakeCommit["kind"]): string {
  if (kind === "normalization") return "Formatting normalized";
  if (kind === "restore") return "Restored an earlier version";
  if (previous.trim().length === 0) return "Created the page";
  const before = splitSections(previous).sections;
  const after = splitSections(next).sections;
  const changed = after.find((section) => {
    const match = before.find((candidate) => candidate.heading === section.heading);
    return (
      match === undefined ||
      previous.slice(match.start, match.end) !== next.slice(section.start, section.end)
    );
  });
  return changed?.heading ? `Updated ${changed.heading}` : "Updated the page";
}

function lineDiff(base: string, target: string) {
  const baseLines = base.split("\n");
  const targetLines = target.split("\n");
  const lines: DocumentCompareResponse["hunks"][number]["lines"] = [];
  const length = Math.max(baseLines.length, targetLines.length);
  for (let index = 0; index < length; index += 1) {
    const before = baseLines[index];
    const after = targetLines[index];
    if (before === after) {
      if (before !== undefined) {
        lines.push({ kind: "context", text: before, baseLine: index + 1, targetLine: index + 1 });
      }
      continue;
    }
    if (before !== undefined) {
      lines.push({ kind: "removed", text: before, baseLine: index + 1, targetLine: null });
    }
    if (after !== undefined) {
      lines.push({ kind: "added", text: after, baseLine: null, targetLine: index + 1 });
    }
  }
  return lines;
}

export class FakeDocuments {
  readonly taskId: string;
  commits: FakeCommit[] = [];
  draft: DocumentDraft | null = null;
  /** Thrown by the next call to any method, then cleared. */
  failNext: unknown = null;
  /** Requests recorded in order, for asserting what the page sent. */
  readonly calls: Array<{ readonly name: string; readonly input?: unknown }> = [];
  private readonly replays = new Map<string, DocumentPublishResponse>();
  private readonly payloads = new Map<string, string>();
  private readonly now: () => number;

  constructor(options: FakeDocumentsOptions = {}) {
    this.taskId = options.taskId ?? "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b8a";
    this.now = options.now ?? (() => 1_758_000_000_000);
    let previous = "";
    const planned = options.commits ?? [];
    planned.forEach((commit, index) => {
      const kind = commit.kind ?? (index === 0 ? "create" : "edit");
      this.commits.push({
        revision: commit.revision ?? revisionOf(index + 1),
        parentRevision: index === 0 ? null : revisionOf(index),
        generation: index + 1,
        author: commit.author ?? "user",
        kind,
        restoredFrom: commit.restoredFrom ?? null,
        subject: commit.subject ?? subjectFor(previous, commit.markdown, kind),
        // Oldest first, so a fixture's commits are minutes apart and history grouping is testable.
        committedAt: commit.committedAt ?? this.now() - (planned.length - 1 - index) * 60_000,
        markdown: commit.markdown,
      });
      previous = commit.markdown;
    });
    this.draft = options.draft ?? null;
  }

  get head(): FakeCommit | null {
    return this.commits.at(-1) ?? null;
  }

  get markdown(): string {
    return this.head?.markdown ?? "";
  }

  /** Publishes a revision as if another writer did, which is what a `document.head_changed` means. */
  publishElsewhere(markdown: string, author: "simon" | "mcp" | "user" = "simon"): FakeCommit {
    return this.append(markdown, author, "edit", null);
  }

  private append(
    markdown: string,
    author: FakeCommit["author"],
    kind: FakeCommit["kind"],
    restoredFrom: string | null,
  ): FakeCommit {
    const previous = this.head;
    const commit: FakeCommit = {
      revision: revisionOf(this.commits.length + 1),
      parentRevision: previous?.revision ?? null,
      generation: this.commits.length + 1,
      author,
      kind,
      restoredFrom,
      subject: subjectFor(previous?.markdown ?? "", markdown, kind),
      committedAt: this.now(),
      markdown,
    };
    this.commits.push(commit);
    return commit;
  }

  private check(name: string, input?: unknown): void {
    this.calls.push(input === undefined ? { name } : { name, input });
    const failure = this.failNext;
    if (failure) {
      this.failNext = null;
      throw failure;
    }
  }

  private headResponse(): DocumentHeadResponse {
    const head = this.head;
    const markdown = head?.markdown ?? "";
    const parsed = parseDocument(markdown);
    return {
      taskId: this.taskId as TaskId,
      revision: (head?.revision ?? null) as DocumentHeadResponse["revision"],
      generation: head?.generation ?? 0,
      author: head?.author ?? null,
      updatedAt: head?.committedAt ?? null,
      markdown,
      bytes: markdown.length,
      canonical: markdown.trim().length === 0 ? true : safeCanonical(markdown),
      hasRawHtml: parsed.mode === "parsed" ? containsRawHtml(parsed.tree) : true,
      parseMode: parsed.mode,
      sections: sectionsOf(markdown),
      draft: this.draft,
    };
  }

  readonly api: DocumentApi = {
    head: async () => {
      this.check("head");
      return this.headResponse();
    },
    publish: async (_taskId: string, input: DocumentSaveInput) => {
      this.check("publish", input);
      const recorded = this.replays.get(input.idempotencyKey);
      if (recorded) {
        if (this.payloads.get(input.idempotencyKey) !== input.markdown) {
          throw apiError(409, "idempotency.mismatch", "That key was used for other input");
        }
        return recorded;
      }
      const head = this.head;
      if ((head?.revision ?? null) !== input.baseRevision) {
        throw apiError(409, "document.conflict", "The page moved on", {
          currentRevision: head?.revision ?? null,
          currentGeneration: head?.generation ?? 0,
          draftPreserved: true,
        });
      }
      if (input.draftSeq !== undefined && this.draft && this.draft.clientSeq <= input.draftSeq) {
        this.draft = null;
      }
      if ((head?.markdown ?? "") === input.markdown) {
        const unchanged: DocumentPublishResponse = {
          taskId: this.taskId as TaskId,
          status: "unchanged",
          revision: (head?.revision ?? null) as DocumentPublishResponse["revision"],
          generation: head?.generation ?? 0,
          changedSectionIds: [],
          restoredFrom: null,
        };
        this.replays.set(input.idempotencyKey, unchanged);
        this.payloads.set(input.idempotencyKey, input.markdown);
        return unchanged;
      }
      const commit = this.append(input.markdown, "user", input.kind, null);
      const response: DocumentPublishResponse = {
        taskId: this.taskId as TaskId,
        status: "published",
        revision: commit.revision as DocumentPublishResponse["revision"],
        generation: commit.generation,
        changedSectionIds: [],
        restoredFrom: null,
      };
      this.replays.set(input.idempotencyKey, response);
      this.payloads.set(input.idempotencyKey, input.markdown);
      return response;
    },
    putDraft: async (_taskId, input) => {
      this.check("putDraft", input);
      if (this.draft && this.draft.clientSeq >= input.clientSeq) {
        throw apiError(409, "document.draft_stale", "A newer draft is stored");
      }
      this.draft = {
        baseRevision: input.baseRevision as DocumentDraft["baseRevision"],
        clientSeq: input.clientSeq,
        markdown: input.markdown,
        origin: "editor",
        updatedAt: this.now(),
      };
      return { clientSeq: input.clientSeq, updatedAt: this.now() };
    },
    deleteDraft: async (_taskId, clientSeq) => {
      this.check("deleteDraft", clientSeq);
      if (this.draft && this.draft.clientSeq < clientSeq) this.draft = null;
    },
    history: async (_taskId, query = {}) => {
      this.check("history", query);
      const limit = query.limit ?? 25;
      const ordered = [...this.commits].reverse();
      const start = query.cursor ? Number(query.cursor) : 0;
      const page = ordered.slice(start, start + limit);
      const response: DocumentHistoryResponse = {
        taskId: this.taskId as TaskId,
        headRevision: (this.head?.revision ?? null) as DocumentHistoryResponse["headRevision"],
        items: page.map(
          (commit): DocumentHistoryEntry => ({
            revision: commit.revision as DocumentHistoryEntry["revision"],
            parentRevision: commit.parentRevision as DocumentHistoryEntry["parentRevision"],
            generation: commit.generation,
            author: commit.author,
            kind: commit.kind,
            restoredFrom: commit.restoredFrom as DocumentHistoryEntry["restoredFrom"],
            subject: commit.subject,
            committedAt: commit.committedAt,
          }),
        ),
        nextCursor: (start + limit < ordered.length
          ? String(start + limit)
          : null) as DocumentHistoryResponse["nextCursor"],
      };
      return response;
    },
    revision: async (_taskId, revision) => {
      this.check("revision", revision);
      const commit = this.commits.find((candidate) => candidate.revision === revision);
      if (!commit) throw apiError(404, "not_found", "No such revision");
      const head = this.head;
      const response: DocumentRevisionResponse = {
        taskId: this.taskId as TaskId,
        entry: {
          revision: commit.revision as DocumentHistoryEntry["revision"],
          parentRevision: commit.parentRevision as DocumentHistoryEntry["parentRevision"],
          generation: commit.generation,
          author: commit.author,
          kind: commit.kind,
          restoredFrom: commit.restoredFrom as DocumentHistoryEntry["restoredFrom"],
          subject: commit.subject,
          committedAt: commit.committedAt,
        },
        headRevision: (head?.revision ??
          commit.revision) as DocumentRevisionResponse["headRevision"],
        isHead: head?.revision === commit.revision,
        markdown: commit.markdown,
        sections: sectionsOf(commit.markdown),
      };
      return response;
    },
    compare: async (_taskId, query) => {
      this.check("compare", query);
      const base = this.commits.find((commit) => commit.revision === query.base);
      const target =
        this.commits.find((commit) => commit.revision === query.target) ?? this.head ?? null;
      if (!base || !target) throw apiError(409, "document.resync_required", "Unknown baseline");
      const beforeSections = splitSections(base.markdown).sections;
      const afterSections = splitSections(target.markdown).sections;
      const changes: DocumentCompareResponse["changes"] = [];
      afterSections.forEach((section, index) => {
        const match = beforeSections.find((candidate) => candidate.heading === section.heading);
        const text = target.markdown.slice(section.start, section.end);
        if (!match) {
          changes.push({
            status: "added",
            sectionId: sectionId(index) as DocumentSectionSummary["sectionId"],
            baselineSectionId: null,
            kind: section.kind,
            depth: section.depth,
            heading: section.heading,
            bytes: text.length,
          });
        } else if (base.markdown.slice(match.start, match.end) !== text) {
          changes.push({
            status: "modified",
            sectionId: sectionId(index) as DocumentSectionSummary["sectionId"],
            baselineSectionId: sectionId(index) as DocumentSectionSummary["sectionId"],
            kind: section.kind,
            depth: section.depth,
            heading: section.heading,
            bytes: text.length,
          });
        }
      });
      for (const [index, section] of beforeSections.entries()) {
        if (!afterSections.some((candidate) => candidate.heading === section.heading)) {
          changes.push({
            status: "removed",
            sectionId: null,
            baselineSectionId: sectionId(index) as DocumentSectionSummary["sectionId"],
            kind: section.kind,
            depth: section.depth,
            heading: section.heading,
            bytes: section.end - section.start,
          });
        }
      }
      const response: DocumentCompareResponse = {
        taskId: this.taskId as TaskId,
        baseRevision: base.revision as DocumentCompareResponse["baseRevision"],
        targetRevision: target.revision as DocumentCompareResponse["targetRevision"],
        headRevision: (this.head?.revision ??
          target.revision) as DocumentCompareResponse["headRevision"],
        commitsBetween: Math.max(0, target.generation - base.generation - 1),
        changes,
        hunks:
          base.markdown === target.markdown
            ? []
            : [
                {
                  baseStart: 1,
                  baseLines: base.markdown.split("\n").length,
                  targetStart: 1,
                  targetLines: target.markdown.split("\n").length,
                  truncated: false,
                  lines: lineDiff(base.markdown, target.markdown),
                },
              ],
        nextCursor: null,
      };
      return response;
    },
    restore: async (_taskId, input) => {
      this.check("restore", input);
      const recorded = this.replays.get(input.idempotencyKey);
      if (recorded) return recorded;
      if ((this.head?.revision ?? null) !== input.expectedRevision) {
        throw apiError(409, "document.conflict", "The page moved on", {
          currentRevision: this.head?.revision ?? null,
          currentGeneration: this.head?.generation ?? 0,
          draftPreserved: false,
        });
      }
      const source = this.commits.find((commit) => commit.revision === input.revision);
      if (!source) throw apiError(404, "not_found", "No such revision");
      const commit = this.append(source.markdown, "user", "restore", source.revision);
      const response: DocumentPublishResponse = {
        taskId: this.taskId as TaskId,
        status: "published",
        revision: commit.revision as DocumentPublishResponse["revision"],
        generation: commit.generation,
        changedSectionIds: [],
        restoredFrom: source.revision as DocumentPublishResponse["restoredFrom"],
      };
      this.replays.set(input.idempotencyKey, response);
      return response;
    },
    conflict: async (_taskId, base) => {
      this.check("conflict", base);
      const saved = this.markdown;
      const response: DocumentConflictResponse = {
        taskId: this.taskId as TaskId,
        baseRevision: (base === null
          ? null
          : (base as string)) as DocumentConflictResponse["baseRevision"],
        currentRevision: (this.head?.revision ??
          null) as DocumentConflictResponse["currentRevision"],
        currentGeneration: this.head?.generation ?? 0,
        draft: this.draft,
        savedMarkdown: saved,
        sections: [],
        truncated: false,
      };
      return response;
    },
  };
}

function safeCanonical(markdown: string): boolean {
  try {
    return isCanonicalMarkdown(markdown);
  } catch {
    return true;
  }
}

/** The canonical form of a fixture, so tests can assert what a normalization commit publishes. */
export function canonicalFixture(markdown: string): string {
  return canonicalizeMarkdown(markdown);
}
