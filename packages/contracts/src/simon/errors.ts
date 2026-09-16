import { defineErrorCodes } from "../common/errors.ts";

/** Stable error codes owned by the simon feature (§8, §6), mapped to HTTP statuses. */
export const simonErrorCodes = defineErrorCodes({
  "ai.unavailable": 503,
  "simon.stale": 409,
  "simon.queue_full": 429,
  "simon.conversation_expired": 410,
  "approval.stale": 409,
  "approval.split_required": 422,
  "user_ask.stale": 409,
});
