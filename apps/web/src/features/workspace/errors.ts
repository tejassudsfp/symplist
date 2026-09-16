import { ApiClientError, ApiError } from "@/lib/api";

/**
 * How the workspace explains a failed request (system_states.md): what happened and what the person
 * can do next, never internal system names, request ids or another account's data.
 */
export type FailureKind =
  /** No response: offline, DNS, connection reset. */
  | "network"
  /** The session ended (`auth.session_required`). */
  | "signed_out"
  /** Access is paused or not granted yet (`access.*`). */
  | "access_paused"
  /** The api is shedding load (`rate.limited`). */
  | "busy"
  /** Unknown, foreign or deleted (`not_found`). */
  | "not_found"
  /** The task was completed, possibly on another device (`task.archived`). */
  | "archived"
  /** Simon is still working on the task (`task.run_active`). */
  | "run_active"
  /** The tree or a preference group changed while the write was prepared. */
  | "conflict"
  /** An impossible place or depth (`task.placement_invalid`, `task.depth_limit`). */
  | "invalid_place"
  /** Input the api refused (`validation`). */
  | "invalid_input"
  | "unexpected";

export interface Failure {
  readonly kind: FailureKind;
  /** Seconds to wait before retrying, when the api said. */
  readonly retryAfterSeconds?: number;
  /** Whether trying the same request again can succeed without changing anything. */
  readonly retryable: boolean;
}

const accessCodes = new Set([
  "access.locked",
  "access.relocked",
  "access.suspended",
  "access.unverified",
  "access.admin_required",
]);

export function classifyFailure(error: unknown): Failure {
  if (error instanceof ApiError) {
    const code = String(error.code);
    if (code === "auth.session_required") return { kind: "signed_out", retryable: false };
    if (accessCodes.has(code)) return { kind: "access_paused", retryable: false };
    if (code === "rate.limited") {
      return {
        kind: "busy",
        retryable: true,
        ...(error.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
      };
    }
    if (code === "not_found") return { kind: "not_found", retryable: false };
    if (code === "task.archived") return { kind: "archived", retryable: false };
    if (code === "task.run_active") return { kind: "run_active", retryable: false };
    if (
      code === "task.conflict" ||
      code === "preferences.conflict" ||
      code === "idempotency.in_progress"
    ) {
      return { kind: "conflict", retryable: true };
    }
    if (code === "task.placement_invalid" || code === "task.depth_limit") {
      return { kind: "invalid_place", retryable: false };
    }
    if (code === "validation") return { kind: "invalid_input", retryable: false };
    if (code === "auth.csrf_invalid" || code === "auth.origin_forbidden") {
      // The CSRF token is dropped after a 403, so the next attempt fetches a fresh one (W6).
      return { kind: "unexpected", retryable: true };
    }
    return { kind: "unexpected", retryable: error.status >= 500 };
  }
  if (error instanceof ApiClientError) {
    if (error.kind === "network") return { kind: "network", retryable: true };
    return { kind: "unexpected", retryable: error.kind !== "configuration" };
  }
  return { kind: "unexpected", retryable: true };
}

export interface FailureCopy {
  readonly title: string;
  readonly description: string;
  /** A full document navigation for signed-out and paused accounts. */
  readonly href?: string;
  readonly hrefLabel?: string;
}

/** Copy for a region that failed to load, for example the Now list. */
export function loadFailureCopy(failure: Failure, subject: string): FailureCopy {
  switch (failure.kind) {
    case "signed_out":
      return {
        title: "You're signed out",
        description: "Sign in again to see your tasks. Nothing you saved is lost.",
        href: "/signin",
        hrefLabel: "Sign in",
      };
    case "access_paused":
      return {
        title: "Your access is paused",
        description: "Your tasks are kept safe while access is paused.",
        href: "/access",
        hrefLabel: "See what to do",
      };
    case "busy":
      return {
        title: `Couldn't load ${subject}`,
        description:
          failure.retryAfterSeconds !== undefined
            ? `Symplist is busy. Try again in ${failure.retryAfterSeconds} seconds.`
            : "Symplist is busy. Try again in a moment.",
      };
    case "network":
      return {
        title: `Couldn't load ${subject}`,
        description: "Your tasks are safe. Check your connection and try again.",
      };
    default:
      return {
        title: `Couldn't load ${subject}`,
        description: "Your tasks are safe. Try again in a moment.",
      };
  }
}

/**
 * One plain sentence for a write that did not go through, for a toast or an inline message. `attempt`
 * reads as "Couldn't move “Book a bike tune-up”", so callers pass what was tried, already quoted.
 */
export function writeFailureMessage(failure: Failure, attempt: string): string {
  switch (failure.kind) {
    case "signed_out":
      return `Couldn't ${attempt}. You're signed out — sign in again and nothing is lost.`;
    case "access_paused":
      return `Couldn't ${attempt}. Your access is paused.`;
    case "busy":
      return failure.retryAfterSeconds !== undefined
        ? `Couldn't ${attempt}. Symplist is busy; try again in ${failure.retryAfterSeconds} seconds.`
        : `Couldn't ${attempt}. Symplist is busy; try again in a moment.`;
    case "network":
      return `Couldn't ${attempt}. Check your connection and try again.`;
    case "not_found":
      return `Couldn't ${attempt}. It isn't there any more.`;
    case "archived":
      return `Couldn't ${attempt}. It was already completed.`;
    case "run_active":
      return `Couldn't ${attempt}. Simon is still working on it.`;
    case "conflict":
      return `Couldn't ${attempt}. Your tasks changed on another device; try again.`;
    case "invalid_place":
      return `Couldn't ${attempt}. That place isn't possible.`;
    case "invalid_input":
      return `Couldn't ${attempt}. Check what you entered and try again.`;
    default:
      return `Couldn't ${attempt}. Try again in a moment.`;
  }
}

/** How a failed preference save reads while the change is still previewed in this browser (§10.3). */
export function previewOnlyMessage(failure: Failure): string {
  switch (failure.kind) {
    case "signed_out":
      return "Previewing here. Sign in again to save this to your account.";
    case "access_paused":
      return "Previewing here. Your access is paused, so nothing was saved to your account.";
    case "network":
      return "Previewing here. Symplist couldn't reach your account.";
    case "busy":
      return "Previewing here. Symplist is busy; try again in a moment.";
    default:
      return "Previewing here. Couldn't save this to your account.";
  }
}
