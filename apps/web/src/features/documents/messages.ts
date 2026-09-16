import { ApiClientError, ApiError } from "@/lib/api";

/**
 * Plain-language messages for every failure the task page can meet (system_states.md). Nothing here
 * names an internal service, a status code or a stack trace, and nothing claims work was lost that
 * was not: a failed save always keeps the draft.
 */

export interface DocumentFailure {
  /** What happened, in one short sentence. */
  readonly title: string;
  /** What the person can do next. */
  readonly description: string;
  /** Whether trying the same thing again can reasonably succeed. */
  readonly retryable: boolean;
  /** The stable code, used by the pane to branch (conflict, resync, expired sign-in). */
  readonly code: string;
}

const generic: DocumentFailure = {
  title: "Something went wrong",
  description: "The page couldn't be reached just now. Try again in a moment.",
  retryable: true,
  code: "unknown",
};

const byCode: Readonly<Record<string, Omit<DocumentFailure, "code">>> = {
  "auth.required": {
    title: "Your sign-in expired",
    description: "Sign in again to keep working on this page. Your draft is kept on this device.",
    retryable: false,
  },
  "auth.forbidden": {
    title: "You can't open this page",
    description: "This task belongs to another account.",
    retryable: false,
  },
  "access.locked": {
    title: "You can't open this page",
    description: "Your account doesn't have access to the workspace right now.",
    retryable: false,
  },
  not_found: {
    title: "This page isn't available",
    description: "The task may have been deleted, or the link may be wrong.",
    retryable: false,
  },
  "task.archived": {
    title: "This task is archived",
    description: "Restore the task to edit its page again.",
    retryable: false,
  },
  "document.conflict": {
    title: "The page changed while you were editing",
    description: "Nothing was overwritten. Review the changes and choose what to keep.",
    retryable: false,
  },
  "document.resync_required": {
    title: "This comparison is out of date",
    description:
      "The revision it started from is no longer available. Reload the page to continue.",
    retryable: false,
  },
  "document.stale_cursor": {
    title: "The page moved on",
    description: "New revisions arrived while you were reading. Load the list again.",
    retryable: true,
  },
  "document.cursor_invalid": {
    title: "The page moved on",
    description: "Load the list again to continue where you left off.",
    retryable: true,
  },
  "document.too_large": {
    title: "This page is too long to save",
    description: "Shorten it, or move part of it to a subtask. Your draft is kept.",
    retryable: false,
  },
  "document.history_too_large": {
    title: "This page's history is too large to add to",
    description:
      "Nothing was published and no history was lost. Contact support before editing further.",
    retryable: false,
  },
  "document.integrity_failed": {
    title: "This revision couldn't be opened",
    description: "Its stored copy couldn't be verified. Other revisions are unaffected.",
    retryable: false,
  },
  "document.edit_invalid": {
    title: "This change couldn't be applied",
    description: "Switch to Markdown and edit the text directly. Your draft is kept.",
    retryable: false,
  },
  "document.read_only": {
    title: "You can't edit this page",
    description: "Your access to this page is read-only. Your draft is kept on this device.",
    retryable: false,
  },
  "document.draft_stale": {
    title: "A newer draft is already saved",
    description: "This device's copy is older, so it was not stored.",
    retryable: false,
  },
  "idempotency.mismatch": {
    title: "That save was already recorded differently",
    description: "Reload the page to see the saved version. Your draft is kept.",
    retryable: false,
  },
  "rate.limited": {
    title: "Too many changes at once",
    description:
      "Saving paused for a moment. Your draft is kept; keep typing or use Retry in a moment.",
    retryable: true,
  },
  "validation.failed": {
    title: "This change couldn't be saved",
    description: "Something in the text was rejected. Switch to Markdown to check it.",
    retryable: false,
  },
};

/** Turns any thrown value into a message the page can show. */
export function describeFailure(error: unknown): DocumentFailure {
  if (error instanceof ApiError) {
    const known = byCode[error.code];
    if (known) return { ...known, code: error.code };
    if (error.status >= 500) {
      return {
        title: "Symplist had a problem",
        description: "The change wasn't saved. Try again in a moment; your draft is kept.",
        retryable: true,
        code: error.code,
      };
    }
    return { ...generic, code: error.code };
  }
  if (error instanceof ApiClientError) {
    if (error.kind === "network") {
      return {
        title: "You appear to be offline",
        description:
          "Symplist can't be reached. Your draft is kept on this device and saving resumes when the connection returns.",
        retryable: true,
        code: "offline",
      };
    }
    if (error.kind === "configuration" || error.kind === "server_side") {
      return {
        title: "This page isn't available here",
        description: "The workspace isn't fully set up in this build.",
        retryable: false,
        code: "configuration",
      };
    }
    if (error.kind === "aborted") {
      return { ...generic, code: "aborted" };
    }
  }
  return generic;
}

/** True for the errors that mean the caller should stop retrying and show the access or sign-in path. */
export function isSessionFailure(code: string): boolean {
  return code === "auth.required" || code === "auth.forbidden" || code === "access.locked";
}
