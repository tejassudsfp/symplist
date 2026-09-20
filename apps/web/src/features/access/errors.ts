import { ApiAbortedError, ApiError, ApiNetworkError } from "@/lib/api";

/**
 * How a failed access request reads to the person (system_states.md): what happened and what they can
 * do next, never internal names. Screens branch on `kind` and on `code` for the cases they explain
 * themselves (for example `otp.incorrect`).
 */
export type AccessProblem =
  | { readonly kind: "aborted" }
  /** The request never reached the api (offline, DNS, CORS refusal). */
  | { readonly kind: "network" }
  /** The session ended (`auth.session_required`): sign in again. */
  | { readonly kind: "session_expired" }
  /** Throttled; `retryAfterSeconds` when the api said how long to wait. */
  | { readonly kind: "throttled"; readonly code: string; readonly retryAfterSeconds: number | null }
  /** A stable code the screen may explain. */
  | {
      readonly kind: "api";
      readonly code: string;
      readonly status: number;
      readonly details: Readonly<Record<string, unknown>> | undefined;
    }
  /** Anything else: a server fault, a malformed response or missing configuration. */
  | { readonly kind: "unexpected" };

const throttleCodes = new Set(["rate.limited", "otp.cooldown", "otp.send_limited"]);

export function problemOf(error: unknown): AccessProblem {
  if (error instanceof ApiAbortedError) return { kind: "aborted" };
  if (error instanceof ApiNetworkError) return { kind: "network" };
  if (error instanceof ApiError) {
    if (error.code === "auth.session_required") return { kind: "session_expired" };
    if (throttleCodes.has(error.code)) {
      return {
        kind: "throttled",
        code: error.code,
        retryAfterSeconds: error.retryAfterSeconds ?? null,
      };
    }
    // A server fault carries no explanation; every other code (including the 502 delivery failure)
    // is one a screen may explain itself.
    if (error.code === "internal") return { kind: "unexpected" };
    return { kind: "api", code: error.code, status: error.status, details: error.details };
  }
  return { kind: "unexpected" };
}

/** Whether the error is the api's answer with this stable code. */
export function hasCode(error: unknown, code: string): boolean {
  return error instanceof ApiError && error.code === code;
}

/** A whole number from an error's details, for example `attemptsRemaining`. */
export function detailNumber(error: unknown, key: string): number | null {
  if (!(error instanceof ApiError)) return null;
  const value = error.details?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** "about 45 seconds", "about 2 minutes", "about an hour": calm wording for a wait. */
export function describeWait(seconds: number): string {
  if (seconds <= 1) return "a moment";
  if (seconds < 60) return `${Math.ceil(seconds)} seconds`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "a minute" : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours <= 1 ? "about an hour" : `about ${hours} hours`;
}

/** The generic copy for problems a screen does not explain itself. */
export function genericProblemMessage(problem: AccessProblem): string {
  switch (problem.kind) {
    case "network":
      return "Couldn't reach Symplist. Check your connection and try again.";
    case "session_expired":
      return "Your session has ended. Sign in again to continue.";
    case "throttled":
      return problem.retryAfterSeconds !== null
        ? `Too many requests right now. Try again in ${describeWait(problem.retryAfterSeconds)}.`
        : "Too many requests right now. Wait a moment and try again.";
    case "aborted":
      return "The request was cancelled.";
    case "api":
    case "unexpected":
      return "Something went wrong on our side. Try again.";
  }
}
