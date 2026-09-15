import { createHash } from "node:crypto";
import type { Nodes, Root, RootContent } from "mdast";
import {
  type DocumentStructure,
  normalizeForSearch,
  parseDocument,
  type SectionKind,
  serializeCanonicalTree,
  splitSections,
  utf8ByteLength,
} from "../markdown/index.ts";

/** Documents larger than this skip the server-side canonical check (`canonical: null`). */
export const CANONICAL_CHECK_MAX_BYTES = 262_144;

/** Commit ids are lower-case SHA-1 hex (Git's default object format). */
export const REVISION_PATTERN = /^[0-9a-f]{40}$/;

/** Opaque, revision-scoped section ids (§9.1): `s` and 25 base64url characters. */
export const SECTION_ID_PATTERN = /^s[A-Za-z0-9_-]{25}$/;

/**
 * The opaque id of a section: derived from the commit id and the section's structural path, so ids
 * of one revision never name a section of another and heading text never appears in an id (§9.1).
 */
export function sectionId(commitId: string, path: string): string {
  const digest = createHash("sha256")
    .update("symplist/section/v1")
    .update("\0")
    .update(commitId)
    .update("\0")
    .update(path)
    .digest("base64url");
  return `s${digest.slice(0, 25)}`;
}

/** One section of a published revision, as stored in its head snapshot (§9.2). */
export interface IndexedSection {
  readonly id: string;
  readonly path: string;
  readonly kind: SectionKind;
  readonly depth: number;
  readonly heading: string | null;
  readonly parentId: string | null;
  readonly childIds: readonly string[];
  readonly start: number;
  readonly bodyStart: number;
  readonly end: number;
  readonly subtreeEnd: number;
  readonly lineStart: number;
  readonly lineEnd: number;
  /** UTF-8 bytes of the section's own content. */
  readonly bytes: number;
  /** UTF-8 bytes of the section and its descendants. */
  readonly subtreeBytes: number;
  /**
   * Digest of the section's normalized content: its mdast without positions when the document was
   * parsed, otherwise its whitespace-normalized text. Equal digests mean content-neutral (§9.3).
   */
  readonly digest: string;
  /** Continuity key used to pair sections across revisions (kind, depth and folded heading text). */
  readonly matchKey: string;
}

export interface SectionIndex {
  readonly commitId: string;
  readonly mode: DocumentStructure["mode"];
  readonly fallbackReason: string | null;
  readonly hasRawHtml: boolean;
  /**
   * Whether the document equals its canonical serialization: false when it differs or cannot be
   * normalized, null when it was too large to check on the server (the page view checks it, §9.3).
   */
  readonly canonical: boolean | null;
  /** Length in UTF-16 code units. */
  readonly length: number;
  /** UTF-8 bytes. */
  readonly bytes: number;
  readonly sections: readonly IndexedSection[];
}

function stripPositions(node: Nodes): unknown {
  const stack: Array<{ source: unknown; target: Record<string, unknown> | unknown[] }> = [];
  const copy = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      stack.push({ source: value, target: out });
      return out;
    }
    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {};
      stack.push({ source: value, target: out });
      return out;
    }
    return value;
  };
  const root = copy(node);
  while (stack.length > 0) {
    const { source, target } = stack.pop() as (typeof stack)[number];
    if (Array.isArray(source)) {
      for (const item of source) (target as unknown[]).push(copy(item));
    } else {
      for (const key of Object.keys(source as object).sort()) {
        if (key === "position" || key === "data") continue;
        (target as Record<string, unknown>)[key] = copy((source as Record<string, unknown>)[key]);
      }
    }
  }
  return root;
}

function digestText(text: string): string {
  return createHash("sha256").update(text).digest("base64url").slice(0, 32);
}

function normalizedTextDigest(text: string): string {
  const normalized = text
    .split("\n")
    .map((line) => line.replace(/[ \t\r]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return digestText(`t:${normalized}`);
}

/** Digests of each section from the parsed tree: the position-free AST of its top-level nodes. */
function astDigests(tree: Root, structure: DocumentStructure): string[] {
  const buckets: RootContent[][] = structure.sections.map(() => []);
  let sectionIndex = 0;
  for (const child of tree.children) {
    const offset = child.position?.start.offset;
    if (typeof offset !== "number") continue;
    while (
      sectionIndex < structure.sections.length - 1 &&
      offset >= (structure.sections[sectionIndex]?.end ?? 0)
    ) {
      sectionIndex += 1;
    }
    buckets[sectionIndex]?.push(child);
  }
  return buckets.map((nodes) =>
    digestText(`a:${JSON.stringify(nodes.map((node) => stripPositions(node)))}`),
  );
}

function matchKeyOf(kind: SectionKind, depth: number, heading: string | null, digest: string) {
  if (kind === "heading") return `h:${depth}:${normalizeForSearch(heading ?? "").text}`;
  if (kind === "preamble") return "p";
  return `b:${digest}`;
}

/**
 * Builds the section index of a revision: structural sections with opaque ids, parent and child
 * references, sizes, normalized digests and continuity keys. Parses the document once (the line
 * scanner beyond the work limits) and never throws for any string.
 */
export function buildSectionIndex(markdown: string, commitId: string): SectionIndex {
  const parsed = markdown.trim().length === 0 ? null : parseDocument(markdown);
  const structure = splitSections(markdown, parsed ? { parsed } : {});
  const digests =
    parsed?.mode === "parsed"
      ? astDigests(parsed.tree, structure)
      : structure.sections.map((section) =>
          normalizedTextDigest(markdown.slice(section.start, section.end)),
        );
  const ids = new Map(
    structure.sections.map((section) => [section.path, sectionId(commitId, section.path)]),
  );
  const children = new Map<string, string[]>();
  for (const section of structure.sections) {
    if (!section.parentPath) continue;
    const list = children.get(section.parentPath) ?? [];
    list.push(ids.get(section.path) as string);
    children.set(section.parentPath, list);
  }
  const sections = structure.sections.map((section, index): IndexedSection => {
    const digest = digests[index] as string;
    return Object.freeze({
      id: ids.get(section.path) as string,
      path: section.path,
      kind: section.kind,
      depth: section.depth,
      heading: section.heading,
      parentId: section.parentPath ? (ids.get(section.parentPath) ?? null) : null,
      childIds: Object.freeze(children.get(section.path) ?? []),
      start: section.start,
      bodyStart: section.bodyStart,
      end: section.end,
      subtreeEnd: section.subtreeEnd,
      lineStart: section.lineStart,
      lineEnd: section.lineEnd,
      bytes: utf8ByteLength(markdown, section.start, section.end),
      subtreeBytes: utf8ByteLength(markdown, section.start, section.subtreeEnd),
      digest,
      matchKey: matchKeyOf(section.kind, section.depth, section.heading, digest),
    });
  });
  const bytes = utf8ByteLength(markdown);
  let canonical: boolean | null = false;
  if (parsed === null) {
    canonical = markdown === "";
  } else if (parsed.mode === "parsed") {
    if (bytes > CANONICAL_CHECK_MAX_BYTES) {
      canonical = null;
    } else {
      try {
        canonical = serializeCanonicalTree(parsed.tree) === markdown;
      } catch {
        canonical = false;
      }
    }
  }
  return Object.freeze({
    commitId,
    mode: structure.mode,
    fallbackReason: structure.fallbackReason,
    hasRawHtml: structure.hasRawHtml,
    canonical,
    length: markdown.length,
    bytes,
    sections: Object.freeze(sections),
  });
}

/**
 * The same index for another commit id: section ids, parent ids and child ids are re-derived from the
 * structural paths, so a document is parsed once even when its commit id is known only after the
 * index is needed (the publisher computes changes before committing).
 */
export function rebindSectionIndex(index: SectionIndex, commitId: string): SectionIndex {
  if (index.commitId === commitId) return index;
  const ids = new Map(
    index.sections.map((section) => [section.id, sectionId(commitId, section.path)]),
  );
  const rebound = (id: string) => ids.get(id) as string;
  return Object.freeze({
    ...index,
    commitId,
    sections: Object.freeze(
      index.sections.map((section) =>
        Object.freeze({
          ...section,
          id: rebound(section.id),
          parentId: section.parentId === null ? null : rebound(section.parentId),
          childIds: Object.freeze(section.childIds.map(rebound)),
        }),
      ),
    ),
  });
}

/** Finds a section of an index by id. */
export function findSection(index: SectionIndex, id: string): IndexedSection | undefined {
  return index.sections.find((section) => section.id === id);
}
