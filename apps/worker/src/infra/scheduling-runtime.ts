import {
  cleanupHourly,
  ReminderScanner,
  reminderPayloadFactory,
  SchedulingService,
} from "@symplist/core/scheduling";
import {
  enqueueSearchIndex,
  SEARCH_STALE_INTENT_MS,
  staleSearchOwners,
} from "@symplist/core/search";
import { sql } from "@symplist/db";
import {
  createEmailRenderer,
  createLogEmailTransport,
  createResendEmailTransport,
} from "@symplist/email";
import { tasks } from "@trigger.dev/sdk";
import type { WorkerRuntime } from "./runtime.ts";

export async function runScheduledWork(
  runtime: WorkerRuntime,
  kind: "scan" | "cleanup",
  signal?: AbortSignal,
) {
  if (!runtime.config.DURABLE) return { noop: true };
  const state = await runtime.db.first(
    sql("SELECT generation FROM executor_state WHERE id=1 AND mode='durable'"),
  );
  if (!state) return { noop: true };
  const config = runtime.config;
  const options = {
    db: runtime.db,
    keys: runtime.keys,
    now: Date.now,
    policy: { betaAccessRequired: config.BETA_ACCESS_REQUIRED },
    remindersEnabled: config.REMINDERS_ENABLED,
    emailEnabled: config.REMINDER_EMAIL_ENABLED,
    defaultZone: config.DEFAULT_TIMEZONE,
  };
  const execution = {
    executor: "trigger" as const,
    generation: Number(state.generation),
    ...(signal ? { signal } : {}),
  };
  if (kind === "cleanup")
    return cleanupHourly(
      {
        ...options,
        quickChatTtlHours: config.QUICK_CHAT_TTL_HOURS,
        requeueSearch: async (db, now) => {
          for (const owner of await staleSearchOwners(db, {
            now,
            olderThanMs: SEARCH_STALE_INTENT_MS,
            limit: 25,
          }))
            await enqueueSearchIndex({ tasks }, owner, now);
        },
      },
      execution,
    );
  const service = new SchedulingService(options);
  const email =
    config.EMAIL_DRIVER === "resend"
      ? createResendEmailTransport({
          apiKey: config.RESEND_API_KEY ?? "",
          senders: {
            security: config.EMAIL_FROM_REMINDERS,
            reminders: config.EMAIL_FROM_REMINDERS,
          },
        })
      : createLogEmailTransport({ driver: config.EMAIL_DRIVER, nodeEnv: config.NODE_ENV });
  const renderer = createEmailRenderer({
    webOrigin: config.WEB_ORIGIN,
    apiOrigin: config.API_ORIGIN,
    accountHelpUrl: `${config.WEB_ORIGIN}/settings/account`,
  });
  return new ReminderScanner({
    ...options,
    email,
    maxLatenessHours: config.REMINDER_MAX_LATENESS_HOURS,
    renderEmail: reminderPayloadFactory(service, renderer, {
      webOrigin: config.WEB_ORIGIN,
      apiOrigin: config.API_ORIGIN,
    }),
    notify: async (ownerId, notificationId) => {
      await runtime.events.announce({
        type: "notifications.changed",
        ownerId,
        payload: { notificationId },
      });
    },
    summary: async (ownerId, count) => {
      await runtime.events.announce({ type: "notifications.summary", ownerId, payload: { count } });
    },
  }).run(execution);
}
