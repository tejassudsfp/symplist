import { analyticsConsentSchema } from "../common/consent.ts";
import { z } from "../common/zod.ts";

/** Deliberately contains no analytics identity (R9). */
export const analyticsSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  consent: analyticsConsentSchema,
});
export type AnalyticsSettings = z.infer<typeof analyticsSettingsSchema>;
export const analyticsConsentRequestSchema = z.strictObject({
  state: z.enum(["granted", "denied"]),
});
export type AnalyticsConsentRequest = z.infer<typeof analyticsConsentRequestSchema>;

/** Browser-owned events travel to the first-party relay, never with an analytics identity. */
export const analyticsTrackRequestSchema = z.discriminatedUnion("event", [
  z.strictObject({
    event: z.literal("search_used"),
    eventId: z.uuid(),
    properties: z.strictObject({
      surface: z.enum(["command_palette", "full_search", "collection", "document", "chat"]),
      include_archive: z.boolean(),
      include_chat: z.boolean(),
      result_count: z.enum(["0", "1-5", "6-20", "21+"]),
    }),
  }),
  z.strictObject({
    event: z.literal("appearance_changed"),
    eventId: z.uuid(),
    properties: z.strictObject({
      changed: z.enum(["theme", "accent", "mode"]),
      theme: z.enum(["studio", "paper", "pebble", "postcard", "meadow", "tide"]),
      accent: z.enum(["preset", "custom"]),
      mode: z.enum(["light", "dark", "system"]),
    }),
  }),
  z.strictObject({
    event: z.literal("quick_chat_started"),
    eventId: z.uuid(),
    properties: z.strictObject({ entry: z.enum(["button", "shortcut", "command_palette"]) }),
  }),
]);
export type AnalyticsTrackRequest = z.infer<typeof analyticsTrackRequestSchema>;
