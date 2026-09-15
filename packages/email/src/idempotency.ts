import { EmailValidationError } from "./errors.ts";
import type { OtpPurpose } from "./templates/otp.tsx";

const idSegment = /^[A-Za-z0-9_-]{1,128}$/;

function segment(value: string, label: string): string {
  if (!idSegment.test(value)) {
    throw new EmailValidationError(
      "email.invalid_message",
      `${label} must be 1-128 characters of letters, digits, '_' or '-'`,
    );
  }
  return value;
}

/**
 * Provider idempotency keys (Resend keeps them for 24 hours, §12.3). Each key names one logical
 * send, so retries of the same send are deduplicated and different sends never collide. Keys hold
 * only ids, never addresses or content.
 */
export const emailIdempotencyKeys = {
  /** One OTP email per challenge; a resend supersedes the challenge and gets a new id (§5.1). */
  otp(purpose: OtpPurpose, challengeId: string): string {
    return `otp/${purpose}/${segment(challengeId, "challengeId")}`;
  },
  /** One notice per completed Vault reset authorization (§11.2). */
  vaultResetNotice(resetAuthorizationId: string): string {
    return `vault-reset-notice/${segment(resetAuthorizationId, "resetAuthorizationId")}`;
  },
  /** The reminder email for one occurrence: `reminder/<occurrenceId>/email` (§12.3). */
  reminder(occurrenceId: string): string {
    return `reminder/${segment(occurrenceId, "occurrenceId")}/email`;
  },
} as const;
