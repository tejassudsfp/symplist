import { taskIdSchema } from "../common/ids.ts";
import { cursorSchema } from "../common/pagination.ts";
import { counterSchema } from "../common/primitives.ts";
import { defineTools } from "../common/tools.ts";
import { z } from "../common/zod.ts";
import {
  documentDiffHunkSchema,
  documentHistoryEntrySchema,
  documentParseModeSchema,
  documentRevisionSchema,
  documentSectionChangeSchema,
  documentSectionIdSchema,
  documentSectionKindSchema,
} from "./dto.ts";

/**
 * Tool limits (note 06 "Bounds and correctness"): caller-supplied limits can only reduce these, and
 * every read also draws from the per-turn (or per-grant) retrieval budget.
 */
export const documentToolLimits = Object.freeze({
  outlineDefault: 50,
  outlineMax: 100,
  searchDefault: 10,
  searchMax: 20,
  snippetChars: 240,
  readDefaultBytes: 8_192,
  readMinBytes: 256,
  readMaxBytes: 16_384,
  diffDefaultBytes: 16_384,
  diffMaxBytes: 32_768,
  changesDefault: 50,
  changesMax: 100,
  historyDefault: 20,
  historyMax: 50,
  /** Replacement Markdown per section update. */
  updateMaxChars: 65_536,
  searchQueryMaxChars: 200,
});

const outlineEntrySchema = z.strictObject({
  sectionId: documentSectionIdSchema,
  parentId: documentSectionIdSchema.nullable(),
  kind: documentSectionKindSchema,
  depth: z.number().int().min(0).max(6),
  heading: z.string().max(201).nullable(),
  bytes: counterSchema,
  subtreeBytes: counterSchema,
  childCount: counterSchema,
});

/** `task_document_outline`: paginated section references at a revision (default: the head). */
export const taskDocumentOutlineInputSchema = z.strictObject({
  taskId: taskIdSchema,
  revision: documentRevisionSchema.optional(),
  cursor: cursorSchema.optional(),
  limit: z.number().int().min(1).max(documentToolLimits.outlineMax).optional(),
});

export const taskDocumentOutlineOutputSchema = z.strictObject({
  taskId: taskIdSchema,
  /** Null when the page has no published revision. */
  revision: documentRevisionSchema.nullable(),
  headRevision: documentRevisionSchema.nullable(),
  isHead: z.boolean(),
  parseMode: documentParseModeSchema,
  totalSections: counterSchema,
  entries: z.array(outlineEntrySchema).max(documentToolLimits.outlineMax),
  nextCursor: cursorSchema.nullable(),
});

/** `task_document_search`: bounded snippets and section references in the head revision. */
export const taskDocumentSearchInputSchema = z.strictObject({
  taskId: taskIdSchema,
  query: z.string().trim().min(1).max(documentToolLimits.searchQueryMaxChars),
  cursor: cursorSchema.optional(),
  limit: z.number().int().min(1).max(documentToolLimits.searchMax).optional(),
});

export const taskDocumentSearchOutputSchema = z.strictObject({
  taskId: taskIdSchema,
  revision: documentRevisionSchema.nullable(),
  matches: z
    .array(
      z.strictObject({
        sectionId: documentSectionIdSchema,
        heading: z.string().max(201).nullable(),
        kind: documentSectionKindSchema,
        snippet: z.string().max(documentToolLimits.snippetChars + 4),
        matchCount: counterSchema,
      }),
    )
    .max(documentToolLimits.searchMax),
  nextCursor: cursorSchema.nullable(),
  retrievedBytes: counterSchema,
});

/** `task_document_read_section`: a bounded chunk of one section's own content at a revision. */
export const taskDocumentReadSectionInputSchema = z.strictObject({
  taskId: taskIdSchema,
  sectionId: documentSectionIdSchema,
  /** The revision the section id belongs to. */
  revision: documentRevisionSchema,
  cursor: cursorSchema.optional(),
  maxBytes: z
    .number()
    .int()
    .min(documentToolLimits.readMinBytes)
    .max(documentToolLimits.readMaxBytes)
    .optional(),
});

export const taskDocumentReadSectionOutputSchema = z.strictObject({
  taskId: taskIdSchema,
  sectionId: documentSectionIdSchema,
  revision: documentRevisionSchema,
  headRevision: documentRevisionSchema,
  /** False when the head moved past `revision`; re-read the outline before editing. */
  isHead: z.boolean(),
  kind: documentSectionKindSchema,
  depth: z.number().int().min(0).max(6),
  heading: z.string().max(201).nullable(),
  parentId: documentSectionIdSchema.nullable(),
  /** Child sections are references for deliberate navigation; their text is never included. */
  childIds: z.array(documentSectionIdSchema),
  text: z.string(),
  rangeStart: counterSchema,
  rangeEnd: counterSchema,
  sectionLength: counterSchema,
  truncated: z.boolean(),
  nextCursor: cursorSchema.nullable(),
  retrievedBytes: counterSchema,
  remainingBudgetBytes: counterSchema,
});

/** `task_document_update_section`: an expected-revision edit that publishes a real commit. */
export const taskDocumentUpdateSectionInputSchema = z.strictObject({
  taskId: taskIdSchema,
  /** The head the edit was prepared against; null only for a page with no published revision. */
  expectedRevision: documentRevisionSchema.nullable(),
  /** Required for `replace` and `after`. */
  sectionId: documentSectionIdSchema.optional(),
  placement: z.enum(["replace", "after", "end"]).default("replace"),
  markdown: z.string().max(documentToolLimits.updateMaxChars),
});

export const taskDocumentPublishOutputSchema = z.strictObject({
  taskId: taskIdSchema,
  status: z.enum(["published", "unchanged"]),
  revision: documentRevisionSchema.nullable(),
  generation: counterSchema,
  changedSectionIds: z.array(documentSectionIdSchema).max(100),
  restoredFrom: documentRevisionSchema.nullable(),
});

/** `task_document_changes`: section changes since a baseline, with the target pinned across pages. */
export const taskDocumentChangesInputSchema = z.strictObject({
  taskId: taskIdSchema,
  baselineRevision: documentRevisionSchema,
  cursor: cursorSchema.optional(),
  limit: z.number().int().min(1).max(documentToolLimits.changesMax).optional(),
});

export const taskDocumentChangesOutputSchema = z.strictObject({
  taskId: taskIdSchema,
  baselineRevision: documentRevisionSchema,
  targetRevision: documentRevisionSchema,
  headRevision: documentRevisionSchema,
  commitsBetween: counterSchema,
  changes: z.array(documentSectionChangeSchema).max(documentToolLimits.changesMax),
  nextCursor: cursorSchema.nullable(),
});

/** `task_document_diff`: bounded hunks between two published commits, optionally scoped to sections. */
export const taskDocumentDiffInputSchema = z.strictObject({
  taskId: taskIdSchema,
  baseRevision: documentRevisionSchema,
  /** Defaults to the head at the first page, then pinned in the cursor. */
  targetRevision: documentRevisionSchema.optional(),
  /** Sections of the target revision to scope hunks to. */
  sectionIds: z.array(documentSectionIdSchema).max(20).optional(),
  cursor: cursorSchema.optional(),
  maxBytes: z.number().int().min(512).max(documentToolLimits.diffMaxBytes).optional(),
});

export const taskDocumentDiffOutputSchema = z.strictObject({
  taskId: taskIdSchema,
  baseRevision: documentRevisionSchema,
  targetRevision: documentRevisionSchema,
  hunks: z.array(documentDiffHunkSchema),
  nextCursor: cursorSchema.nullable(),
  retrievedBytes: counterSchema,
});

/** `task_document_history`: paginated published commits with provenance. */
export const taskDocumentHistoryInputSchema = z.strictObject({
  taskId: taskIdSchema,
  cursor: cursorSchema.optional(),
  limit: z.number().int().min(1).max(documentToolLimits.historyMax).optional(),
});

export const taskDocumentHistoryOutputSchema = z.strictObject({
  taskId: taskIdSchema,
  headRevision: documentRevisionSchema.nullable(),
  items: z.array(documentHistoryEntrySchema).max(documentToolLimits.historyMax),
  nextCursor: cursorSchema.nullable(),
});

/** `task_document_restore`: a new commit with an earlier revision's content, guarded by the head. */
export const taskDocumentRestoreInputSchema = z.strictObject({
  taskId: taskIdSchema,
  revision: documentRevisionSchema,
  expectedRevision: documentRevisionSchema,
});

/** Simon and MCP tool contracts owned by the documents feature (§9, §8.7, §14.6). */
export const documentsTools = defineTools({
  task_document_outline: {
    input: taskDocumentOutlineInputSchema,
    output: taskDocumentOutlineOutputSchema,
  },
  task_document_search: {
    input: taskDocumentSearchInputSchema,
    output: taskDocumentSearchOutputSchema,
  },
  task_document_read_section: {
    input: taskDocumentReadSectionInputSchema,
    output: taskDocumentReadSectionOutputSchema,
  },
  task_document_update_section: {
    input: taskDocumentUpdateSectionInputSchema,
    output: taskDocumentPublishOutputSchema,
  },
  task_document_changes: {
    input: taskDocumentChangesInputSchema,
    output: taskDocumentChangesOutputSchema,
  },
  task_document_diff: {
    input: taskDocumentDiffInputSchema,
    output: taskDocumentDiffOutputSchema,
  },
  task_document_history: {
    input: taskDocumentHistoryInputSchema,
    output: taskDocumentHistoryOutputSchema,
  },
  task_document_restore: {
    input: taskDocumentRestoreInputSchema,
    output: taskDocumentPublishOutputSchema,
  },
});

/** The document tools that need Git and run in `document-git` when `DURABLE=true` (§9.1, §9.2). */
export const documentGitToolNames = Object.freeze([
  "task_document_update_section",
  "task_document_diff",
  "task_document_history",
  "task_document_restore",
] as const);

/** The ids-only payload of the `document-git` Trigger task (§9.1). */
export const documentGitPayloadSchema = z.strictObject({
  runId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  toolCallId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  taskId: taskIdSchema,
  op: z.enum(["update_section", "diff", "history", "restore"]),
});
export type DocumentGitPayload = z.infer<typeof documentGitPayloadSchema>;

/** The ids-only output of the `document-git` task; the result itself is an encrypted job object. */
export const documentGitTaskOutputSchema = z.strictObject({
  status: z.enum(["completed", "failed"]),
  code: z
    .string()
    .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/)
    .nullable(),
});
