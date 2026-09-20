import { ACCOUNT_PURGE_INTENT_KIND } from "../../account/deletion.ts";
import type { EventsContributor } from "./types.ts";

/** The Trigger task that runs the account purge in durable mode (§5.6, §8.8). */
export const ACCOUNT_PURGE_TASK_ID = "account-purge";

/**
 * Account execution seams (§5.6): the `account_purge` intent recorded by the deletion batch runs the
 * `account-purge` Trigger task with the ids-only payload `{ userId }` (the subject id). The purge has
 * no run lifecycle to reconcile: its progress lives in `account_deletions.steps_done`, so the kind has
 * no tracker.
 */
export const accountEventsContributor: EventsContributor = {
  domain: "account",
  executionKinds: [
    {
      kind: ACCOUNT_PURGE_INTENT_KIND,
      triggerTaskId: ACCOUNT_PURGE_TASK_ID,
      payload: (job) => ({ userId: job.subjectId }),
    },
  ],
};
