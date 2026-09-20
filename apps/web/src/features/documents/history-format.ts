import type {
  DocumentAuthor,
  DocumentCommitKind,
  DocumentHistoryEntry,
  DocumentSectionChange,
} from "@symplist/contracts";

/**
 * How revisions are named in the history list (document_history brief): who made them, when, and
 * what changed. Nothing here shows a repository concept the brief rules out — no branches, no
 * staging, no pull requests — and the commit id appears only as a secondary technical detail.
 */

/** "You" for the owner's own saves, "Simon" for the task agent, "An agent" for an MCP client. */
export function actorLabel(author: DocumentAuthor): string {
  switch (author) {
    case "user":
      return "You";
    case "simon":
      return "Simon";
    case "mcp":
      return "An agent";
  }
}

/** The short technical commit id shown in secondary details, never as the revision's name. */
export function shortRevision(revision: string): string {
  return revision.slice(0, 7);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A calm relative time. Exact times stay available through {@link exactTime}, so nothing depends on
 * a reader guessing what "yesterday" covers.
 */
export function relativeTime(at: number, now: number): string {
  const elapsed = now - at;
  if (elapsed < 0) return "just now";
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE);
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  const days = Math.floor(elapsed / DAY);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  return "over a month ago";
}

/** The full date and time, used as the title of a relative label and in the revision details. */
export function exactTime(at: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(at));
}

/** A short kind label; `edit` is the ordinary case and carries no badge. */
export function kindLabel(kind: DocumentCommitKind): string | null {
  switch (kind) {
    case "create":
      return "First version";
    case "normalization":
      return "Formatting";
    case "restore":
      return "Restored";
    case "edit":
      return null;
  }
}

export interface HistoryGroup {
  /** Stable key: the newest revision in the group. */
  readonly key: string;
  readonly author: DocumentAuthor;
  readonly entries: readonly DocumentHistoryEntry[];
}

/** Consecutive commits by the same author within this window read as one sitting (§9.3). */
export const HISTORY_GROUP_WINDOW_MS = 10 * MINUTE;

/**
 * Groups consecutive commits by the same author within 10 minutes (§9.3). The input is newest first,
 * as the API returns it, and so is every group.
 */
export function groupHistory(
  entries: readonly DocumentHistoryEntry[],
  windowMs: number = HISTORY_GROUP_WINDOW_MS,
): readonly HistoryGroup[] {
  const groups: HistoryGroup[] = [];
  let current: { key: string; author: DocumentAuthor; entries: DocumentHistoryEntry[] } | null =
    null;
  for (const entry of entries) {
    const previous = current?.entries.at(-1);
    const sameSitting =
      current !== null &&
      previous !== undefined &&
      current.author === entry.author &&
      previous.committedAt - entry.committedAt <= windowMs;
    if (sameSitting && current) {
      current.entries.push(entry);
      continue;
    }
    current = { key: entry.revision, author: entry.author, entries: [entry] };
    groups.push(current);
  }
  return groups;
}

/** "3 sections changed" for a group header; singular when there is only one revision. */
export function groupSummary(group: HistoryGroup): string {
  const count = group.entries.length;
  return count === 1 ? "1 revision" : `${count} revisions`;
}

/**
 * "2 added, 1 changed, 1 removed" — the counts a comparison found, never relying on colour to say
 * which is which (document_history brief).
 */
export function changeSummary(changes: readonly DocumentSectionChange[]): string {
  if (changes.length === 0) return "No sections changed";
  const counts = { added: 0, modified: 0, removed: 0 };
  for (const change of changes) counts[change.status] += 1;
  const parts: string[] = [];
  if (counts.added > 0) parts.push(`${counts.added} added`);
  if (counts.modified > 0) parts.push(`${counts.modified} changed`);
  if (counts.removed > 0) parts.push(`${counts.removed} removed`);
  return parts.join(", ");
}

/** The word shown beside a changed section; the label carries the meaning, not the colour. */
export function changeStatusLabel(status: DocumentSectionChange["status"]): string {
  switch (status) {
    case "added":
      return "Added";
    case "modified":
      return "Changed";
    case "removed":
      return "Removed";
  }
}

/** The name of a section in a comparison; heading-free blocks say so rather than showing an id. */
export function sectionLabel(change: DocumentSectionChange): string {
  if (change.heading) return change.heading;
  return change.kind === "preamble" ? "Opening text" : "A block without a heading";
}

/** The accessible name of one diff line; screen readers hear Added or Removed, not a colour. */
export function diffLineLabel(kind: "context" | "added" | "removed"): string | null {
  if (kind === "added") return "Added";
  if (kind === "removed") return "Removed";
  return null;
}

/**
 * "You, 5 minutes ago" for a revision row's accessible name, with the subject and, when present, the
 * kind badge so the row reads as one sentence.
 */
export function entryDescription(entry: DocumentHistoryEntry, now: number): string {
  const kind = kindLabel(entry.kind);
  const badge = kind === null ? "" : `, ${kind}`;
  return `${actorLabel(entry.author)}, ${relativeTime(entry.committedAt, now)}${badge}: ${entry.subject}`;
}
