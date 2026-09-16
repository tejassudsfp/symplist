import { type DbClient, int } from "@symplist/db";
import { MaintenanceFence, maintenanceStatement } from "../maintenance-fence.ts";
import { cleanupQuickChats, SimonPauseReconciler, SimonRepository } from "../simon/index.ts";
import type { ScannerExecution } from "./scanner.ts";
import type { SchedulingOptions } from "./service.ts";

export interface SchedulingCleanupOptions extends SchedulingOptions {
  readonly quickChatTtlHours: number;
  /** Compose bounded feature expiry work here. Each deciding mutation must use context.fence.guard(). */
  readonly cleanupFeatureExpiries?: (
    input: ScannerExecution,
    context: CleanupContext,
  ) => Promise<void>;
  readonly requeueSearch?: (db: DbClient, now: number, context: CleanupContext) => Promise<void>;
}
export interface CleanupContext {
  readonly db: DbClient;
  readonly now: () => number;
  readonly fence: MaintenanceFence;
}
export async function cleanupHourly(options: SchedulingCleanupOptions, input: ScannerExecution) {
  const now = options.now();
  const fence = new MaintenanceFence(options.db, input);
  if (!(await fence.current())) return { noop: true };
  const simon = new SimonRepository({ ...options, quickChatTtlHours: options.quickChatTtlHours });
  await new SimonPauseReconciler(simon).run(input);
  await cleanupQuickChats(simon, fence);
  await options.db.batch([
    maintenanceStatement(
      "DELETE FROM webhook_receipts WHERE rowid IN (SELECT rowid FROM webhook_receipts WHERE received_at<:cutoff LIMIT 100)",
      { cutoff: int(now - 30 * 86400000) },
      fence.guard(),
    ),
    maintenanceStatement(
      "DELETE FROM notification_provider_events WHERE provider_id IN (SELECT provider_id FROM notification_provider_events WHERE event_at<:cutoff LIMIT 100)",
      { cutoff: int(now - 30 * 86400000) },
      fence.guard(),
    ),
    maintenanceStatement(
      "DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE dismissed_at IS NOT NULL AND dismissed_at<:cutoff LIMIT 100)",
      { cutoff: int(now - 30 * 86400000) },
      fence.guard(),
    ),
  ]);
  if (!(await fence.current())) return { noop: true };
  await options.cleanupFeatureExpiries?.(input, { db: options.db, now: options.now, fence });
  if (await fence.current())
    await options.requeueSearch?.(options.db, options.now(), {
      db: options.db,
      now: options.now,
      fence,
    });
  return { noop: false };
}
