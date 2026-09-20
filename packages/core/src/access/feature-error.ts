import type { ErrorCode } from "@symplist/contracts";

/**
 * A refusal from an access feature service, carrying a declared stable error code (§6) and safe,
 * non-secret details (counts, waits, versions). The api maps it to the error envelope unchanged;
 * messages never carry emails, codes, names or reasons.
 */
export class AccessFeatureError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, details?: Readonly<Record<string, unknown>>) {
    super(code);
    this.name = "AccessFeatureError";
    this.code = code;
    this.details = details;
  }
}

/** Whole seconds until `until`, at least 1 and at most one day (the `retryAfter` contract). */
export function retryAfterSeconds(until: number, now: number): number {
  return Math.min(86_400, Math.max(1, Math.ceil((until - now) / 1000)));
}
