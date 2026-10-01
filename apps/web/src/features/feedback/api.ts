import type { BugReportCreate, BugReportReceipt } from "@symplist/contracts";
import { bugReportReceiptSchema } from "@symplist/contracts";
import { type ApiClient, ApiError, getApiClient } from "@/lib/api";

/**
 * Filing a bug report.
 *
 * Two paths rather than one, matching the api: `POST /v1/bugs` is session-authenticated and attributes
 * the report, and `POST /v1/bugs/anonymous` is the `pre_session` route the public site uses, where
 * every cookie is stripped before the handler and the report belongs to nobody. The caller picks by
 * whether somebody is signed in — see `apps/api/src/modules/system/bug-reports.controller.ts` for why
 * the api cannot do both on one route.
 */
export interface FeedbackApi {
  report(input: BugReportCreate): Promise<BugReportReceipt>;
  reportAnonymously(input: BugReportCreate): Promise<BugReportReceipt>;
}

export function createFeedbackApi(client: ApiClient): FeedbackApi {
  return {
    // Neither route takes an `Idempotency-Key`. A key is only honoured on a route that knows whose key
    // it is (§6.1), which the public one deliberately does not — and the duplicate it would prevent is
    // a second copy of a bug report in an append-only inbox, which costs a maintainer one glance and
    // the api two more D1 round trips to avoid. `POST /v1/labels` makes the same trade.
    report: (input) => client.post("/v1/bugs", { body: input, schema: bugReportReceiptSchema }),
    reportAnonymously: (input) =>
      client.post("/v1/bugs/anonymous", {
        body: input,
        schema: bugReportReceiptSchema,
        csrf: "pre_session",
      }),
  };
}

let shared: FeedbackApi | null = null;
export function feedbackApi(): FeedbackApi {
  shared ??= createFeedbackApi(getApiClient());
  return shared;
}

/** What to tell somebody whose report did not land. Never loses what they typed — the form keeps it. */
export function reportFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "rate.limited") {
      return "That is a few reports in a short while. Wait a few minutes and send this one again.";
    }
    if (error.code === "validation")
      return "That report is too long to send. Shorten it and retry.";
    if (error.code === "auth.session_required") {
      return "Your session ended. Sign in again — your report is still here to send.";
    }
  }
  return "That report could not be sent. Check your connection and try again — nothing was lost.";
}
