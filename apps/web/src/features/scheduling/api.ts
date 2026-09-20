import {
  type SchedulingPreferences,
  type SchedulingSave,
  type schedulingCalendarQuerySchema,
  schedulingCalendarResponseSchema,
  schedulingNotificationsResponseSchema,
  schedulingPreferencesResponseSchema,
  schedulingPreviewSchema,
  schedulingSnapshotSchema,
  type schedulingSnoozeSchema,
  schedulingSummaryResponseSchema,
} from "@symplist/contracts";
import { type ApiClient, getApiClient } from "@/lib/api";

export function createSchedulingApi(client: () => ApiClient = getApiClient) {
  return {
    get: (taskId: string) =>
      client().get(`/v1/tasks/${encodeURIComponent(taskId)}/schedule`, {
        schema: schedulingSnapshotSchema,
      }),
    summaries: (ids: readonly string[]) =>
      client().get("/v1/schedule-summaries", {
        query: { ids: ids.join(",") },
        schema: schedulingSummaryResponseSchema,
      }),
    save: (taskId: string, body: SchedulingSave, idempotencyKey: string) =>
      client().put(`/v1/tasks/${encodeURIComponent(taskId)}/schedule`, {
        body,
        idempotencyKey,
        schema: schedulingSnapshotSchema,
      }),
    preview: (body: SchedulingSave) =>
      client().post("/v1/schedules/preview", { body, schema: schedulingPreviewSchema }),
    preferences: () =>
      client().get("/v1/notification-preferences", { schema: schedulingPreferencesResponseSchema }),
    savePreferences: (baseVersion: number, data: SchedulingPreferences, idempotencyKey: string) =>
      client().put("/v1/notification-preferences", {
        body: { baseVersion, data },
        idempotencyKey,
        schema: schedulingPreferencesResponseSchema,
      }),
    notifications: (cursor?: string) =>
      client().get("/v1/notifications", {
        ...(cursor ? { query: { cursor } } : {}),
        schema: schedulingNotificationsResponseSchema,
      }),
    mark: (id: string, action: "read" | "dismiss", idempotencyKey: string) =>
      client().post(`/v1/notifications/${encodeURIComponent(id)}/${action}`, { idempotencyKey }),
    snooze: (id: string, body: typeof schedulingSnoozeSchema._output, idempotencyKey: string) =>
      client().post(`/v1/notifications/${encodeURIComponent(id)}/snooze`, {
        body,
        idempotencyKey,
        schema: schedulingSnapshotSchema,
      }),
    calendar: (query: typeof schedulingCalendarQuerySchema._output) =>
      client().get("/v1/calendar", { query, schema: schedulingCalendarResponseSchema }),
  };
}
export type SchedulingApi = ReturnType<typeof createSchedulingApi>;
export function schedulingMessage(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : "";
  switch (code) {
    case "schedule.conflict":
      return "This schedule changed elsewhere. Reload it before saving again.";
    case "schedule.dst_choice":
      return "This local time is skipped or repeated by daylight saving. Choose the earlier or later occurrence.";
    case "schedule.past_reminder":
      return "Choose a future reminder hour. Reminders are delivered at the top of the hour.";
    case "schedule.channel_disabled":
      return "Enable this reminder channel in Notification settings first.";
    case "schedule.deadline_required":
      return "This reminder needs a deadline. Remove relative reminders or choose a custom time.";
    case "schedule.unavailable":
      return "Reminders are disabled on this server.";
    case "not_found":
      return "This task is no longer available.";
    default:
      return "Could not save or load this change. Check your connection and try again.";
  }
}
