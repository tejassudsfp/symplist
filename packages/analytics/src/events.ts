import { z } from "zod";

/**
 * The analytics event allowlist (note 17, §15): explicit, versioned events emitted on confirmed
 * successful actions, each with a strict schema of enumerated properties. Free text, ids, titles,
 * queries, URLs and unknown properties are rejected. Every event has exactly one owner, the client
 * or the server, so no action is ever counted twice.
 */

const collection = z.enum(["now", "later", "unclassified"]);
const actor = z.enum(["user", "simon", "mcp"]);

const eventDefinitions = {
  task_created: {
    owner: "server",
    version: 1,
    properties: z.strictObject({
      source: z.enum(["user", "simon", "mcp", "quick_chat"]),
      collection,
      is_subtask: z.boolean(),
    }),
  },
  task_completed: {
    owner: "server",
    version: 1,
    properties: z.strictObject({
      collection,
      /** `single` when the task had no open subtasks; otherwise the P1 choice. */
      mode: z.enum(["single", "all", "parent_only"]),
    }),
  },
  task_moved: {
    owner: "server",
    version: 1,
    properties: z
      .strictObject({
        from_collection: collection,
        to_collection: collection,
        source: actor,
      })
      .refine((value) => value.from_collection !== value.to_collection, {
        message: "A move changes the collection",
      }),
  },
  search_used: {
    owner: "client",
    version: 1,
    properties: z.strictObject({
      surface: z.enum(["command_palette", "full_search", "collection", "document", "chat"]),
      include_archive: z.boolean(),
      include_chat: z.boolean(),
      result_count: z.enum(["0", "1-5", "6-20", "21+"]),
    }),
  },
  appearance_changed: {
    owner: "client",
    version: 1,
    properties: z.strictObject({
      changed: z.enum(["theme", "accent", "mode"]),
      theme: z.enum(["studio", "paper", "pebble", "postcard", "meadow", "tide"]),
      /** Whether the accent is a preset or custom; the custom color itself is never sent. */
      accent: z.enum(["preset", "custom"]),
      mode: z.enum(["light", "dark", "system"]),
    }),
  },
  reminder_created: {
    owner: "server",
    version: 1,
    properties: z.strictObject({
      channels: z.enum(["in_app", "email", "in_app_and_email"]),
      timing: z.enum(["at_deadline", "one_hour_before", "previous_day", "on_the_day", "custom"]),
      deadline: z.enum(["none", "date", "timed"]),
      source: actor,
    }),
  },
  handoff_prepared: {
    owner: "server",
    version: 1,
    properties: z.strictObject({
      target: z.enum(["coding_assistant", "general_assistant", "other"]),
      sections: z.enum(["whole_document", "selected_sections"]),
      author: z.enum(["user", "simon"]),
    }),
  },
  artifact_share_created: {
    owner: "server",
    version: 1,
    properties: z.strictObject({
      share_mode: z.enum(["link", "password", "public"]),
      expiry: z.enum(["1h", "24h", "7d", "custom", "until_revoked"]),
      origin: z.enum(["owner_ui", "simon_proposal"]),
    }),
  },
  quick_chat_started: {
    owner: "client",
    version: 1,
    properties: z.strictObject({
      entry: z.enum(["button", "shortcut", "command_palette"]),
    }),
  },
  quick_chat_saved: {
    owner: "server",
    version: 1,
    properties: z.strictObject({
      collection,
    }),
  },
} as const satisfies Record<
  string,
  {
    readonly owner: "client" | "server";
    readonly version: number;
    readonly properties: z.ZodType<Record<string, string | boolean>>;
  }
>;

export type AnalyticsEventName = keyof typeof eventDefinitions;
export type AnalyticsEventOwner = "client" | "server";

/** Properties of an allowlisted event, as its schema accepts them. */
export type AnalyticsEventProperties<Name extends AnalyticsEventName> = z.input<
  (typeof eventDefinitions)[Name]["properties"]
>;

export type ClientAnalyticsEventName = {
  [Name in AnalyticsEventName]: (typeof eventDefinitions)[Name]["owner"] extends "client"
    ? Name
    : never;
}[AnalyticsEventName];

export type ServerAnalyticsEventName = {
  [Name in AnalyticsEventName]: (typeof eventDefinitions)[Name]["owner"] extends "server"
    ? Name
    : never;
}[AnalyticsEventName];

export const analyticsEventNames = Object.keys(eventDefinitions) as AnalyticsEventName[];

/** The property every Symplist event carries with its schema version. */
export const eventVersionProperty = "event_version";

export function isAnalyticsEventName(name: string): name is AnalyticsEventName {
  return Object.hasOwn(eventDefinitions, name);
}

export function analyticsEventOwner(name: AnalyticsEventName): AnalyticsEventOwner {
  return eventDefinitions[name].owner;
}

export function analyticsEventVersion(name: AnalyticsEventName): number {
  return eventDefinitions[name].version;
}

export type AnalyticsValidationFailure = "unknown_event" | "wrong_owner" | "invalid_properties";

export type AnalyticsValidation =
  | {
      readonly ok: true;
      readonly event: AnalyticsEventName;
      /** The validated properties plus `event_version`. */
      readonly properties: Readonly<Record<string, string | boolean | number>>;
    }
  | { readonly ok: false; readonly reason: AnalyticsValidationFailure };

/**
 * Validates an event name and its properties against the allowlist for one owner. Unknown events,
 * events owned by the other side, unknown properties and free-text values all fail.
 */
export function validateAnalyticsEvent(
  owner: AnalyticsEventOwner,
  name: string,
  properties: unknown,
): AnalyticsValidation {
  if (!isAnalyticsEventName(name)) return { ok: false, reason: "unknown_event" };
  const definition = eventDefinitions[name];
  if (definition.owner !== owner) return { ok: false, reason: "wrong_owner" };
  const parsed = definition.properties.safeParse(properties);
  if (!parsed.success) return { ok: false, reason: "invalid_properties" };
  return {
    ok: true,
    event: name,
    properties: { ...parsed.data, [eventVersionProperty]: definition.version },
  };
}
