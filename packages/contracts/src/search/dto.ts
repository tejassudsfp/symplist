import { z } from "zod";
import { conversationIdSchema, messageIdSchema, taskIdSchema } from "../common/ids.ts";
import { cursorSchema } from "../common/pagination.ts";
import { counterSchema, epochMillisSchema } from "../common/primitives.ts";

/**
 * REST request and response schemas owned by the search feature (§10.1 and §10.2, note 14).
 * Every export carries a `search` prefix so the contracts index stays collision free.
 */

/* ------------------------------------------------------------------------------------------------
 * Limits and enums
 * --------------------------------------------------------------------------------------------- */

/** The longest query accepted, in UTF-16 code units after trimming. */
export const searchQueryMaxChars = 200;

/** Full search page sizes. */
export const searchPageLimitDefault = 20;
export const searchPageLimitMax = 50;

/** Quick title search (the command palette) result counts. */
export const searchTitleLimitDefault = 8;
export const searchTitleLimitMax = 20;

/** Section and message hits shown under one task, and when one task is expanded. */
export const searchHitsPerGroup = 3;
export const searchHitsPerExpandedGroup = 50;

/** The longest snippet text a result carries, and the most highlight ranges per text. */
export const searchSnippetMaxChars = 240;
export const searchHighlightsMax = 16;

/** Collections a search can be scoped to; Archive is a separate opt-in (note 14). */
export const searchCollections = ["now", "later", "unclassified"] as const;
export const searchCollectionSchema = z.enum(searchCollections);
export type SearchCollection = z.infer<typeof searchCollectionSchema>;

/**
 * Content types. `chat` is selectable separately so messages never swamp document results, and it
 * only returns messages when the owner opted chat into search (§10.1).
 */
export const searchContentTypes = ["tasks", "documents", "chat"] as const;
export const searchContentTypeSchema = z.enum(searchContentTypes);
export type SearchContentType = z.infer<typeof searchContentTypeSchema>;

/** The default content types: task titles and current documents. */
export const searchDefaultContentTypes: readonly SearchContentType[] = Object.freeze([
  "tasks",
  "documents",
]);

/** `exclude` (default): active tasks only; `include`: active and archived; `only`: archived only. */
export const searchArchiveModes = ["exclude", "include", "only"] as const;
export const searchArchiveModeSchema = z.enum(searchArchiveModes);
export type SearchArchiveMode = z.infer<typeof searchArchiveModeSchema>;

/**
 * Index freshness (§10.1). `ready`: results reflect every committed change. `partial`: some changes
 * or content are not searchable yet (pending changes beyond the in-memory overlay, a corpus size
 * limit, chat opted in but not indexed yet, capped candidates). `rebuilding`: the index is missing,
 * corrupt or from an older format and is being rebuilt; only task titles are searched meanwhile.
 */
export const searchIndexStatuses = ["ready", "partial", "rebuilding"] as const;
export const searchIndexStatusSchema = z.enum(searchIndexStatuses);
export type SearchIndexStatus = z.infer<typeof searchIndexStatusSchema>;

/**
 * Why a result matched, in ranking order (note 14): exact task title, title prefix, title terms,
 * title with a bounded typo, section heading, document body, chat message.
 */
export const searchMatchKinds = [
  "title_exact",
  "title_prefix",
  "title_terms",
  "title_typo",
  "heading",
  "body",
  "chat",
] as const;
export const searchMatchKindSchema = z.enum(searchMatchKinds);
export type SearchMatchKind = z.infer<typeof searchMatchKindSchema>;

/** The title match kinds the quick title search returns. */
export const searchTitleMatchKinds = [
  "title_exact",
  "title_prefix",
  "title_terms",
  "title_typo",
] as const;
export const searchTitleMatchKindSchema = z.enum(searchTitleMatchKinds);
export type SearchTitleMatchKind = z.infer<typeof searchTitleMatchKindSchema>;

/**
 * Explanations shown beside results, separate from the results themselves:
 * - `chat_opt_in_required`: chat was requested but the owner has not opted chat into search;
 * - `chat_indexing`: chat is opted in but the published index does not contain messages yet;
 * - `index_truncated`: the account exceeds the index size limit, so some document text is not searchable;
 * - `changes_pending`: some recent changes are not reflected yet;
 * - `results_capped`: more candidates matched than one search evaluates;
 * - `partial_terms`: no result contains every term, so results match some of them.
 */
export const searchNotices = [
  "chat_opt_in_required",
  "chat_indexing",
  "index_truncated",
  "changes_pending",
  "results_capped",
  "partial_terms",
] as const;
export const searchNoticeSchema = z.enum(searchNotices);
export type SearchNotice = z.infer<typeof searchNoticeSchema>;

/**
 * Deadline filters (note 14, note 15). They are typed here so clients and the api share one shape;
 * the api answers `search.filter_unavailable` until the scheduling feature supplies schedule
 * metadata, because deadlines are never derived from the index or title text.
 */
export const searchDeadlineFilters = ["has", "none", "due_today", "overdue", "range"] as const;
export const searchDeadlineFilterKindSchema = z.enum(searchDeadlineFilters);
export type SearchDeadlineFilterKind = z.infer<typeof searchDeadlineFilterKindSchema>;

/* ------------------------------------------------------------------------------------------------
 * Primitive fields
 * --------------------------------------------------------------------------------------------- */

/** Whether a query holds a control character (other than tab, line feed and carriage return). */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** Whether a string holds a lone UTF-16 surrogate, which no well-formed query contains. */
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** A search query: trimmed, 1 to 200 characters, no control characters, no lone surrogates. */
export const searchQueryTextSchema = z
  .string({ error: "Expected a search query" })
  .max(searchQueryMaxChars * 2, { error: "The search query is too long" })
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(1, { error: "Expected a search query" })
      .max(searchQueryMaxChars, { error: "The search query is too long" })
      .refine((value) => !hasControlCharacter(value), { error: "Invalid characters" })
      .refine((value) => !hasLoneSurrogate(value), { error: "Invalid characters" }),
  );

function commaListSchema<const Values extends readonly [string, ...string[]]>(
  values: Values,
  label: string,
) {
  return z
    .string({ error: `Expected ${label}` })
    .regex(/^[a-z_]{1,32}(?:,[a-z_]{1,32}){0,15}$/, { error: `Expected ${label}` })
    .transform((value) => value.split(","))
    .pipe(
      z
        .array(z.enum(values, { error: `Expected ${label}` }))
        .min(1)
        .refine((items) => new Set(items).size === items.length, {
          error: `Repeated ${label}`,
        }),
    );
}

/** `now,later` in a query string. */
export const searchCollectionListSchema = commaListSchema(searchCollections, "collections");

/** `tasks,documents,chat` in a query string. */
export const searchContentTypeListSchema = commaListSchema(searchContentTypes, "content types");

function positiveLimitSchema(max: number) {
  return z
    .union([
      z.number({ error: "Expected a limit" }),
      z
        .string({ error: "Expected a limit" })
        .regex(/^[1-9][0-9]{0,2}$/, { error: "Expected a limit" })
        .transform(Number),
    ])
    .pipe(
      z
        .number()
        .int({ error: "Expected a whole limit" })
        .min(1, { error: `Expected a limit between 1 and ${max}` })
        .max(max, { error: `Expected a limit between 1 and ${max}` }),
    );
}

/** A calendar date `YYYY-MM-DD` that exists. */
export const searchDateSchema = z
  .string({ error: "Expected a date" })
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Expected a date as YYYY-MM-DD" })
  .refine(
    (value) => {
      const [year, month, day] = value.split("-").map(Number) as [number, number, number];
      const date = new Date(Date.UTC(year, month - 1, day));
      return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
      );
    },
    { error: "Expected a date that exists" },
  );

/** An IANA time zone the runtime recognizes, such as `America/Los_Angeles`. */
export const searchTimeZoneSchema = z
  .string({ error: "Expected a time zone" })
  .regex(/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,3}$/, { error: "Expected a time zone" })
  .max(64, { error: "Expected a time zone" })
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    { error: "Expected a known time zone" },
  );

/** An opaque document revision, as the documents feature reports head revisions (§7). */
export const searchRevisionSchema = z
  .string({ error: "Expected a revision" })
  .regex(/^[A-Za-z0-9_-]{1,128}$/, { error: "Expected a revision" });

/** An opaque section id, derived by the documents feature from commit id and structural path (§9.1). */
export const searchSectionIdSchema = z
  .string({ error: "Expected a section id" })
  .regex(/^[A-Za-z0-9._:-]{1,256}$/, { error: "Expected a section id" });

/* ------------------------------------------------------------------------------------------------
 * Deadline filter (typed placeholder until scheduling)
 * --------------------------------------------------------------------------------------------- */

/** A parsed deadline filter; comparisons use `timeZone` for date-only deadlines (note 14, note 15). */
export const searchDeadlineFilterSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("has") }),
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("due_today"), timeZone: searchTimeZoneSchema }),
  z.strictObject({ kind: z.literal("overdue"), timeZone: searchTimeZoneSchema }),
  z
    .strictObject({
      kind: z.literal("range"),
      from: searchDateSchema,
      to: searchDateSchema,
      timeZone: searchTimeZoneSchema,
    })
    .refine((filter) => filter.from <= filter.to, { error: "The range ends before it starts" }),
]);

export type SearchDeadlineFilter = z.infer<typeof searchDeadlineFilterSchema>;

/* ------------------------------------------------------------------------------------------------
 * Requests
 * --------------------------------------------------------------------------------------------- */

/**
 * `GET /v1/search` query string. Defaults: every active collection, archive excluded, task titles and
 * documents. `taskId` expands one task's hits. Deadline filters need `timeZone` for `due_today`,
 * `overdue` and `range`, and `deadlineFrom`/`deadlineTo` for `range` only.
 */
export const searchRequestQuerySchema = z
  .strictObject({
    q: searchQueryTextSchema,
    collections: searchCollectionListSchema.optional(),
    archive: searchArchiveModeSchema.optional(),
    types: searchContentTypeListSchema.optional(),
    taskId: taskIdSchema.optional(),
    deadline: searchDeadlineFilterKindSchema.optional(),
    deadlineFrom: searchDateSchema.optional(),
    deadlineTo: searchDateSchema.optional(),
    timeZone: searchTimeZoneSchema.optional(),
    cursor: cursorSchema.optional(),
    limit: positiveLimitSchema(searchPageLimitMax).optional(),
  })
  .superRefine((query, context) => {
    const needsZone =
      query.deadline === "due_today" || query.deadline === "overdue" || query.deadline === "range";
    if (needsZone && query.timeZone === undefined) {
      context.addIssue({ code: "custom", path: ["timeZone"], message: "Expected a time zone" });
    }
    if (!needsZone && query.timeZone !== undefined) {
      context.addIssue({ code: "custom", path: ["timeZone"], message: "Unexpected time zone" });
    }
    const isRange = query.deadline === "range";
    for (const field of ["deadlineFrom", "deadlineTo"] as const) {
      if (isRange && query[field] === undefined) {
        context.addIssue({ code: "custom", path: [field], message: "Expected a date" });
      }
      if (!isRange && query[field] !== undefined) {
        context.addIssue({ code: "custom", path: [field], message: "Unexpected date" });
      }
    }
    if (
      isRange &&
      query.deadlineFrom !== undefined &&
      query.deadlineTo !== undefined &&
      query.deadlineFrom > query.deadlineTo
    ) {
      context.addIssue({
        code: "custom",
        path: ["deadlineTo"],
        message: "The range ends before it starts",
      });
    }
  });

export type SearchRequestQuery = z.infer<typeof searchRequestQuerySchema>;

/** The deadline filter a validated request carries, or null. */
export function searchDeadlineFilterOf(query: SearchRequestQuery): SearchDeadlineFilter | null {
  switch (query.deadline) {
    case undefined:
      return null;
    case "has":
    case "none":
      return { kind: query.deadline };
    case "due_today":
    case "overdue":
      return { kind: query.deadline, timeZone: query.timeZone as string };
    case "range":
      return {
        kind: "range",
        from: query.deadlineFrom as string,
        to: query.deadlineTo as string,
        timeZone: query.timeZone as string,
      };
  }
}

/** `GET /v1/search/titles` query string: the command palette's quick title search. */
export const searchTitleQuerySchema = z.strictObject({
  q: searchQueryTextSchema,
  archive: searchArchiveModeSchema.optional(),
  limit: positiveLimitSchema(searchTitleLimitMax).optional(),
});

export type SearchTitleQuery = z.infer<typeof searchTitleQuerySchema>;

/* ------------------------------------------------------------------------------------------------
 * Responses
 * --------------------------------------------------------------------------------------------- */

/**
 * A matched range in a text, as UTF-16 offsets `[start, end)`. Clients render highlights as text
 * marks, never as HTML (note 14).
 */
export const searchHighlightSchema = z
  .strictObject({ start: counterSchema, end: counterSchema })
  .refine((range) => range.end > range.start, { error: "Empty highlight" });

export type SearchHighlight = z.infer<typeof searchHighlightSchema>;

const highlightsSchema = z.array(searchHighlightSchema).max(searchHighlightsMax);

/** A deterministic window of text around the first match, with whitespace collapsed. */
export const searchSnippetSchema = z.strictObject({
  text: z.string().max(searchSnippetMaxChars),
  highlights: highlightsSchema,
  /** Text precedes the window. */
  truncatedStart: z.boolean(),
  /** Text follows the window. */
  truncatedEnd: z.boolean(),
});

export type SearchSnippet = z.infer<typeof searchSnippetSchema>;

/** The task a result belongs to, re-read and re-authorized when the page was rendered (§10.1). */
export const searchTaskSummarySchema = z.strictObject({
  id: taskIdSchema,
  title: z.string().max(4096),
  titleHighlights: highlightsSchema,
  collection: searchCollectionSchema,
  archived: z.boolean(),
  /** The parent task, for the breadcrumb; null for top-level tasks. */
  parent: z.strictObject({ id: taskIdSchema, title: z.string().max(4096) }).nullable(),
  updatedAt: epochMillisSchema,
});

export type SearchTaskSummary = z.infer<typeof searchTaskSummarySchema>;

/** One matching document section. */
export const searchSectionHitSchema = z.strictObject({
  sectionId: searchSectionIdSchema,
  /** The section's position in the indexed revision, to resolve it against a newer head. */
  ordinal: counterSchema,
  heading: z.string().max(4096).nullable(),
  headingHighlights: highlightsSchema,
  match: z.enum(["heading", "body"]),
  snippet: searchSnippetSchema,
  /** The document revision the hit was indexed from. */
  indexedRevision: searchRevisionSchema,
  /** The current head revision when the page was rendered; null when no head is available. */
  currentRevision: searchRevisionSchema.nullable(),
  /** The head moved since indexing: refresh against the current revision before jumping. */
  stale: z.boolean(),
});

export type SearchSectionHit = z.infer<typeof searchSectionHitSchema>;

/** One matching chat message of the task's conversation (opt-in). */
export const searchMessageHitSchema = z.strictObject({
  messageId: messageIdSchema,
  conversationId: conversationIdSchema,
  speaker: z.enum(["user", "simon"]),
  createdAt: epochMillisSchema,
  snippet: searchSnippetSchema,
});

export type SearchMessageHit = z.infer<typeof searchMessageHitSchema>;

/** Every hit of one task, grouped so multiple section matches never become many task rows. */
export const searchResultGroupSchema = z.strictObject({
  task: searchTaskSummarySchema,
  /** The best match of the group, which decides its rank. */
  match: searchMatchKindSchema,
  /** False when the query fell back to results that match only some terms. */
  matchedAllTerms: z.boolean(),
  /** The title changed since it was indexed; the summary shows the current title. */
  titleStale: z.boolean(),
  sections: z.array(searchSectionHitSchema).max(searchHitsPerExpandedGroup),
  /** Every matching section of the task, including those not listed. */
  sectionCount: counterSchema,
  messages: z.array(searchMessageHitSchema).max(searchHitsPerExpandedGroup),
  messageCount: counterSchema,
});

export type SearchResultGroup = z.infer<typeof searchResultGroupSchema>;

/** The effective scope of a search, always shown with the results (note 14). */
export const searchScopeSchema = z.strictObject({
  collections: z.array(searchCollectionSchema).min(1).max(3),
  archive: searchArchiveModeSchema,
  types: z.array(searchContentTypeSchema).min(1).max(3),
  taskId: taskIdSchema.nullable(),
  deadline: searchDeadlineFilterSchema.nullable(),
});

export type SearchScope = z.infer<typeof searchScopeSchema>;

/** Index freshness reported with every response, separately from the results (§10.1). */
export const searchFreshnessSchema = z.strictObject({
  status: searchIndexStatusSchema,
  /** The published index generation results were served from (0 before the first publication). */
  indexGeneration: counterSchema,
  /** Committed changes not yet in the published generation. */
  pendingIntents: counterSchema,
});

export type SearchFreshness = z.infer<typeof searchFreshnessSchema>;

/** `GET /v1/search` response: one page of task groups and a cursor pinned to the index generation. */
export const searchResponseSchema = z.strictObject({
  ...searchFreshnessSchema.shape,
  scope: searchScopeSchema,
  notices: z.array(searchNoticeSchema).max(searchNotices.length),
  items: z.array(searchResultGroupSchema).max(searchPageLimitMax),
  nextCursor: cursorSchema.nullable(),
});

export type SearchResponse = z.infer<typeof searchResponseSchema>;

/** One quick title search result. */
export const searchTitleResultSchema = z.strictObject({
  task: searchTaskSummarySchema,
  match: searchTitleMatchKindSchema,
  titleStale: z.boolean(),
});

export type SearchTitleResult = z.infer<typeof searchTitleResultSchema>;

/** `GET /v1/search/titles` response. */
export const searchTitleResponseSchema = z.strictObject({
  ...searchFreshnessSchema.shape,
  items: z.array(searchTitleResultSchema).max(searchTitleLimitMax),
});

export type SearchTitleResponse = z.infer<typeof searchTitleResponseSchema>;

/** `GET /v1/search/freshness` response. */
export const searchFreshnessResponseSchema = searchFreshnessSchema;
