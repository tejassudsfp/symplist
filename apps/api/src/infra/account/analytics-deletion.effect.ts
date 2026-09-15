import {
  createPostHogPersonDeletionClient,
  type PostHogPersonDeletionClient,
} from "@symplist/analytics/server";
import type { ApiConfig } from "@symplist/config/api";
import type { AccountDeletionCommitted, AccountDeletionEffect } from "@symplist/core/account";
import { type DbClient, int, sql, uuidv7 } from "@symplist/db";
import type { OperationalLog } from "../scheduler/runtime.ts";

/**
 * The PostHog person deletion client when the api holds `POSTHOG_PERSONAL_API_KEY` and
 * `POSTHOG_PROJECT_ID` (§4.5, §5.6), otherwise null. Deletion does not depend on
 * `ANALYTICS_ENABLED`: events captured while analytics was on must still be deleted after it is off.
 */
export function posthogDeletionClientFor(
  config: Pick<ApiConfig, "POSTHOG_PERSONAL_API_KEY" | "POSTHOG_PROJECT_ID">,
): PostHogPersonDeletionClient | null {
  const { POSTHOG_PERSONAL_API_KEY: personalApiKey, POSTHOG_PROJECT_ID: projectId } = config;
  if (personalApiKey === undefined || projectId === undefined) return null;
  return createPostHogPersonDeletionClient({ personalApiKey, projectId });
}

/**
 * After the deletion batch commits (§5.6), asks PostHog to delete the person behind the account's
 * `analytics_id` with its events and recordings, and records the accepted request in
 * `account_deletions.analytics_deletion_requested_at`. Without deletion credentials, or for an account
 * that never had an `analytics_id`, it does nothing. A failure throws to the deletion service, which
 * logs it by effect name and code; the request stays unrecorded.
 */
export class AnalyticsDeletionEffect implements AccountDeletionEffect {
  readonly name = "analytics_person_deletion";

  constructor(
    private readonly options: {
      readonly client: PostHogPersonDeletionClient | null;
      readonly db: DbClient;
      readonly now: () => number;
      readonly log: OperationalLog;
    },
  ) {}

  get enabled(): boolean {
    return this.options.client !== null;
  }

  async afterCommit(event: AccountDeletionCommitted): Promise<void> {
    const { client, db, log } = this.options;
    if (client === null || event.analyticsId === null) return;
    const result = await client.requestDeletion(event.analyticsId);
    const now = this.options.now();
    await db.run(
      sql(
        `UPDATE account_deletions
         SET analytics_deletion_requested_at = :now, updated_at = :now, write_id = :w
         WHERE user_id = :user AND analytics_deletion_requested_at IS NULL`,
        { now: int(now), w: uuidv7(now), user: event.userId },
      ),
    );
    log.info("account.analytics_deletion_requested", {
      userId: event.userId,
      personCount: result.personsFound,
      deletedCount: result.personsDeleted,
      failedCount: result.failedPersonUuids.length,
    });
  }
}
