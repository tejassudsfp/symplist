import { createHash } from "node:crypto";
import { normalizeForSearch } from "../markdown/index.ts";
import {
  type IndexedSection,
  REVISION_PATTERN,
  type SectionIndex,
  sectionId,
} from "../sections/section-index.ts";

/** Who authored a published commit (plaintext enum, like `tasks.source`). */
export type DocumentAuthorKind = "user" | "simon" | "mcp";

/** What a commit did: the first commit, an edit, a formatting normalization (§9.3) or a restore. */
export type DocumentCommitKind = "create" | "edit" | "normalization" | "restore";

export const DOCUMENT_AUTHOR_KINDS: readonly DocumentAuthorKind[] = ["user", "simon", "mcp"];
export const DOCUMENT_COMMIT_KINDS: readonly DocumentCommitKind[] = [
  "create",
  "edit",
  "normalization",
  "restore",
];

/**
 * The immutable head snapshot of a published commit (§9.2): its Markdown and section index with the
 * commit's provenance. Stored encrypted at `u/<ownerId>/docs/<taskId>/<commitId>.md.sym`; outline,
 * section reads, search, changes, search indexing and artifact snapshots read it instead of Git.
 */
export interface DocumentSnapshot {
  readonly taskId: string;
  readonly commitId: string;
  readonly parentCommitId: string | null;
  readonly generation: number;
  readonly author: DocumentAuthorKind;
  readonly kind: DocumentCommitKind;
  readonly restoredFrom: string | null;
  /** Commit time in epoch milliseconds (whole seconds, as Git records it). */
  readonly committedAt: number;
  /** The commit message subject, for example "Updated Next steps". */
  readonly subject: string;
  readonly markdown: string;
  readonly index: SectionIndex;
}

/** An artifact is missing, fails authentication, or has an unexpected shape. */
export class ArtifactIntegrityError extends Error {
  readonly code = "document.integrity_failed";
  readonly reason: "missing" | "decrypt_failed" | "malformed" | "mismatch";
  constructor(reason: ArtifactIntegrityError["reason"]) {
    super("A document artifact failed its integrity check");
    this.name = "ArtifactIntegrityError";
    this.reason = reason;
  }
}

type EncodedSection = [
  path: string,
  kind: 0 | 1 | 2,
  depth: number,
  heading: string | null,
  parentIndex: number,
  start: number,
  bodyStart: number,
  end: number,
  subtreeEnd: number,
  lineStart: number,
  lineEnd: number,
  bytes: number,
  subtreeBytes: number,
  digest: string,
];

const kinds = ["preamble", "heading", "block"] as const;

function encodeSection(section: IndexedSection, positions: Map<string, number>): EncodedSection {
  return [
    section.path,
    kinds.indexOf(section.kind) as 0 | 1 | 2,
    section.depth,
    section.heading,
    section.parentId === null ? -1 : (positions.get(section.parentId) ?? -1),
    section.start,
    section.bodyStart,
    section.end,
    section.subtreeEnd,
    section.lineStart,
    section.lineEnd,
    section.bytes,
    section.subtreeBytes,
    section.digest,
  ];
}

/** Serializes a snapshot as compact JSON bytes. */
export function encodeSnapshot(snapshot: DocumentSnapshot): Buffer {
  const positions = new Map(snapshot.index.sections.map((section, index) => [section.id, index]));
  return Buffer.from(
    JSON.stringify({
      v: 1,
      taskId: snapshot.taskId,
      commitId: snapshot.commitId,
      parentCommitId: snapshot.parentCommitId,
      generation: snapshot.generation,
      author: snapshot.author,
      kind: snapshot.kind,
      restoredFrom: snapshot.restoredFrom,
      committedAt: snapshot.committedAt,
      subject: snapshot.subject,
      markdown: snapshot.markdown,
      mode: snapshot.index.mode,
      fallbackReason: snapshot.index.fallbackReason,
      hasRawHtml: snapshot.index.hasRawHtml,
      canonical: snapshot.index.canonical,
      length: snapshot.index.length,
      bytes: snapshot.index.bytes,
      sections: snapshot.index.sections.map((section) => encodeSection(section, positions)),
    }),
    "utf8",
  );
}

const nonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function malformed(): never {
  throw new ArtifactIntegrityError("malformed");
}

/**
 * Parses and validates snapshot bytes for an expected task and commit. Rebuilds the derived fields
 * (section ids, children, continuity keys) instead of trusting stored copies.
 */
export function decodeSnapshot(
  bytes: Uint8Array,
  expected: { readonly taskId: string; readonly commitId: string },
): DocumentSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    malformed();
  }
  if (typeof value !== "object" || value === null) malformed();
  const record = value as Record<string, unknown>;
  if (record.v !== 1) malformed();
  if (record.taskId !== expected.taskId || record.commitId !== expected.commitId) {
    throw new ArtifactIntegrityError("mismatch");
  }
  const { markdown, sections } = record;
  if (typeof markdown !== "string" || !Array.isArray(sections)) malformed();
  if (
    !(
      record.parentCommitId === null ||
      (typeof record.parentCommitId === "string" && REVISION_PATTERN.test(record.parentCommitId))
    ) ||
    !nonNegative(record.generation) ||
    !DOCUMENT_AUTHOR_KINDS.includes(record.author as DocumentAuthorKind) ||
    !DOCUMENT_COMMIT_KINDS.includes(record.kind as DocumentCommitKind) ||
    !(
      record.restoredFrom === null ||
      (typeof record.restoredFrom === "string" && REVISION_PATTERN.test(record.restoredFrom))
    ) ||
    !nonNegative(record.committedAt) ||
    typeof record.subject !== "string" ||
    (record.mode !== "parsed" && record.mode !== "fallback") ||
    !(record.fallbackReason === null || typeof record.fallbackReason === "string") ||
    typeof record.hasRawHtml !== "boolean" ||
    !(record.canonical === null || typeof record.canonical === "boolean") ||
    record.length !== markdown.length ||
    !nonNegative(record.bytes)
  ) {
    malformed();
  }
  const commitId = expected.commitId;
  const ids = sections.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 14 || typeof entry[0] !== "string") malformed();
    return sectionId(commitId, entry[0]);
  });
  const children = new Map<number, string[]>();
  const decoded = (sections as unknown[][]).map((entry, index): IndexedSection => {
    const [
      path,
      kind,
      depth,
      heading,
      parentIndex,
      start,
      bodyStart,
      end,
      subtreeEnd,
      lineStart,
      lineEnd,
      size,
      subtreeSize,
      digest,
    ] = entry;
    if (
      typeof path !== "string" ||
      (kind !== 0 && kind !== 1 && kind !== 2) ||
      !nonNegative(depth) ||
      !(heading === null || typeof heading === "string") ||
      typeof parentIndex !== "number" ||
      !Number.isSafeInteger(parentIndex) ||
      parentIndex < -1 ||
      parentIndex >= index ||
      !nonNegative(start) ||
      !nonNegative(bodyStart) ||
      !nonNegative(end) ||
      !nonNegative(subtreeEnd) ||
      !(
        start <= bodyStart &&
        bodyStart <= end &&
        end <= subtreeEnd &&
        subtreeEnd <= markdown.length
      ) ||
      !nonNegative(lineStart) ||
      !nonNegative(lineEnd) ||
      !nonNegative(size) ||
      !nonNegative(subtreeSize) ||
      typeof digest !== "string"
    ) {
      malformed();
    }
    if (parentIndex >= 0) {
      const list = children.get(parentIndex) ?? [];
      list.push(ids[index] as string);
      children.set(parentIndex, list);
    }
    const sectionKind = kinds[kind];
    return {
      id: ids[index] as string,
      path,
      kind: sectionKind,
      depth,
      heading,
      parentId: parentIndex >= 0 ? (ids[parentIndex] as string) : null,
      childIds: [],
      start,
      bodyStart,
      end,
      subtreeEnd,
      lineStart,
      lineEnd,
      bytes: size,
      subtreeBytes: subtreeSize,
      digest,
      matchKey:
        sectionKind === "heading"
          ? `h:${depth}:${normalizeForSearch(heading ?? "").text}`
          : sectionKind === "preamble"
            ? "p"
            : `b:${digest}`,
    };
  });
  const finished = decoded.map((section, index) =>
    Object.freeze({ ...section, childIds: Object.freeze(children.get(index) ?? []) }),
  );
  return Object.freeze({
    taskId: expected.taskId,
    commitId,
    parentCommitId: record.parentCommitId as string | null,
    generation: record.generation as number,
    author: record.author as DocumentAuthorKind,
    kind: record.kind as DocumentCommitKind,
    restoredFrom: record.restoredFrom as string | null,
    committedAt: record.committedAt as number,
    subject: record.subject as string,
    markdown,
    index: Object.freeze({
      commitId,
      mode: record.mode as "parsed" | "fallback",
      fallbackReason: record.fallbackReason as string | null,
      hasRawHtml: record.hasRawHtml as boolean,
      canonical: record.canonical as boolean | null,
      length: markdown.length,
      bytes: record.bytes as number,
      sections: Object.freeze(finished),
    }),
  });
}

/** A short digest of document text, for comparing an existing artifact without keeping plaintext around. */
export function markdownDigest(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("base64url");
}
