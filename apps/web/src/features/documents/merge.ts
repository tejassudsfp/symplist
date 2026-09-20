import type { StructuralSection } from "@symplist/docs/markdown";
import { structureOf } from "./sections.ts";

/**
 * Section-level conflict review (note 11 "Autosave, history, and restore", document_history.md).
 * Nothing here merges silently: it lines the saved page up with the local draft against the revision
 * the draft started from, says which sections each side touched, and leaves every genuine overlap to
 * an explicit choice. Sections partition the document, so the chosen texts concatenate back into a
 * whole document with every unrelated section preserved byte for byte.
 */

export type MergeChoice = "draft" | "saved";

export type MergeStatus =
  /** Identical on both sides. */
  | "unchanged"
  /** Only the saved page changed it. */
  | "saved_changed"
  /** Only this device's draft changed it. */
  | "draft_changed"
  /** Both changed it: the person chooses. */
  | "both_changed"
  /** The draft adds it. */
  | "added_draft"
  /** The saved page adds it. */
  | "added_saved"
  /** The draft deletes it. */
  | "removed_draft"
  /** The saved page deletes it. */
  | "removed_saved";

export interface MergeEntry {
  /** Stable across re-planning of the same three documents; used for React keys and choices. */
  readonly key: string;
  readonly heading: string | null;
  readonly kind: StructuralSection["kind"];
  readonly depth: number;
  readonly status: MergeStatus;
  readonly savedText: string | null;
  readonly draftText: string | null;
  /** True when the two sides genuinely disagree and the person must decide. */
  readonly needsChoice: boolean;
  readonly defaultChoice: MergeChoice;
}

export interface MergePlan {
  readonly entries: readonly MergeEntry[];
  /** Entries needing a decision. */
  readonly conflicts: readonly MergeEntry[];
  /**
   * True when the documents were too large or too different to line up section by section, so the
   * only honest choice is the whole draft or the whole saved page.
   */
  readonly wholeDocument: boolean;
}

/** Beyond this many sections on either side the review falls back to a whole-document choice. */
export const MAX_MERGE_SECTIONS = 600;

interface KeyedSection {
  readonly key: string;
  readonly heading: string | null;
  readonly kind: StructuralSection["kind"];
  readonly depth: number;
  readonly text: string;
}

function keyed(markdown: string): KeyedSection[] {
  const counts = new Map<string, number>();
  return structureOf(markdown).sections.map((section) => {
    const identity = `${section.kind}|${section.depth}|${section.heading ?? ""}`;
    const seen = counts.get(identity) ?? 0;
    counts.set(identity, seen + 1);
    return {
      key: `${identity}|${seen}`,
      heading: section.heading,
      kind: section.kind,
      depth: section.depth,
      text: markdown.slice(section.start, section.end),
    };
  });
}

/**
 * Longest common subsequence of two lists of unique keys, as index pairs. With unique keys the
 * problem reduces to a longest increasing subsequence over the matched positions, which stays linear
 * in practice for documents of this size.
 */
function align(
  left: readonly KeyedSection[],
  right: readonly KeyedSection[],
): Array<[number, number]> {
  const rightIndex = new Map(right.map((section, index) => [section.key, index]));
  const pairs: Array<[number, number]> = [];
  for (let index = 0; index < left.length; index += 1) {
    const match = rightIndex.get((left[index] as KeyedSection).key);
    if (match !== undefined) pairs.push([index, match]);
  }
  // Longest increasing subsequence on the right indexes (patience sorting with back pointers).
  const tails: number[] = [];
  const tailIndexes: number[] = [];
  const previous: number[] = new Array(pairs.length).fill(-1);
  for (let index = 0; index < pairs.length; index += 1) {
    const value = (pairs[index] as [number, number])[1];
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((tails[middle] as number) < value) low = middle + 1;
      else high = middle;
    }
    tails[low] = value;
    tailIndexes[low] = index;
    previous[index] = low > 0 ? (tailIndexes[low - 1] as number) : -1;
  }
  const chosen: Array<[number, number]> = [];
  let cursor = tailIndexes.length > 0 ? (tailIndexes[tailIndexes.length - 1] as number) : -1;
  while (cursor >= 0) {
    chosen.push(pairs[cursor] as [number, number]);
    cursor = previous[cursor] as number;
  }
  return chosen.reverse();
}

function wholeDocumentPlan(saved: string, draft: string): MergePlan {
  const entry: MergeEntry = {
    key: "document",
    heading: null,
    kind: "block",
    depth: 0,
    status: saved === draft ? "unchanged" : "both_changed",
    savedText: saved,
    draftText: draft,
    needsChoice: saved !== draft,
    defaultChoice: "draft",
  };
  return {
    entries: [entry],
    conflicts: entry.needsChoice ? [entry] : [],
    wholeDocument: true,
  };
}

/**
 * Lines up the saved page and the local draft against their common base. `base` is the text of the
 * revision the draft started from, or the empty string for a page that had no revision yet.
 */
export function planMerge(base: string, saved: string, draft: string): MergePlan {
  const savedSections = keyed(saved);
  const draftSections = keyed(draft);
  if (savedSections.length > MAX_MERGE_SECTIONS || draftSections.length > MAX_MERGE_SECTIONS) {
    return wholeDocumentPlan(saved, draft);
  }
  const baseByKey = new Map(keyed(base).map((section) => [section.key, section.text]));
  const matched = align(savedSections, draftSections);
  const entries: MergeEntry[] = [];

  const emitSavedOnly = (section: KeyedSection) => {
    const baseText = baseByKey.get(section.key);
    if (baseText === undefined) {
      entries.push({
        key: section.key,
        heading: section.heading,
        kind: section.kind,
        depth: section.depth,
        status: "added_saved",
        savedText: section.text,
        draftText: null,
        needsChoice: false,
        defaultChoice: "saved",
      });
      return;
    }
    const changedOnSaved = baseText !== section.text;
    entries.push({
      key: section.key,
      heading: section.heading,
      kind: section.kind,
      depth: section.depth,
      status: changedOnSaved ? "both_changed" : "removed_draft",
      savedText: section.text,
      draftText: null,
      // The saved page changed a section this draft deleted: never drop it without being asked.
      needsChoice: changedOnSaved,
      defaultChoice: changedOnSaved ? "saved" : "draft",
    });
  };

  const emitDraftOnly = (section: KeyedSection) => {
    const baseText = baseByKey.get(section.key);
    if (baseText === undefined) {
      entries.push({
        key: section.key,
        heading: section.heading,
        kind: section.kind,
        depth: section.depth,
        status: "added_draft",
        savedText: null,
        draftText: section.text,
        needsChoice: false,
        defaultChoice: "draft",
      });
      return;
    }
    const changedOnDraft = baseText !== section.text;
    entries.push({
      key: section.key,
      heading: section.heading,
      kind: section.kind,
      depth: section.depth,
      status: changedOnDraft ? "both_changed" : "removed_saved",
      savedText: null,
      draftText: section.text,
      // The saved page deleted a section this draft edited: never drop the edit without being asked.
      needsChoice: changedOnDraft,
      defaultChoice: "draft",
    });
  };

  let savedCursor = 0;
  let draftCursor = 0;
  for (const [savedIndex, draftIndex] of matched) {
    while (savedCursor < savedIndex) emitSavedOnly(savedSections[savedCursor++] as KeyedSection);
    while (draftCursor < draftIndex) emitDraftOnly(draftSections[draftCursor++] as KeyedSection);
    const savedSection = savedSections[savedIndex] as KeyedSection;
    const draftSection = draftSections[draftIndex] as KeyedSection;
    const baseText = baseByKey.get(savedSection.key);
    const savedChanged = baseText === undefined || baseText !== savedSection.text;
    const draftChanged = baseText === undefined || baseText !== draftSection.text;
    const status: MergeStatus =
      savedSection.text === draftSection.text
        ? "unchanged"
        : savedChanged && draftChanged
          ? "both_changed"
          : savedChanged
            ? "saved_changed"
            : "draft_changed";
    entries.push({
      key: savedSection.key,
      heading: savedSection.heading,
      kind: savedSection.kind,
      depth: savedSection.depth,
      status,
      savedText: savedSection.text,
      draftText: draftSection.text,
      needsChoice: status === "both_changed",
      defaultChoice: status === "saved_changed" ? "saved" : "draft",
    });
    savedCursor = savedIndex + 1;
    draftCursor = draftIndex + 1;
  }
  while (savedCursor < savedSections.length) {
    emitSavedOnly(savedSections[savedCursor++] as KeyedSection);
  }
  while (draftCursor < draftSections.length) {
    emitDraftOnly(draftSections[draftCursor++] as KeyedSection);
  }
  return {
    entries,
    conflicts: entries.filter((entry) => entry.needsChoice),
    wholeDocument: false,
  };
}

/** Whether a merge plan resolves to exactly one of the two documents. */
export function defaultChoices(plan: MergePlan): Record<string, MergeChoice> {
  return Object.fromEntries(plan.entries.map((entry) => [entry.key, entry.defaultChoice]));
}

/** The document the chosen sides produce, in the saved page's order with the draft's additions kept. */
export function applyMerge(
  plan: MergePlan,
  choices: Readonly<Record<string, MergeChoice>>,
): string {
  return plan.entries
    .map((entry) => {
      const choice = choices[entry.key] ?? entry.defaultChoice;
      const text = choice === "draft" ? entry.draftText : entry.savedText;
      return text ?? "";
    })
    .join("");
}

/** A one-line summary of what a status means, never relying on color alone. */
export function mergeStatusLabel(status: MergeStatus): string {
  switch (status) {
    case "unchanged":
      return "Unchanged";
    case "saved_changed":
      return "Changed on the page";
    case "draft_changed":
      return "Changed in your draft";
    case "both_changed":
      return "Changed in both";
    case "added_draft":
      return "Added in your draft";
    case "added_saved":
      return "Added on the page";
    case "removed_draft":
      return "Deleted in your draft";
    case "removed_saved":
      return "Deleted on the page";
  }
}
