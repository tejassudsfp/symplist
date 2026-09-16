import {
  type SearchArchiveMode,
  type SearchCollection,
  type SearchContentType,
  type SearchDeadlineFilter,
  searchCollections,
  searchContentTypes,
  searchDateSchema,
  searchDefaultContentTypes,
  searchTimeZoneSchema,
} from "@symplist/contracts";

/*
 * Full search filters (search.md, note 14): collections, the Archive opt-in, content types with Chat
 * as its own opt-in, and deadline filters derived from schedule metadata. Everything here is plain
 * data so the scope sentence, validation and request building are tested without rendering.
 */

export const collectionLabels: Readonly<Record<SearchCollection, string>> = {
  now: "Now",
  later: "Later",
  unclassified: "Unclassified",
};

export const contentTypeLabels: Readonly<Record<SearchContentType, string>> = {
  tasks: "Task titles",
  documents: "Documents",
  chat: "Chat",
};

export const archiveLabels: Readonly<Record<SearchArchiveMode, string>> = {
  exclude: "Active tasks",
  include: "Active and archived",
  only: "Archived only",
};

export type DeadlineChoice = "any" | "has" | "none" | "due_today" | "overdue" | "range";

export const deadlineLabels: Readonly<Record<DeadlineChoice, string>> = {
  any: "Any deadline",
  has: "Has deadline",
  none: "No deadline",
  due_today: "Due today",
  overdue: "Overdue",
  range: "Due between",
};

/** The deadline filter as the form holds it; dates stay text until validated. */
export interface DeadlineDraft {
  readonly choice: DeadlineChoice;
  readonly from: string;
  readonly to: string;
}

export interface SearchFilters {
  readonly collections: readonly SearchCollection[];
  readonly archive: SearchArchiveMode;
  readonly types: readonly SearchContentType[];
  readonly deadline: DeadlineDraft;
}

/** Note 14 defaults: active titles and current documents across every collection. */
export const defaultSearchFilters: SearchFilters = Object.freeze({
  collections: Object.freeze([...searchCollections]),
  archive: "exclude",
  types: Object.freeze([...searchDefaultContentTypes]),
  deadline: Object.freeze({ choice: "any", from: "", to: "" }),
});

/** The viewer's IANA time zone, which deadline comparisons use and the filter labels. */
export function viewerTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return searchTimeZoneSchema.safeParse(zone).success ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

export type DeadlineValidation =
  | { readonly ok: true; readonly filter: SearchDeadlineFilter | null }
  | { readonly ok: false; readonly message: string };

/**
 * Turns the deadline draft into the request filter, or explains why it is malformed (note 14
 * "malformed optional filters"). A malformed filter is never sent.
 */
export function validateDeadline(draft: DeadlineDraft, timeZone: string): DeadlineValidation {
  switch (draft.choice) {
    case "any":
      return { ok: true, filter: null };
    case "has":
    case "none":
      return { ok: true, filter: { kind: draft.choice } };
    case "due_today":
    case "overdue":
      return { ok: true, filter: { kind: draft.choice, timeZone } };
    case "range": {
      if (!draft.from || !draft.to) {
        return { ok: false, message: "Choose both dates for the range" };
      }
      if (!searchDateSchema.safeParse(draft.from).success) {
        return { ok: false, message: "The start date isn't a real date" };
      }
      if (!searchDateSchema.safeParse(draft.to).success) {
        return { ok: false, message: "The end date isn't a real date" };
      }
      if (draft.from > draft.to) {
        return { ok: false, message: "The range ends before it starts" };
      }
      return { ok: true, filter: { kind: "range", from: draft.from, to: draft.to, timeZone } };
    }
  }
}

/** Toggles one value while keeping at least one selected, in the canonical order. */
export function toggleInList<Value extends string>(
  order: readonly Value[],
  selected: readonly Value[],
  value: Value,
): readonly Value[] {
  const next = selected.includes(value)
    ? selected.filter((item) => item !== value)
    : [...selected, value];
  if (next.length === 0) return selected;
  return order.filter((item) => next.includes(item));
}

export const collectionOrder = searchCollections;
export const contentTypeOrder = searchContentTypes;

/** "Now, Later and Unclassified" */
export function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

function formatDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** A deadline filter in words, with the comparison time zone where it matters (note 14). */
export function describeDeadline(filter: SearchDeadlineFilter | null): string | null {
  if (!filter) return null;
  switch (filter.kind) {
    case "has":
      return "with a deadline";
    case "none":
      return "without a deadline";
    case "due_today":
      return `due today (${filter.timeZone})`;
    case "overdue":
      return `overdue (${filter.timeZone})`;
    case "range":
      return `due ${formatDate(filter.from)} to ${formatDate(filter.to)} (${filter.timeZone})`;
  }
}

/** The effective scope of a search, as the response reports it or the form requests it. */
export interface ScopeDescription {
  readonly collections: readonly SearchCollection[];
  readonly archive: SearchArchiveMode;
  readonly types: readonly SearchContentType[];
  readonly deadline: SearchDeadlineFilter | null;
}

/**
 * The scope sentence shown with every search (note 14: "the label always states scope"), for
 * example "Task titles and documents in Now, Later and Unclassified. Archived tasks aren't included."
 */
export function describeScope(scope: ScopeDescription): string {
  const types = scope.types.map((type, index) => {
    const label = contentTypeLabels[type];
    return index === 0 ? label : label.toLowerCase();
  });
  const where = joinLabels(scope.collections.map((collection) => collectionLabels[collection]));
  const deadline = describeDeadline(scope.deadline);
  const archive =
    scope.archive === "exclude"
      ? "Archived tasks aren't included."
      : scope.archive === "include"
        ? "Archived tasks are included."
        : "Only archived tasks.";
  const subject = `${joinLabels(types)} in ${where}${deadline ? `, ${deadline}` : ""}.`;
  return `${subject} ${archive}`;
}
