import type { IndexedSection, SectionIndex } from "./section-index.ts";

export type SectionChangeStatus = "added" | "modified" | "removed";

/** A section that differs between two revisions (§9.4, note 11 "Deterministic change retrieval"). */
export interface SectionChange {
  readonly status: SectionChangeStatus;
  /** The section in the target revision; null when removed. */
  readonly targetSectionId: string | null;
  /** The section in the baseline revision; null when added. */
  readonly baselineSectionId: string | null;
  readonly kind: IndexedSection["kind"];
  readonly depth: number;
  readonly heading: string | null;
  /** UTF-8 bytes of the target section (baseline section when removed). */
  readonly bytes: number;
}

export interface SectionPairing {
  readonly changes: readonly SectionChange[];
  /** Target section ids whose content equals a baseline section's (content-neutral). */
  readonly unchangedTargetIds: ReadonlySet<string>;
  /** Pairs of sections that correspond across the two revisions, whether changed or not. */
  readonly pairs: ReadonlyMap<string, string>;
}

function groupByKey(sections: readonly IndexedSection[]): Map<string, IndexedSection[]> {
  const groups = new Map<string, IndexedSection[]>();
  for (const section of sections) {
    const group = groups.get(section.matchKey) ?? [];
    group.push(section);
    groups.set(section.matchKey, group);
  }
  return groups;
}

function change(
  status: SectionChangeStatus,
  target: IndexedSection | null,
  baseline: IndexedSection | null,
): SectionChange {
  const reference = (target ?? baseline) as IndexedSection;
  return Object.freeze({
    status,
    targetSectionId: target?.id ?? null,
    baselineSectionId: baseline?.id ?? null,
    kind: reference.kind,
    depth: reference.depth,
    heading: reference.heading,
    bytes: reference.bytes,
  });
}

/**
 * Pairs the sections of two revisions and lists what changed. Sections pair by continuity key (kind,
 * depth and folded heading text; content for heading-free blocks), first by equal content in order,
 * then in order when the remaining counts agree. When continuity cannot be established (for example a
 * duplicate heading was added or renamed), the remaining sections are reported conservatively as
 * removed and added, never as a guessed modification (note 11). Content comparisons use normalized
 * digests, so formatting-only changes such as a normalization commit report nothing (§9.3).
 *
 * Changes are ordered by target position, with removed sections after the target section that
 * follows them in the baseline.
 */
export function compareSectionIndexes(
  baseline: SectionIndex,
  target: SectionIndex,
): SectionPairing {
  const baseGroups = groupByKey(baseline.sections);
  const targetGroups = groupByKey(target.sections);
  const pairs = new Map<string, string>();
  const unchanged = new Set<string>();
  const modified = new Map<string, IndexedSection>();
  const removed = new Set<string>();
  const added = new Set<string>();

  for (const [key, targets] of targetGroups) {
    const bases = [...(baseGroups.get(key) ?? [])];
    const remainingTargets: IndexedSection[] = [];
    for (const section of targets) {
      const match = bases.findIndex((candidate) => candidate.digest === section.digest);
      if (match === -1) {
        remainingTargets.push(section);
        continue;
      }
      const [paired] = bases.splice(match, 1);
      pairs.set(section.id, (paired as IndexedSection).id);
      unchanged.add(section.id);
    }
    if (remainingTargets.length === bases.length) {
      remainingTargets.forEach((section, index) => {
        const paired = bases[index] as IndexedSection;
        pairs.set(section.id, paired.id);
        modified.set(section.id, paired);
      });
    } else {
      for (const section of remainingTargets) added.add(section.id);
      for (const section of bases) removed.add(section.id);
    }
  }
  for (const [key, bases] of baseGroups) {
    if (targetGroups.has(key)) continue;
    for (const section of bases) removed.add(section.id);
  }

  const baselinePairs = new Map([...pairs].map(([targetId, baseId]) => [baseId, targetId]));
  const targetPosition = new Map(target.sections.map((section, index) => [section.id, index]));
  const ordered: Array<{ readonly order: number; readonly change: SectionChange }> = [];
  target.sections.forEach((section, index) => {
    if (added.has(section.id))
      ordered.push({ order: index, change: change("added", section, null) });
    const base = modified.get(section.id);
    if (base) ordered.push({ order: index, change: change("modified", section, base) });
  });
  baseline.sections.forEach((section, index) => {
    if (!removed.has(section.id)) return;
    let order = target.sections.length;
    for (let next = index + 1; next < baseline.sections.length; next += 1) {
      const pairedTarget = baselinePairs.get((baseline.sections[next] as IndexedSection).id);
      if (pairedTarget !== undefined) {
        order = (targetPosition.get(pairedTarget) ?? target.sections.length) - 0.5;
        break;
      }
    }
    ordered.push({ order, change: change("removed", null, section) });
  });
  ordered.sort((a, b) => a.order - b.order);
  return {
    changes: ordered.map((entry) => entry.change),
    unchangedTargetIds: unchanged,
    pairs,
  };
}

export type ConflictSectionStatus =
  | "both_changed"
  | "saved_changed"
  | "draft_changed"
  | "unchanged";

export interface ConflictSection {
  readonly status: ConflictSectionStatus;
  readonly heading: string | null;
  readonly kind: IndexedSection["kind"];
  readonly depth: number;
  readonly savedSectionId: string | null;
  readonly draftSectionId: string | null;
  readonly baseSectionId: string | null;
}

/**
 * Three-way classification for conflict review (§9.2, document_history brief): for each section,
 * whether the saved version, the draft, or both changed it since the draft's base. Sections both
 * changed differently are the ones that need an explicit choice; unrelated sections are preserved.
 */
export function classifyConflict(
  base: SectionIndex,
  saved: SectionIndex,
  draft: SectionIndex,
): readonly ConflictSection[] {
  const savedPairing = compareSectionIndexes(base, saved);
  const draftPairing = compareSectionIndexes(base, draft);
  const savedByBase = new Map(
    [...savedPairing.pairs].map(([savedId, baseId]) => [baseId, savedId]),
  );
  const draftByBase = new Map(
    [...draftPairing.pairs].map(([draftId, baseId]) => [baseId, draftId]),
  );
  const savedById = new Map(saved.sections.map((section) => [section.id, section]));
  const draftById = new Map(draft.sections.map((section) => [section.id, section]));
  const results: ConflictSection[] = [];
  const seenDraft = new Set<string>();

  const digestOf = (index: Map<string, IndexedSection>, id: string | undefined) =>
    id === undefined ? null : (index.get(id)?.digest ?? null);

  for (const baseSection of base.sections) {
    const savedId = savedByBase.get(baseSection.id);
    const draftId = draftByBase.get(baseSection.id);
    if (draftId) seenDraft.add(draftId);
    const savedDigest = digestOf(savedById, savedId);
    const draftDigest = digestOf(draftById, draftId);
    const savedChanged = savedDigest !== baseSection.digest;
    const draftChanged = draftDigest !== baseSection.digest;
    let status: ConflictSectionStatus = "unchanged";
    if (savedChanged && draftChanged) {
      status = savedDigest === draftDigest ? "unchanged" : "both_changed";
    } else if (savedChanged) {
      status = "saved_changed";
    } else if (draftChanged) {
      status = "draft_changed";
    }
    results.push({
      status,
      heading: baseSection.heading,
      kind: baseSection.kind,
      depth: baseSection.depth,
      savedSectionId: savedId ?? null,
      draftSectionId: draftId ?? null,
      baseSectionId: baseSection.id,
    });
  }
  for (const section of saved.sections) {
    if (savedPairing.pairs.has(section.id)) continue;
    const twin = draft.sections.find(
      (candidate) =>
        !draftPairing.pairs.has(candidate.id) &&
        !seenDraft.has(candidate.id) &&
        candidate.matchKey === section.matchKey,
    );
    if (twin) seenDraft.add(twin.id);
    results.push({
      status:
        twin && twin.digest === section.digest
          ? "unchanged"
          : twin
            ? "both_changed"
            : "saved_changed",
      heading: section.heading,
      kind: section.kind,
      depth: section.depth,
      savedSectionId: section.id,
      draftSectionId: twin?.id ?? null,
      baseSectionId: null,
    });
  }
  for (const section of draft.sections) {
    if (draftPairing.pairs.has(section.id) || seenDraft.has(section.id)) continue;
    results.push({
      status: "draft_changed",
      heading: section.heading,
      kind: section.kind,
      depth: section.depth,
      savedSectionId: null,
      draftSectionId: section.id,
      baseSectionId: null,
    });
  }
  return results;
}
