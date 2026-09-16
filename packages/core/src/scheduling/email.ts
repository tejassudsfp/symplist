import type { EmailMessage } from "@symplist/email/transport";
import { NotificationsService } from "./notifications.ts";
import type { ReminderScannerOptions } from "./scanner.ts";
import type { SchedulingService } from "./service.ts";

interface ReminderRenderer {
  reminder(input: {
    due:
      | { kind: "none" }
      | { kind: "date"; date: string; timeZone: string }
      | { kind: "timed"; at: number; timeZone: string };
    preview: { kind: "generic" } | { kind: "title"; title: string };
    delayed?: { intendedAt: number; timeZone: string };
    openTaskUrl: string;
    preferencesUrl: string;
    oneClickUnsubscribeUrl: string;
  }): Promise<Omit<EmailMessage, "to" | "idempotencyKey">>;
}
/** A shared immutable payload builder; only the opt-in title reaches the existing email templates. */
export function reminderPayloadFactory(
  service: SchedulingService,
  renderer: ReminderRenderer,
  origins: { webOrigin: string; apiOrigin: string },
): ReminderScannerOptions["renderEmail"] {
  const notifications = new NotificationsService(service);
  return async ({ ownerId, taskId, occurrenceId, title, row, late }) => {
    const rendered = await renderer.reminder({
      due:
        row.deadline_kind === "date"
          ? { kind: "date", date: String(row.deadline_date), timeZone: String(row.deadline_zone) }
          : row.deadline_kind === "timed"
            ? { kind: "timed", at: Number(row.deadline_at), timeZone: String(row.deadline_zone) }
            : { kind: "none" },
      preview: row.email_preview === 1 ? { kind: "title", title } : { kind: "generic" },
      ...(late
        ? { delayed: { intendedAt: Number(row.intended_at), timeZone: String(row.zone ?? "UTC") } }
        : {}),
      openTaskUrl: `${origins.webOrigin}/tasks/${taskId}`,
      preferencesUrl: `${origins.webOrigin}/settings/notifications`,
      oneClickUnsubscribeUrl: `${origins.apiOrigin}/webhooks/reminder-unsubscribe?token=${encodeURIComponent(notifications.unsubscribeToken(ownerId))}`,
    });
    return { ...rendered, to: String(row.email), idempotencyKey: `reminder/${occurrenceId}/email` };
  };
}
