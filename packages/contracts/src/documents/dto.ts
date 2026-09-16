import { taskIdSchema } from "../common/ids.ts";
import { cursorSchema, pageLimitSchema } from "../common/pagination.ts";
import { counterSchema, epochMillisSchema } from "../common/primitives.ts";
import { z } from "../common/zod.ts";

/**
 * REST request and response schemas owned by the documents feature (§9).
 * Export Zod schemas with a `documents`-specific name so the contracts index stays collision free.
 */

/** A published revision: the lower-case SHA-1 id of a real Git commit (note 11). */
export const documentRevisionSchema = z
  .string({ error: "Expected a revision" })
  .regex(/^[0-9a-f]{40}$/, { error: "Expected a revision" });
export type DocumentRevision = z.infer<typeof documentRevisionSchema>;

/** An opaque section id, scoped to one revision (§9.1). */
export const documentSectionIdSchema = z
  .string({ error: "Expected a section id" })
  .regex(/^s[A-Za-z0-9_-]{25}$/, { error: "Expected a section id" });
export type DocumentSectionId = z.infer<typeof documentSectionIdSchema>;

/** The largest document in UTF-16 code units; the server also enforces `DOC_MAX_BYTES` in UTF-8. */
export const documentMaxLength = 1_048_576;

export const documentMarkdownSchema = z
  .string({ error: "Expected Markdown text" })
  .max(documentMaxLength, { error: "The document is too large" });

export const documentAuthorSchema = z.enum(["user", "simon", "mcp"]);
export type DocumentAuthor = z.infer<typeof documentAuthorSchema>;

export const documentCommitKindSchema = z.enum(["create", "edit", "normalization", "restore"]);
export type DocumentCommitKind = z.infer<typeof documentCommitKindSchema>;

export const documentSectionKindSchema = z.enum(["preamble", "heading", "block"]);
export type DocumentSectionKind = z.infer<typeof documentSectionKindSchema>;

/** How a revision was indexed: by the Markdown parser, or by the line scanner beyond its work limits. */
export const documentParseModeSchema = z.enum(["parsed", "fallback"]);

/** A section reference with its sizes; never body text (note 06 outline entries). */
export const documentSectionSummarySchema = z.strictObject({
  sectionId: documentSectionIdSchema,
  parentId: documentSectionIdSchema.nullable(),
  kind: documentSectionKindSchema,
  depth: z.number().int().min(0).max(6),
  heading: z.string().max(201).nullable(),
  bytes: counterSchema,
  subtreeBytes: counterSchema,
  childCount: counterSchema,
  /** 1-based lines, so the raw view can place the section (§9.3). */
  lineStart: counterSchema,
  lineEnd: counterSchema,
});
export type DocumentSectionSummary = z.infer<typeof documentSectionSummarySchema>;

/** The editor's stored draft (§9.3). */
export const documentDraftSchema = z.strictObject({
  baseRevision: documentRevisionSchema.nullable(),
  clientSeq: counterSchema,
  markdown: documentMarkdownSchema,
  /** `conflict` when a conflicting save preserved it. */
  origin: z.enum(["editor", "conflict"]),
  updatedAt: epochMillisSchema,
});
export type DocumentDraft = z.infer<typeof documentDraftSchema>;

/** `GET /v1/tasks/:taskId/document`: the published head, its sections and the stored draft. */
export const documentHeadResponseSchema = z.strictObject({
  taskId: taskIdSchema,
  /** Null when nothing was published yet (the empty page). */
  revision: documentRevisionSchema.nullable(),
  generation: counterSchema,
  author: documentAuthorSchema.nullable(),
  updatedAt: epochMillisSchema.nullable(),
  markdown: documentMarkdownSchema,
  bytes: counterSchema,
  /** Whether the head equals its canonical serialization; null when the server skipped the check. */
  canonical: z.boolean().nullable(),
  /** Raw HTML opens the page view read-only (§9.3). */
  hasRawHtml: z.boolean(),
  parseMode: documentParseModeSchema,
  sections: z.array(documentSectionSummarySchema),
  draft: documentDraftSchema.nullable(),
});
export type DocumentHeadResponse = z.infer<typeof documentHeadResponseSchema>;

/** `POST /v1/tasks/:taskId/document/commits` (Idempotency-Key required). */
export const documentSaveRequestSchema = z.strictObject({
  /** The revision the editor started from; null for a page with no published revision. */
  baseRevision: documentRevisionSchema.nullable(),
  markdown: documentMarkdownSchema,
  /** `normalization` for the separate "Formatting normalized" commit (decision R7). */
  kind: z.enum(["edit", "normalization"]).default("edit"),
  /** The draft sequence this save covers; the stored draft is cleared when it is not newer. */
  draftSeq: counterSchema.optional(),
});
export type DocumentSaveRequest = z.input<typeof documentSaveRequestSchema>;

/** The result of a save or restore. `unchanged` means the content already matched the head. */
export const documentPublishResponseSchema = z.strictObject({
  taskId: taskIdSchema,
  status: z.enum(["published", "unchanged"]),
  revision: documentRevisionSchema.nullable(),
  generation: counterSchema,
  changedSectionIds: z.array(documentSectionIdSchema).max(100),
  restoredFrom: documentRevisionSchema.nullable(),
});
export type DocumentPublishResponse = z.infer<typeof documentPublishResponseSchema>;

/** `document.conflict` details: the head the save lost to, and whether the candidate was kept as the draft. */
export const documentConflictErrorDetailsSchema = z.strictObject({
  currentRevision: documentRevisionSchema.nullable(),
  currentGeneration: counterSchema,
  draftPreserved: z.boolean(),
});
export type DocumentConflictErrorDetails = z.infer<typeof documentConflictErrorDetailsSchema>;

/** `PUT /v1/tasks/:taskId/document/draft`: an ordered, throttled draft write (§9.3). */
export const documentDraftPutRequestSchema = z.strictObject({
  baseRevision: documentRevisionSchema.nullable(),
  clientSeq: counterSchema,
  markdown: documentMarkdownSchema,
});
export type DocumentDraftPutRequest = z.infer<typeof documentDraftPutRequestSchema>;

export const documentDraftPutResponseSchema = z.strictObject({
  clientSeq: counterSchema,
  updatedAt: epochMillisSchema,
});

/** `DELETE /v1/tasks/:taskId/document/draft?clientSeq=`: clears the draft unless a newer one exists. */
export const documentDraftDeleteQuerySchema = z.strictObject({
  clientSeq: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,15})$/, { error: "Expected a sequence number" })
    .transform(Number),
});

/** The history page size limit. */
export const documentHistoryLimitMax = 50;

export const documentHistoryQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: pageLimitSchema.pipe(z.number().max(documentHistoryLimitMax)).optional(),
});

/** One revision in history (document_history brief): actor, time, and a section description. */
export const documentHistoryEntrySchema = z.strictObject({
  revision: documentRevisionSchema,
  parentRevision: documentRevisionSchema.nullable(),
  generation: counterSchema,
  author: documentAuthorSchema,
  kind: documentCommitKindSchema,
  restoredFrom: documentRevisionSchema.nullable(),
  /** For example "Updated Next steps" or "Formatting normalized". */
  subject: z.string().max(300),
  committedAt: epochMillisSchema,
});
export type DocumentHistoryEntry = z.infer<typeof documentHistoryEntrySchema>;

export const documentHistoryResponseSchema = z.strictObject({
  taskId: taskIdSchema,
  headRevision: documentRevisionSchema.nullable(),
  items: z.array(documentHistoryEntrySchema).max(documentHistoryLimitMax),
  nextCursor: cursorSchema.nullable(),
});
export type DocumentHistoryResponse = z.infer<typeof documentHistoryResponseSchema>;

/** `GET /v1/tasks/:taskId/document/revisions/:revision`: a readable preview of one revision. */
export const documentRevisionResponseSchema = z.strictObject({
  taskId: taskIdSchema,
  entry: documentHistoryEntrySchema,
  headRevision: documentRevisionSchema,
  isHead: z.boolean(),
  markdown: documentMarkdownSchema,
  sections: z.array(documentSectionSummarySchema),
});
export type DocumentRevisionResponse = z.infer<typeof documentRevisionResponseSchema>;

/** A section-level change between two revisions (§9.4). */
export const documentSectionChangeSchema = z.strictObject({
  status: z.enum(["added", "modified", "removed"]),
  sectionId: documentSectionIdSchema.nullable(),
  baselineSectionId: documentSectionIdSchema.nullable(),
  kind: documentSectionKindSchema,
  depth: z.number().int().min(0).max(6),
  heading: z.string().max(201).nullable(),
  bytes: counterSchema,
});
export type DocumentSectionChange = z.infer<typeof documentSectionChangeSchema>;

/** One labeled diff line; added and removed never rely on color alone (document_history brief). */
export const documentDiffLineSchema = z.strictObject({
  kind: z.enum(["context", "added", "removed"]),
  text: z.string(),
  baseLine: counterSchema.nullable(),
  targetLine: counterSchema.nullable(),
});

export const documentDiffHunkSchema = z.strictObject({
  baseStart: counterSchema,
  baseLines: counterSchema,
  targetStart: counterSchema,
  targetLines: counterSchema,
  truncated: z.boolean(),
  lines: z.array(documentDiffLineSchema),
});
export type DocumentDiffHunk = z.infer<typeof documentDiffHunkSchema>;

/** `GET /v1/tasks/:taskId/document/compare?base=&target=`: the target is pinned in the cursor. */
export const documentCompareQuerySchema = z.strictObject({
  base: documentRevisionSchema,
  target: documentRevisionSchema.optional(),
  cursor: cursorSchema.optional(),
});

export const documentCompareResponseSchema = z.strictObject({
  taskId: taskIdSchema,
  baseRevision: documentRevisionSchema,
  targetRevision: documentRevisionSchema,
  headRevision: documentRevisionSchema,
  /** Commits between baseline and target; a net-empty comparison can still have intervening commits. */
  commitsBetween: counterSchema,
  changes: z.array(documentSectionChangeSchema),
  hunks: z.array(documentDiffHunkSchema),
  nextCursor: cursorSchema.nullable(),
});
export type DocumentCompareResponse = z.infer<typeof documentCompareResponseSchema>;

/** `POST /v1/tasks/:taskId/document/restore` (Idempotency-Key required): a new commit, never a reset. */
export const documentRestoreRequestSchema = z.strictObject({
  revision: documentRevisionSchema,
  /** The head the user previewed against; a newer head is a restore conflict. */
  expectedRevision: documentRevisionSchema,
});
export type DocumentRestoreRequest = z.infer<typeof documentRestoreRequestSchema>;

/** `GET /v1/tasks/:taskId/document/conflict?base=`: what changed on each side since the draft's base. */
export const documentConflictQuerySchema = z.strictObject({
  base: z.union([documentRevisionSchema, z.literal("none")]),
});

export const documentConflictSectionSchema = z.strictObject({
  status: z.enum(["both_changed", "saved_changed", "draft_changed", "unchanged"]),
  kind: documentSectionKindSchema,
  depth: z.number().int().min(0).max(6),
  heading: z.string().max(201).nullable(),
  savedSectionId: documentSectionIdSchema.nullable(),
  /** The draft's and the saved text of a section both sides changed (bounded; null otherwise). */
  draftText: z.string().nullable(),
  savedText: z.string().nullable(),
});

export const documentConflictResponseSchema = z.strictObject({
  taskId: taskIdSchema,
  baseRevision: documentRevisionSchema.nullable(),
  currentRevision: documentRevisionSchema.nullable(),
  currentGeneration: counterSchema,
  draft: documentDraftSchema.nullable(),
  savedMarkdown: documentMarkdownSchema,
  sections: z.array(documentConflictSectionSchema),
  /** True when section texts were omitted to stay within the response bound. */
  truncated: z.boolean(),
});
export type DocumentConflictResponse = z.infer<typeof documentConflictResponseSchema>;
