/**
 * REST request and response schemas owned by the workspace feature (§2.1 and §10.3).
 * Export Zod schemas with a `workspace`-specific name so the contracts index stays collision free.
 */

import { taskIdSchema } from "../common/ids.ts";
import { cursorSchema, pageLimitSchema } from "../common/pagination.ts";
import { counterSchema, epochMillisSchema, stableCodePattern } from "../common/primitives.ts";
import { z } from "../common/zod.ts";

/* ------------------------------------------------------------------------------------------------
 * Collections, sources and limits (§2.1)
 * --------------------------------------------------------------------------------------------- */

/** The three workspace collections, in rail order. Archived tasks keep their collection. */
export const taskCollections = ["now", "later", "unclassified"] as const;
export const taskCollectionSchema = z.enum(taskCollections);
export type TaskCollection = z.infer<typeof taskCollectionSchema>;

export const taskStatuses = ["active", "archived"] as const;
export const taskStatusSchema = z.enum(taskStatuses);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/**
 * Who created a task, as the UI shows it ("Added by connected agent"). The stored source also names
 * the MCP grant (`mcp:<grantId>`), which responses never expose.
 */
export const taskSourceKinds = ["user", "simon", "mcp"] as const;
export const taskSourceKindSchema = z.enum(taskSourceKinds);
export type TaskSourceKind = z.infer<typeof taskSourceKindSchema>;

/** The longest task title, in UTF-16 code units after trimming. */
export const TASK_TITLE_MAX_LENGTH = 500;

/** The longest stored task preview (an optional short excerpt of the task page). */
export const TASK_PREVIEW_MAX_LENGTH = 160;

/**
 * Tasks nest at most this many levels: a top-level task has depth 0 and the deepest subtask depth
 * `TASK_MAX_DEPTH - 1`. Moves and restores that would exceed it are refused (`task.depth_limit`).
 */
export const TASK_MAX_DEPTH = 32;

/** The longest fractional index key accepted in a response (the column allows 512). */
export const TASK_POSITION_MAX_LENGTH = 512;

/** At most this many task ids travel in one `tasks.changed` event; larger changes send none. */
export const TASKS_CHANGED_MAX_IDS = 200;

/** Control, line and paragraph separator characters are never allowed in a title. */
const titleForbidden = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * A task title as submitted: trimmed, 1 to 500 characters, one line. Only a title is needed to
 * create a task (note 01).
 */
export const taskTitleInputSchema = z
  .string({ error: "Expected a title" })
  .trim()
  .min(1, { error: "A title is required" })
  .max(TASK_TITLE_MAX_LENGTH, { error: `At most ${TASK_TITLE_MAX_LENGTH} characters` })
  .refine((value) => !titleForbidden.test(value), { error: "A title is one line of text" });

/** A fractional index key (§3.4): base-62 digits after an integer head. */
export const taskPositionSchema = z
  .string()
  .min(1)
  .max(TASK_POSITION_MAX_LENGTH)
  .regex(/^[A-Za-z][0-9A-Za-z]*$/, { error: "Expected a fractional index key" });

/* ------------------------------------------------------------------------------------------------
 * Task tree (GET /v1/tasks?collection=…)
 * --------------------------------------------------------------------------------------------- */

/** One active task in a collection tree, in pre-order with its depth. */
export const taskNodeSchema = z.strictObject({
  id: taskIdSchema,
  parentId: taskIdSchema.nullable(),
  collection: taskCollectionSchema,
  position: taskPositionSchema,
  depth: z
    .number()
    .int()
    .min(0)
    .max(TASK_MAX_DEPTH - 1),
  title: z.string().max(TASK_TITLE_MAX_LENGTH),
  preview: z.string().max(TASK_PREVIEW_MAX_LENGTH).nullable(),
  source: taskSourceKindSchema,
  /** Increments whenever the task's title, place or status changes. */
  version: counterSchema.min(1),
  /** Active direct subtasks. */
  childCount: counterSchema,
  createdAt: epochMillisSchema,
  updatedAt: epochMillisSchema,
});
export type TaskNode = z.infer<typeof taskNodeSchema>;

/**
 * Nodes one `GET /v1/tasks` page carries. A collection has no natural bound, so a page has to have
 * one (§3 D1 budget) — but the owner's tree is read and cached whole, so every page after the first
 * is served from that one read and the window can be far wider than a general list page.
 */
export const TASK_TREE_PAGE_LIMIT = 500;

export const taskTreePageLimitSchema = z
  .union([
    z.number({ error: "Expected a page limit" }),
    z
      .string({ error: "Expected a page limit" })
      .regex(/^[1-9][0-9]{0,3}$/, { error: "Expected a page limit" })
      .transform(Number),
  ])
  .pipe(
    z
      .number()
      .int({ error: "Expected a whole page limit" })
      .min(1, { error: `Expected a page limit between 1 and ${TASK_TREE_PAGE_LIMIT}` })
      .max(TASK_TREE_PAGE_LIMIT, {
        error: `Expected a page limit between 1 and ${TASK_TREE_PAGE_LIMIT}`,
      }),
  );

export const taskTreeQuerySchema = z.strictObject({
  collection: taskCollectionSchema,
  cursor: cursorSchema.optional(),
  limit: taskTreePageLimitSchema.optional(),
});
export type TaskTreeQuery = z.infer<typeof taskTreeQuerySchema>;

export const taskTreeResponseSchema = z.strictObject({
  collection: taskCollectionSchema,
  /** The owner's tree version; `tasks.changed` and the user snapshot carry the same counter. */
  taskTreeVersion: counterSchema,
  /** Top-level tasks by position, each followed by its subtasks (pre-order). */
  tasks: z.array(taskNodeSchema),
  /**
   * The next page of the same pre-order walk, or null on the last page. A cursor is only meaningful
   * against the `taskTreeVersion` it came with: a client whose next page reports a different version
   * has been reading a tree that moved under it and starts the collection again.
   */
  nextCursor: cursorSchema.nullable(),
});
export type TaskTreeResponse = z.infer<typeof taskTreeResponseSchema>;

/* ------------------------------------------------------------------------------------------------
 * One task (GET /v1/tasks/:id)
 * --------------------------------------------------------------------------------------------- */

export const taskDetailSchema = z.strictObject({
  id: taskIdSchema,
  parentId: taskIdSchema.nullable(),
  collection: taskCollectionSchema,
  position: taskPositionSchema,
  status: taskStatusSchema,
  title: z.string().max(TASK_TITLE_MAX_LENGTH),
  preview: z.string().max(TASK_PREVIEW_MAX_LENGTH).nullable(),
  source: taskSourceKindSchema,
  version: counterSchema.min(1),
  childCount: counterSchema,
  archivedAt: epochMillisSchema.nullable(),
  /** The task whose completion archived this one, while archived. */
  archivedWithRootId: taskIdSchema.nullable(),
  createdAt: epochMillisSchema,
  updatedAt: epochMillisSchema,
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;

/** A breadcrumb entry, root first. */
export const taskAncestorSchema = z.strictObject({
  id: taskIdSchema,
  title: z.string().max(TASK_TITLE_MAX_LENGTH),
  status: taskStatusSchema,
});
export type TaskAncestor = z.infer<typeof taskAncestorSchema>;

export const taskDetailResponseSchema = z.strictObject({
  task: taskDetailSchema,
  ancestors: z.array(taskAncestorSchema).max(TASK_MAX_DEPTH),
});
export type TaskDetailResponse = z.infer<typeof taskDetailResponseSchema>;

/* ------------------------------------------------------------------------------------------------
 * Create (POST /v1/tasks, idempotent)
 * --------------------------------------------------------------------------------------------- */

export const taskPlacements = ["start", "end"] as const;
export const taskPlacementSchema = z.enum(taskPlacements);
export type TaskPlacement = z.infer<typeof taskPlacementSchema>;

/**
 * Creates a task from a title alone: inline in a collection, or as a subtask under `parentId`
 * (which inherits the parent's collection). It lands at the end of its list unless `placement` is
 * `start` or `afterId` names the sibling it follows.
 */
export const taskCreateRequestSchema = z
  .strictObject({
    title: taskTitleInputSchema,
    collection: taskCollectionSchema.optional(),
    parentId: taskIdSchema.optional(),
    afterId: taskIdSchema.optional(),
    placement: taskPlacementSchema.optional(),
  })
  .refine((value) => value.collection !== undefined || value.parentId !== undefined, {
    error: "A collection or a parent task is required",
    path: ["collection"],
  })
  .refine((value) => value.afterId === undefined || value.placement === undefined, {
    error: "Use afterId or placement, not both",
    path: ["placement"],
  });
export type TaskCreateRequest = z.infer<typeof taskCreateRequestSchema>;

export const taskCreateResponseSchema = z.strictObject({ task: taskNodeSchema });
export type TaskCreateResponse = z.infer<typeof taskCreateResponseSchema>;

/* ------------------------------------------------------------------------------------------------
 * Rename (PATCH /v1/tasks/:id, idempotent)
 * --------------------------------------------------------------------------------------------- */

export const taskRenameRequestSchema = z.strictObject({ title: taskTitleInputSchema });
export type TaskRenameRequest = z.infer<typeof taskRenameRequestSchema>;

export const taskRenameResponseSchema = z.strictObject({
  taskId: taskIdSchema,
  title: z.string().max(TASK_TITLE_MAX_LENGTH),
  version: counterSchema.min(1),
});
export type TaskRenameResponse = z.infer<typeof taskRenameResponseSchema>;

/* ------------------------------------------------------------------------------------------------
 * Move and reorder (POST /v1/tasks/:id/move, idempotent)
 * --------------------------------------------------------------------------------------------- */

/**
 * Moves a task and its subtasks. `parentId` nests it under another active task (`null` makes it top
 * level); `collection` alone moves it to that collection, and a subtask moved to another collection
 * becomes top level there (decision P3). `afterId` and `beforeId` name its new neighbours; without
 * them it goes to the end of its new list. Reordering is a move within the same list.
 */
export const taskMoveRequestSchema = z
  .strictObject({
    collection: taskCollectionSchema.optional(),
    parentId: taskIdSchema.nullable().optional(),
    afterId: taskIdSchema.optional(),
    beforeId: taskIdSchema.optional(),
  })
  .refine(
    (value) =>
      value.collection !== undefined ||
      value.parentId !== undefined ||
      value.afterId !== undefined ||
      value.beforeId !== undefined,
    { error: "Say where the task moves", path: ["collection"] },
  )
  .refine(
    (value) =>
      value.afterId === undefined ||
      value.beforeId === undefined ||
      value.afterId !== value.beforeId,
    { error: "A task cannot sit both before and after the same task", path: ["beforeId"] },
  );
export type TaskMoveRequest = z.infer<typeof taskMoveRequestSchema>;

/** Where a task sat, so a client can offer Undo by moving it back. */
export const taskPlacementRecordSchema = z.strictObject({
  collection: taskCollectionSchema,
  parentId: taskIdSchema.nullable(),
  /** The sibling it followed, or null when it was first. */
  afterId: taskIdSchema.nullable(),
});
export type TaskPlacementRecord = z.infer<typeof taskPlacementRecordSchema>;

export const taskMoveResponseSchema = z.strictObject({
  taskId: taskIdSchema,
  collection: taskCollectionSchema,
  parentId: taskIdSchema.nullable(),
  position: taskPositionSchema,
  /** The task and every subtask that moved with it. */
  movedTaskIds: z.array(taskIdSchema).min(1),
  previous: taskPlacementRecordSchema,
});
export type TaskMoveResponse = z.infer<typeof taskMoveResponseSchema>;

/* ------------------------------------------------------------------------------------------------
 * Complete (POST /v1/tasks/:id/complete, idempotent) and restore (POST /v1/tasks/:id/restore)
 * --------------------------------------------------------------------------------------------- */

export const taskCompleteModes = ["all", "parent_only"] as const;
export const taskCompleteModeSchema = z.enum(taskCompleteModes);
export type TaskCompleteMode = z.infer<typeof taskCompleteModeSchema>;

/**
 * Archives a task (§2.1). With open subtasks, `all` archives them too and `parent_only` makes them
 * top-level tasks in the parent's collection (decisions P1, P3). While the task's conversation has an
 * active run, `stopRun: false` is refused with `task.run_active`; `true` stops the run first.
 */
export const taskCompleteRequestSchema = z.strictObject({
  mode: taskCompleteModeSchema,
  stopRun: z.boolean(),
});
export type TaskCompleteRequest = z.infer<typeof taskCompleteRequestSchema>;

export const taskCompleteResponseSchema = z.strictObject({
  taskId: taskIdSchema,
  /** `single` when the task had no open subtasks. */
  mode: z.enum(["single", "all", "parent_only"]),
  archivedTaskIds: z.array(taskIdSchema).min(1),
  promotedTaskIds: z.array(taskIdSchema),
  archivedAt: epochMillisSchema,
});
export type TaskCompleteResponse = z.infer<typeof taskCompleteResponseSchema>;

/**
 * Why a restored task did not return exactly where it was (decision P2): its parent is still
 * archived (it becomes top level), or its collection no longer exists (it goes to Now).
 */
export const taskRestoreFallbacks = [
  "none",
  "parent_unavailable",
  "collection_unavailable",
] as const;
export const taskRestoreFallbackSchema = z.enum(taskRestoreFallbacks);
export type TaskRestoreFallback = z.infer<typeof taskRestoreFallbackSchema>;

export const taskRestoreResponseSchema = z.strictObject({
  taskId: taskIdSchema,
  /** Every task restored: the task and its subtasks archived with it. Empty when it was active. */
  restoredTaskIds: z.array(taskIdSchema),
  collection: taskCollectionSchema,
  parentId: taskIdSchema.nullable(),
  position: taskPositionSchema,
  fallback: taskRestoreFallbackSchema,
});
export type TaskRestoreResponse = z.infer<typeof taskRestoreResponseSchema>;

/* ------------------------------------------------------------------------------------------------
 * Archive (GET /v1/archive)
 * --------------------------------------------------------------------------------------------- */

/** An IANA time zone name, validated again by the server before use. */
export const workspaceTimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_+\-/]*$/, { error: "Expected an IANA time zone" });

export const ARCHIVE_SEARCH_MAX_LENGTH = 200;

export const archiveQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: pageLimitSchema.optional(),
  /** Filters archived groups whose task or subtask titles contain this text. */
  q: z.string().trim().min(1).max(ARCHIVE_SEARCH_MAX_LENGTH).optional(),
  /** Groups by completion date in this zone; defaults to UTC. */
  timeZone: workspaceTimeZoneSchema.optional(),
});
export type ArchiveQuery = z.infer<typeof archiveQuerySchema>;

export const archivedTaskNodeSchema = z.strictObject({
  id: taskIdSchema,
  parentId: taskIdSchema.nullable(),
  /** The completed task this one was archived with (itself for the completed task). */
  rootId: taskIdSchema,
  /** The collection it was in, where Restore returns it. */
  collection: taskCollectionSchema,
  /** Depth within its archived group: 0 for the completed task. */
  depth: z
    .number()
    .int()
    .min(0)
    .max(TASK_MAX_DEPTH - 1),
  title: z.string().max(TASK_TITLE_MAX_LENGTH),
  preview: z.string().max(TASK_PREVIEW_MAX_LENGTH).nullable(),
  source: taskSourceKindSchema,
  archivedAt: epochMillisSchema,
  createdAt: epochMillisSchema,
});
export type ArchivedTaskNode = z.infer<typeof archivedTaskNodeSchema>;

export const archiveGroupSchema = z.strictObject({
  /** The local completion date, `YYYY-MM-DD`. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Completed tasks newest first, each followed by the subtasks archived with it (pre-order). */
  tasks: z.array(archivedTaskNodeSchema).min(1),
});
export type ArchiveGroup = z.infer<typeof archiveGroupSchema>;

export const archiveResponseSchema = z.strictObject({
  taskTreeVersion: counterSchema,
  timeZone: workspaceTimeZoneSchema,
  groups: z.array(archiveGroupSchema),
  /**
   * Continues the listing. A search scans a bounded number of completed tasks per page, so a page
   * can have fewer groups than `limit` while `nextCursor` is still set.
   */
  nextCursor: cursorSchema.nullable(),
});
export type ArchiveResponse = z.infer<typeof archiveResponseSchema>;

/* ------------------------------------------------------------------------------------------------
 * Preferences (§10.3)
 * --------------------------------------------------------------------------------------------- */

/** Versioned preference groups, each one encrypted row (§10.3). */
export const preferenceGroups = [
  "appearance",
  "keyboard",
  "chat",
  "recent",
  "panels",
  "privacy",
] as const;
export const preferenceGroupSchema = z.enum(preferenceGroups);
export type PreferenceGroup = z.infer<typeof preferenceGroupSchema>;

/** Named accent presets (note 02); a custom accent is an upper-case `#RRGGBB` seed. */
export const appearanceAccentPresets = [
  "blue",
  "violet",
  "rose",
  "coral",
  "amber",
  "green",
  "teal",
  "graphite",
] as const;

/**
 * Theme, brightness and accent (note 02). The theme id is a slug rather than a closed list, so a
 * removed theme is stored unchanged and the client falls back to the default theme while keeping the
 * accent and mode.
 */
export const appearancePreferencesSchema = z.strictObject({
  themeId: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, { error: "Expected a theme id" }),
  mode: z.enum(["light", "dark", "system"]),
  accent: z.union([
    z.enum(appearanceAccentPresets),
    z.string().regex(/^#[0-9A-F]{6}$/, { error: "Expected a preset or #RRGGBB" }),
  ]),
});
export type AppearancePreferences = z.infer<typeof appearancePreferencesSchema>;

/** The most remapped actions one account stores. */
export const KEYBOARD_OVERRIDES_MAX = 200;

/** Shortcut remaps (`null` unbinds an action) and the Disable single-key shortcuts toggle (note 13). */
export const keyboardPreferencesSchema = z.strictObject({
  overrides: z
    .record(
      z.string().max(100).regex(stableCodePattern, { error: "Expected an action id" }),
      z
        .string()
        .min(1)
        .max(64)
        .regex(/^[\x20-\x7e]+$/, { error: "Expected a binding" })
        .nullable(),
    )
    .refine((overrides) => Object.keys(overrides).length <= KEYBOARD_OVERRIDES_MAX, {
      error: `At most ${KEYBOARD_OVERRIDES_MAX} remapped actions`,
    }),
  singleKeyShortcuts: z.boolean(),
});
export type KeyboardPreferences = z.infer<typeof keyboardPreferencesSchema>;

/** Enter-to-send and the default Fast/Smart tier (`null` uses the operator default). */
export const chatPreferencesSchema = z.strictObject({
  enterToSend: z.boolean(),
  defaultTier: z.enum(["fast", "smart"]).nullable(),
});
export type ChatPreferences = z.infer<typeof chatPreferencesSchema>;

export const RECENT_TASKS_MAX = 20;

/** Recently opened task ids, newest first (note 14: an explicit account preference). */
export const recentPreferencesSchema = z.strictObject({
  taskIds: z
    .array(taskIdSchema)
    .max(RECENT_TASKS_MAX)
    .refine((ids) => new Set(ids).size === ids.length, { error: "Task ids must be unique" }),
});
export type RecentPreferences = z.infer<typeof recentPreferencesSchema>;

/** Collapsed state and widths (CSS pixels) of the inbox and chat panels; `null` uses the default. */
export const panelsPreferencesSchema = z.strictObject({
  inboxCollapsed: z.boolean(),
  chatCollapsed: z.boolean(),
  inboxWidth: z.number().int().min(200).max(640).nullable(),
  chatWidth: z.number().int().min(280).max(960).nullable(),
});
export type PanelsPreferences = z.infer<typeof panelsPreferencesSchema>;

/** Whether chat messages enter the owner's search index (§10.1); off until the owner opts in. */
export const privacyPreferencesSchema = z.strictObject({
  includeChatInSearch: z.boolean(),
});
export type PrivacyPreferences = z.infer<typeof privacyPreferencesSchema>;

/** The data schema of each group. */
export const preferenceDataSchemas = Object.freeze({
  appearance: appearancePreferencesSchema,
  keyboard: keyboardPreferencesSchema,
  chat: chatPreferencesSchema,
  recent: recentPreferencesSchema,
  panels: panelsPreferencesSchema,
  privacy: privacyPreferencesSchema,
} as const satisfies Record<PreferenceGroup, z.ZodType>);

export interface PreferenceDataByGroup {
  appearance: AppearancePreferences;
  keyboard: KeyboardPreferences;
  chat: ChatPreferences;
  recent: RecentPreferences;
  panels: PanelsPreferences;
  privacy: PrivacyPreferences;
}

/** What a group holds before the owner saves it (version 0). New accounts get Studio, System, Blue. */
export const preferenceDefaults: {
  readonly [Group in PreferenceGroup]: PreferenceDataByGroup[Group];
} = Object.freeze({
  appearance: Object.freeze({ themeId: "studio", mode: "system", accent: "blue" }),
  keyboard: Object.freeze({ overrides: Object.freeze({}), singleKeyShortcuts: true }),
  chat: Object.freeze({ enterToSend: false, defaultTier: null }),
  recent: Object.freeze({ taskIds: Object.freeze([]) as unknown as string[] }),
  panels: Object.freeze({
    inboxCollapsed: false,
    chatCollapsed: false,
    inboxWidth: null,
    chatWidth: null,
  }),
  privacy: Object.freeze({ includeChatInSearch: false }),
}) as { readonly [Group in PreferenceGroup]: PreferenceDataByGroup[Group] };

function preferenceEntrySchemaFor<Data extends z.ZodType>(group: PreferenceGroup, data: Data) {
  return z.strictObject({
    group: z.literal(group),
    /** 0 until the owner first saves the group. */
    version: counterSchema,
    data,
    updatedAt: epochMillisSchema.nullable(),
  });
}

export const preferenceEntrySchemas = Object.freeze({
  appearance: preferenceEntrySchemaFor("appearance", appearancePreferencesSchema),
  keyboard: preferenceEntrySchemaFor("keyboard", keyboardPreferencesSchema),
  chat: preferenceEntrySchemaFor("chat", chatPreferencesSchema),
  recent: preferenceEntrySchemaFor("recent", recentPreferencesSchema),
  panels: preferenceEntrySchemaFor("panels", panelsPreferencesSchema),
  privacy: preferenceEntrySchemaFor("privacy", privacyPreferencesSchema),
});

/** Any group's entry. */
export const preferenceEntrySchema = z.discriminatedUnion("group", [
  preferenceEntrySchemas.appearance,
  preferenceEntrySchemas.keyboard,
  preferenceEntrySchemas.chat,
  preferenceEntrySchemas.recent,
  preferenceEntrySchemas.panels,
  preferenceEntrySchemas.privacy,
]);
export type PreferenceEntry = z.infer<typeof preferenceEntrySchema>;

/** `GET /v1/preferences`: every group, saved or default. */
export const preferencesResponseSchema = z.strictObject({
  groups: z.strictObject(preferenceEntrySchemas),
});
export type PreferencesResponse = z.infer<typeof preferencesResponseSchema>;

/**
 * `PUT /v1/preferences/:group`. The save applies only when `baseVersion` is the stored version (0
 * for a group never saved). `clientSeq` is echoed so the client can drop responses older than its
 * latest request.
 */
export const preferencesPutRequestSchema = z.strictObject({
  baseVersion: counterSchema,
  clientSeq: counterSchema,
  data: z.unknown(),
});
export type PreferencesPutRequest = z.infer<typeof preferencesPutRequestSchema>;

/** The saved group, and the body of `preferences.conflict` details with the current state. */
export const preferencesPutResponseSchema = z.strictObject({
  group: preferenceGroupSchema,
  version: counterSchema,
  data: z.unknown(),
  updatedAt: epochMillisSchema.nullable(),
  clientSeq: counterSchema,
});
export type PreferencesPutResponse = z.infer<typeof preferencesPutResponseSchema>;

/** `preferences.conflict` (409) details: the current version and data of the group. */
export const preferencesConflictDetailsSchema = preferencesPutResponseSchema;
export type PreferencesConflictDetails = PreferencesPutResponse;
