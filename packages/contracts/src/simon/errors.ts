import { defineErrorCodes } from "../common/errors.ts";

/** Stable error codes owned by the simon feature (§8, §6), mapped to HTTP statuses. */
export const simonErrorCodes = defineErrorCodes({
  /**
   * Bring-your-own-key model access (§8.6). The account has no usable key for the tier it asked to
   * run. This is the ordinary state of a new account rather than a fault, so the surface that
   * catches it points at settings instead of apologising, and it is 409 rather than 402 because
   * nothing is owed to us.
   */
  "ai.key_required": 409,
  /** The provider refused the stored key. The key stays, so its owner can see which one to fix. */
  "ai.key_rejected": 400,
  /** A tier names a model this provider does not offer, or the provider refused the request. */
  "ai.model_unavailable": 400,
  "ai.unavailable": 503,
  "simon.stale": 409,
  "simon.queue_full": 429,
  "simon.conversation_expired": 410,
  "approval.stale": 409,
  "approval.split_required": 422,
  "user_ask.stale": 409,
});
