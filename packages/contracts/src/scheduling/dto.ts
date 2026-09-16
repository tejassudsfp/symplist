/**
 * REST request and response schemas owned by the scheduling feature (§12).
 * Export Zod schemas with a `scheduling`-specific name so the contracts index stays collision free.
 */
import { z } from "../common/zod.ts";

export const schedulingZoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, "Choose an IANA timezone");
export const schedulingDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const schedulingLocalSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
export const schedulingDisambiguationSchema = z.enum(["reject", "earlier", "later"]);
export const schedulingDeadlineSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("date"), date: schedulingDateSchema, zone: schedulingZoneSchema })
    .strict(),
  z
    .object({
      kind: z.literal("timed"),
      local: schedulingLocalSchema,
      zone: schedulingZoneSchema,
      disambiguation: schedulingDisambiguationSchema.default("reject"),
    })
    .strict(),
]);
export const schedulingRuleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("absolute"),
      local: schedulingLocalSchema,
      zone: schedulingZoneSchema,
      disambiguation: schedulingDisambiguationSchema.default("reject"),
    })
    .strict(),
  z
    .object({ kind: z.literal("elapsed"), minutesBefore: z.number().int().min(0).max(525600) })
    .strict(),
  z
    .object({
      kind: z.literal("calendar"),
      daysBefore: z.number().int().min(0).max(366),
      hour: z.number().int().min(0).max(23),
    })
    .strict(),
]);
export const schedulingChannelsSchema = z
  .array(z.enum(["in_app", "email"]))
  .min(1)
  .max(2)
  .refine((v) => new Set(v).size === v.length);
export const schedulingReminderInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    rule: schedulingRuleSchema,
    channels: schedulingChannelsSchema,
    overrideQuiet: z.boolean().default(false),
  })
  .strict();
export const schedulingSaveSchema = z
  .object({
    baseVersion: z.number().int().min(0),
    deadline: schedulingDeadlineSchema.nullable(),
    reminders: z.array(schedulingReminderInputSchema).max(20),
  })
  .strict()
  .refine((value) => {
    const ids = value.reminders.flatMap((reminder) => (reminder.id ? [reminder.id] : []));
    return new Set(ids).size === ids.length;
  }, "A reminder can appear only once in a schedule");
export const schedulingPrefsDataSchema = z
  .object({
    zone: schedulingZoneSchema,
    defaultHour: z.number().int().min(0).max(23),
    inApp: z.boolean(),
    email: z.boolean(),
    quietEnabled: z.boolean(),
    quietStart: z.number().int().min(0).max(23),
    quietEnd: z.number().int().min(0).max(23),
    emailPreview: z.boolean(),
  })
  .strict()
  .refine(
    (v) => !v.quietEnabled || v.quietStart !== v.quietEnd,
    "Quiet hours need different start and end hours",
  );
export const schedulingPrefsSaveSchema = z
  .object({ baseVersion: z.number().int().min(0), data: schedulingPrefsDataSchema })
  .strict();
export const schedulingSnoozeSchema = z
  .object({
    local: schedulingLocalSchema,
    zone: schedulingZoneSchema,
    disambiguation: schedulingDisambiguationSchema.default("reject"),
  })
  .strict();
export type SchedulingDeadline = z.infer<typeof schedulingDeadlineSchema>;
export type SchedulingRule = z.infer<typeof schedulingRuleSchema>;
export type SchedulingReminderInput = z.infer<typeof schedulingReminderInputSchema>;
export type SchedulingSave = z.infer<typeof schedulingSaveSchema>;
export type SchedulingPreferences = z.infer<typeof schedulingPrefsDataSchema>;
export interface SchedulingReminder extends SchedulingReminderInput {
  readonly id: string;
  readonly intendedAt: number;
  readonly emailAt: number;
  readonly crossesDeadline: boolean;
}
export interface SchedulingSnapshot {
  readonly taskId: string;
  readonly version: number;
  readonly deadline: SchedulingDeadline | null;
  readonly deadlineAt: number | null;
  readonly reminders: readonly SchedulingReminder[];
}
export interface SchedulingNotification {
  readonly id: string;
  readonly taskId: string;
  readonly title: string;
  readonly intendedAt: number;
  readonly createdAt: number;
  readonly quiet: boolean;
  readonly late: boolean;
  readonly kind: "reminder" | "missed";
  readonly count: number;
  readonly readAt: number | null;
  readonly taskActive: boolean;
  readonly deadline?: SchedulingDeadline | null;
}
export const schedulingDefaultPreferences: SchedulingPreferences = {
  zone: "UTC",
  defaultHour: 9,
  inApp: true,
  email: false,
  quietEnabled: true,
  quietStart: 22,
  quietEnd: 8,
  emailPreview: false,
};
export const schedulingListQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
  })
  .strict();
export const schedulingCalendarQuerySchema = z
  .object({
    from: schedulingDateSchema,
    to: schedulingDateSchema,
    zone: schedulingZoneSchema,
    collection: z.enum(["all", "now", "later", "unclassified"]).default("all"),
    archived: z.enum(["true", "false"]).default("false"),
    cursor: z.string().uuid().optional(),
    unscheduled: z.enum(["true", "false"]).default("false"),
  })
  .strict();
export interface SchedulingCalendarItem {
  readonly taskId: string;
  readonly title: string;
  readonly collection: "now" | "later" | "unclassified";
  readonly archived: boolean;
  readonly deadline: SchedulingDeadline | null;
  readonly deadlineAt: number | null;
  readonly version: number;
}
export const schedulingReminderSchema = schedulingReminderInputSchema.extend({
  id: z.string().uuid(),
  intendedAt: z.number().int(),
  emailAt: z.number().int(),
  crossesDeadline: z.boolean(),
});
export const schedulingSnapshotSchema = z
  .object({
    taskId: z.string().uuid(),
    version: z.number().int().nonnegative(),
    deadline: schedulingDeadlineSchema.nullable(),
    deadlineAt: z.number().int().nullable(),
    reminders: z.array(schedulingReminderSchema).max(20),
  })
  .strict();
export const schedulingPreviewSchema = z
  .object({
    deadlineAt: z.number().int().nullable(),
    reminders: z
      .array(
        schedulingReminderInputSchema.extend({
          intendedAt: z.number().int(),
          emailAt: z.number().int(),
          crossesDeadline: z.boolean(),
        }),
      )
      .max(20),
  })
  .strict();
export const schedulingPreferencesResponseSchema = z
  .object({
    version: z.number().int().nonnegative(),
    data: schedulingPrefsDataSchema,
    remindersEnabled: z.boolean(),
    emailEnabled: z.boolean(),
    deliveryTracking: z.boolean().optional(),
    addressSuppressed: z.boolean().optional(),
  })
  .strict();
export const schedulingNotificationSchema = z
  .object({
    id: z.string().uuid(),
    taskId: z.string().uuid(),
    title: z.string(),
    intendedAt: z.number().int(),
    createdAt: z.number().int(),
    quiet: z.boolean(),
    late: z.boolean(),
    kind: z.enum(["reminder", "missed"]),
    count: z.number().int().positive(),
    readAt: z.number().int().nullable(),
    taskActive: z.boolean(),
    deadline: schedulingDeadlineSchema.nullable().optional(),
  })
  .strict();
export const schedulingNotificationsResponseSchema = z
  .object({
    items: z.array(schedulingNotificationSchema).max(50),
    unreadCount: z.number().int().nonnegative(),
    nextCursor: z.string().uuid().nullable(),
  })
  .strict();
export const schedulingCalendarResponseSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            taskId: z.string().uuid(),
            title: z.string(),
            collection: z.enum(["now", "later", "unclassified"]),
            archived: z.boolean(),
            deadline: schedulingDeadlineSchema.nullable(),
            deadlineAt: z.number().int().nullable(),
            version: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(200),
    nextCursor: z.string().uuid().nullable(),
  })
  .strict();
export const schedulingSummaryQuerySchema = z
  .object({
    ids: z
      .string()
      .transform((value) => value.split(","))
      .pipe(z.array(z.string().uuid()).min(1).max(50)),
  })
  .strict();
export const schedulingSummaryResponseSchema = z
  .array(schedulingSnapshotSchema.omit({ reminders: true }))
  .max(50);
