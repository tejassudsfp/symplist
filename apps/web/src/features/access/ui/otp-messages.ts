import { describeWait, detailNumber, problemOf } from "../errors.ts";

/** What a code screen shows after a failed verification or send (email_otp.md states). */
export interface OtpMessage {
  readonly tone: "error" | "warning" | "success";
  readonly title?: string;
  readonly text: string;
  /** Only a new code can help; the field is cleared and the resend is offered. */
  readonly needsNewCode?: boolean;
  /** Nothing can be tried before this instant (epoch milliseconds). */
  readonly blockedUntil?: number;
}

function waitMessage(retryAfterSeconds: number | null, fallback: string): string {
  return retryAfterSeconds === null
    ? fallback
    : `Wait ${describeWait(retryAfterSeconds)} and try again.`;
}

/** The message for a failed `POST /…/verify`, in the calm wording the briefs ask for. */
export function describeVerifyFailure(error: unknown, now: () => number = Date.now): OtpMessage {
  const problem = problemOf(error);
  switch (problem.kind) {
    case "network":
      return {
        tone: "error",
        text: "Symplist couldn't be reached. Your code is still valid — try again.",
      };
    case "throttled":
      return {
        tone: "warning",
        title: "Too many tries",
        text: waitMessage(problem.retryAfterSeconds, "Wait a moment and try again."),
        ...(problem.retryAfterSeconds === null
          ? {}
          : { blockedUntil: now() + problem.retryAfterSeconds * 1000 }),
      };
    case "api":
      switch (problem.code) {
        case "otp.incorrect": {
          const remaining = detailNumber(error, "attemptsRemaining");
          return {
            tone: "error",
            text:
              remaining === null
                ? "That code isn't right. Check the email and try again."
                : remaining <= 0
                  ? "That code isn't right, and this code has no tries left. Send a new code."
                  : remaining === 1
                    ? "That code isn't right. One more try before you need a new code."
                    : `That code isn't right. ${remaining} tries left before you need a new code.`,
            ...(remaining !== null && remaining <= 0 ? { needsNewCode: true } : {}),
          };
        }
        case "otp.expired":
          return {
            tone: "warning",
            title: "That code has expired",
            text: "Codes last a few minutes, and a newer code replaces an older one. Send a new code.",
            needsNewCode: true,
          };
        case "otp.attempts_exhausted":
          return {
            tone: "warning",
            title: "Too many tries with this code",
            text: "Send a new code and enter the newest one.",
            needsNewCode: true,
          };
        case "otp.locked": {
          const seconds = detailNumber(error, "retryAfter");
          return {
            tone: "warning",
            title: "Too many attempts for this address",
            text: `For your security, verification is paused for ${
              seconds === null ? "a while" : describeWait(seconds)
            }. Nothing is lost — come back and ask for a new code then.`,
            ...(seconds === null ? {} : { blockedUntil: now() + seconds * 1000 }),
          };
        }
        case "account.deletion_unauthorized":
          return {
            tone: "warning",
            title: "That confirmation has expired",
            text: "Start the deletion again to get a new code.",
            needsNewCode: true,
          };
        default:
          return { tone: "error", text: "Something went wrong. Try again." };
      }
    case "session_expired":
      return { tone: "error", text: "Your session has ended. Sign in again to continue." };
    case "aborted":
    case "unexpected":
      return { tone: "error", text: "Something went wrong on our side. Try again." };
  }
}

/** The message for a failed code send or resend. */
export function describeSendFailure(error: unknown, now: () => number = Date.now): OtpMessage {
  const problem = problemOf(error);
  switch (problem.kind) {
    case "network":
      return {
        tone: "error",
        text: "Symplist couldn't be reached. Check your connection and try again.",
      };
    case "throttled":
      return {
        tone: "warning",
        title: "A code was sent recently",
        text:
          problem.retryAfterSeconds === null
            ? "Wait a moment before asking for another."
            : `You can ask for another in ${describeWait(problem.retryAfterSeconds)}.`,
        ...(problem.retryAfterSeconds === null
          ? {}
          : { blockedUntil: now() + problem.retryAfterSeconds * 1000 }),
      };
    case "api":
      switch (problem.code) {
        case "auth.delivery_failed":
          return {
            tone: "error",
            title: "We couldn't send the code",
            text: "Nothing was sent. Try again.",
          };
        case "auth.account_not_found":
          return {
            tone: "warning",
            text: "There's no account for this address any more.",
          };
        case "auth.account_unavailable":
          return {
            tone: "warning",
            title: "This account is being deleted",
            text: "Codes can't be sent to it while the deletion finishes.",
          };
        default:
          return { tone: "error", text: "Something went wrong. Try again." };
      }
    case "session_expired":
      return { tone: "error", text: "Your session has ended. Sign in again to continue." };
    case "aborted":
    case "unexpected":
      return { tone: "error", text: "Something went wrong on our side. Try again." };
  }
}
