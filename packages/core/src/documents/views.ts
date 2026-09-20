import type {
  DocumentAuthorKind,
  DocumentCommitKind,
  IndexedSection,
  PublicationOutcome,
} from "@symplist/docs";

/** A section reference with sizes (contracts `documentSectionSummarySchema`); never body text. */
export interface SectionSummary {
  readonly sectionId: string;
  readonly parentId: string | null;
  readonly kind: IndexedSection["kind"];
  readonly depth: number;
  readonly heading: string | null;
  readonly bytes: number;
  readonly subtreeBytes: number;
  readonly childCount: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

export function sectionSummary(section: IndexedSection): SectionSummary {
  return {
    sectionId: section.id,
    parentId: section.parentId,
    kind: section.kind,
    depth: section.depth,
    heading: section.heading,
    bytes: section.bytes,
    subtreeBytes: section.subtreeBytes,
    childCount: section.childIds.length,
    lineStart: section.lineStart,
    lineEnd: section.lineEnd,
  };
}

/** One history entry (contracts `documentHistoryEntrySchema`). */
export interface HistoryItem {
  readonly revision: string;
  readonly parentRevision: string | null;
  readonly generation: number;
  readonly author: DocumentAuthorKind;
  readonly kind: DocumentCommitKind;
  readonly restoredFrom: string | null;
  readonly subject: string;
  readonly committedAt: number;
}

/** The result of a save, section update or restore (contracts `documentPublishResponseSchema`). */
export interface PublishResult {
  readonly taskId: string;
  readonly status: "published" | "unchanged";
  readonly revision: string | null;
  readonly generation: number;
  readonly changedSectionIds: readonly string[];
  readonly restoredFrom: string | null;
}

export function publishResult(
  taskId: string,
  outcome: Extract<PublicationOutcome, { status: "published" | "unchanged" }>,
): PublishResult {
  if (outcome.status === "unchanged") {
    return {
      taskId,
      status: "unchanged",
      revision: outcome.commitId,
      generation: outcome.generation,
      changedSectionIds: [],
      restoredFrom: null,
    };
  }
  return {
    taskId,
    status: "published",
    revision: outcome.document.commitId,
    generation: outcome.document.generation,
    changedSectionIds: [...outcome.document.changedSectionIds],
    restoredFrom: outcome.document.restoredFrom,
  };
}
