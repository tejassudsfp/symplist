import { type DbClient, int, sql } from "@symplist/db";
import { SimonPauseReconciler, SimonRepository } from "../simon/index.ts";
import type { ScannerExecution } from "./scanner.ts";
import type { SchedulingOptions } from "./service.ts";
import { ResendDeliveryEvents } from "./webhooks.ts";

export interface SchedulingCleanupOptions extends SchedulingOptions {
  readonly quickChatTtlHours: number;
  /** Filled by the integrator after the Vault and quick-chat streams land. Must be bounded and generation-fenced. */
  readonly cleanupFeatureExpiries?: (input: ScannerExecution) => Promise<void>;
  readonly requeueSearch?: (db: DbClient, now: number) => Promise<void>;
}
export async function cleanupHourly(options: SchedulingCleanupOptions, input: ScannerExecution) {
  const now = options.now();
  const state = await options.db.first(
    sql(
      "SELECT generation FROM executor_state WHERE id=1 AND mode=:mode AND generation=CAST(:generation AS INTEGER)",
      {
        mode: input.executor === "trigger" ? "durable" : "local",
        generation: int(input.generation),
      },
    ),
  );
  if (!state || input.signal?.aborted) return { noop: true };
  const simon = new SimonRepository({ ...options, quickChatTtlHours: options.quickChatTtlHours });
  await new SimonPauseReconciler(simon).run(input);
  await new ResendDeliveryEvents(options.db, options.keys, options.now).reconcile();
  await options.db.batch([
    sql(
      "DELETE FROM webhook_receipts WHERE rowid IN (SELECT rowid FROM webhook_receipts WHERE received_at<:cutoff LIMIT 100)",
      { cutoff: int(now - 30 * 86400000) },
    ),
    sql(
      "DELETE FROM notification_provider_events WHERE provider_id IN (SELECT provider_id FROM notification_provider_events WHERE event_at<:cutoff LIMIT 100)",
      { cutoff: int(now - 30 * 86400000) },
    ),
    sql(
      "DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE dismissed_at IS NOT NULL AND dismissed_at<:cutoff LIMIT 100)",
      { cutoff: int(now - 30 * 86400000) },
    ),
  ]);
  await options.cleanupFeatureExpiries?.(input);
  await options.requeueSearch?.(options.db, now);
  return { noop: false };
}
