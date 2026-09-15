import { defineErrorCodes } from "../common/errors.ts";

/**
 * Stable error codes owned by the access feature (§5, §6), mapped to HTTP statuses. Codes that carry
 * a wait put it in `details.retryAfter` (whole seconds); `otp.incorrect` carries
 * `details.attemptsRemaining`.
 */
export const accessErrorCodes = defineErrorCodes({
  /** No verified account uses the address; the web app offers signup instead (§5.1). */
  "auth.account_not_found": 404,
  /** Signup raced an account that is already verified; continue with a sign-in code. */
  "auth.account_exists": 409,
  /** The account is being deleted and cannot sign in or register again yet. */
  "auth.account_unavailable": 409,
  /** The code could not be handed to the email provider; nothing was sent. Try again. */
  "auth.delivery_failed": 502,

  /** The code does not match; `details.attemptsRemaining` counts what is left on this challenge. */
  "otp.incorrect": 400,
  /** The challenge expired, was replaced by a newer code or was already used: request a new code. */
  "otp.expired": 410,
  /** Every attempt on this challenge was used: request a new code. */
  "otp.attempts_exhausted": 410,
  /** Too many failed codes for this address and purpose; `details.retryAfter` (§5.1). */
  "otp.locked": 429,
  /** A new code was sent less than a minute ago; `details.retryAfter`. */
  "otp.cooldown": 429,
  /** The hourly or daily code limit for this address and purpose was reached; `details.retryAfter`. */
  "otp.send_limited": 429,

  /** Invalid, unknown, expired, exhausted, revoked or bound to another address: never says which (§5.4). */
  "invite.invalid": 422,
  /** The invite changed since it was read (`expectedVersion`); reload it. */
  "invite.changed": 409,
  /** The invite is revoked; it can no longer be edited. */
  "invite.revoked": 409,
  /** A cap below the seats already used; `details.used`. */
  "invite.capacity_below_used": 422,
  /** The expiry is in the past, not later than the current one, or too far away. */
  "invite.expiry_invalid": 422,

  /** The account's access changed since it was read (`expectedGeneration`); reload it. */
  "admin.state_changed": 409,
  /** The action does not apply to the account's current state (for example unlocking an unlocked account). */
  "admin.action_unavailable": 409,
  /** Campaign membership changed after the preview; preview again (§5.5). */
  "admin.preview_stale": 409,

  /** Onboarding cannot finish before the name step. */
  "onboarding.name_required": 409,

  /** The deletion authorization is missing, used, expired or bound to another session (§5.6). */
  "account.deletion_unauthorized": 403,
});
