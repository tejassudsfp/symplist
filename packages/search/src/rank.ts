import type {
  SearchArchiveMode,
  SearchCollection,
  SearchContentType,
  SearchMatchKind,
  SearchTitleMatchKind,
} from "@symplist/contracts";
import type { SearchResult } from "minisearch";
import { SEARCH_LIMITS, type SearchLimits } from "./limits.ts";
import {
  matchTerm,
  maxTypoEdits,
  phraseOccurrences,
  TEXT_MIN_PREFIX,
  TITLE_MIN_PREFIX,
  textRules,
  titleRules,
} from "./match.ts";
import { codePointLength, terms } from "./normalize.ts";
import type { ParsedQuery } from "./query.ts";
import type { SearchMessageRecord, SearchTaskRecord } from "./records.ts";
import { docKind, docMessageId, docTaskId, type SectionEntry } from "./search-index.ts";
import type { SearchLayer, SearchView } from "./view.ts";

/** What a search covers. Every filter is applied before ranking. */
export interface SearchRunRequest {
  readonly collections: ReadonlySet<SearchCollection>;
  readonly archive: SearchArchiveMode;
  readonly types: ReadonlySet<SearchContentType>;
  /** Restricts results to these tasks (an expanded task, a task-scoped grant, a deadline filter). */
  readonly taskIds: ReadonlySet<string> | null;
  /** Whether chat messages may be returned (requested, opted in and indexed). */
  readonly chat: boolean;
  readonly limits?: Partial<SearchLimits>;
}

export interface RankedSectionHit {
  readonly entry: SectionEntry;
  readonly match: "heading" | "body";
  readonly phrase: boolean;
  readonly score: number;
}

export interface RankedMessageHit {
  readonly message: SearchMessageRecord;
  readonly phrase: boolean;
  readonly score: number;
}

/** Every hit of one task, ranked. */
export interface RankedGroup {
  readonly task: SearchTaskRecord;
  readonly match: SearchMatchKind;
  readonly matchedAllTerms: boolean;
  readonly titleMatch: SearchTitleMatchKind | null;
  readonly sections: readonly RankedSectionHit[];
  readonly messages: readonly RankedMessageHit[];
}

export interface SearchRun {
  readonly groups: readonly RankedGroup[];
  /** Some candidates or groups were not evaluated because a limit was reached. */
  readonly capped: boolean;
  /** No result matched every term, so results match some terms. */
  readonly partialTerms: boolean;
}

/** Ranking order of match kinds (note 14). */
export const MATCH_KIND_RANK: Readonly<Record<SearchMatchKind, number>> = Object.freeze({
  title_exact: 0,
  title_prefix: 1,
  title_terms: 2,
  title_typo: 3,
  heading: 4,
  body: 5,
  chat: 6,
});

type Combine = "AND" | "OR";

interface Candidate {
  readonly taskId: string;
  readonly match: SearchMatchKind;
  readonly matchedCount: number;
  readonly score: number;
  phrase: boolean;
  readonly entry?: SectionEntry;
  readonly message?: SearchMessageRecord;
  readonly fieldTerms?: () => { readonly heading: string[]; readonly body: string[] };
}

/**
 * Scores within this ratio of each other count as similar, so recency decides between them; a clearly
 * better match is never buried by a more recent one (note 14).
 */
const SIMILAR_SCORE_RATIO = 1.25;

function scoreBucket(score: number): number {
  return score > 0 ? Math.floor(Math.log(score) / Math.log(SIMILAR_SCORE_RATIO)) : -1e9;
}

/** The title match kind of a title for a query, or null when it does not match under the rules. */
export function classifyTitle(
  query: ParsedQuery,
  title: string,
  combine: Combine = "AND",
): {
  readonly match: SearchTitleMatchKind;
  readonly matchedCount: number;
  readonly phrase: boolean;
} | null {
  const titleTerms = terms(title);
  if (titleTerms.length === 0 || query.sequence.length === 0) return null;
  for (const phrase of query.phrases) {
    if (phraseOccurrences(phrase, titleTerms).length === 0) return null;
  }
  const best = query.terms.map((term) => {
    let found: "exact" | "prefix" | "typo" | null = null;
    for (const candidate of titleTerms) {
      const match = matchTerm(term, candidate, titleRules);
      if (match === "exact") return "exact";
      if (match === "prefix" || (match === "typo" && found === null)) found = match;
    }
    return found;
  });
  const matchedCount = best.filter((match) => match !== null).length;
  if (matchedCount === 0) return null;
  if (combine === "AND" && matchedCount < query.terms.length) return null;
  const sequence = query.sequence;
  const phrase = sequence.length >= 2 && phraseOccurrences(sequence, titleTerms, true).length > 0;
  const onlyExactOrPrefix = best.every((match) => match === null || match !== "typo");
  if (matchedCount === query.terms.length) {
    if (
      titleTerms.length === sequence.length &&
      sequence.every((term, index) => titleTerms[index] === term)
    ) {
      return { match: "title_exact", matchedCount, phrase: true };
    }
    if (
      titleTerms.length >= sequence.length &&
      sequence.every((term, index) => {
        const candidate = titleTerms[index] as string;
        return index < sequence.length - 1 ? candidate === term : candidate.startsWith(term);
      })
    ) {
      return { match: "title_prefix", matchedCount, phrase: sequence.length >= 2 };
    }
  }
  return { match: onlyExactOrPrefix ? "title_terms" : "title_typo", matchedCount, phrase };
}

function allowTask(task: SearchTaskRecord | undefined, request: SearchRunRequest): boolean {
  if (!task) return false;
  if (request.archive === "exclude" && task.archived) return false;
  if (request.archive === "only" && !task.archived) return false;
  if (!request.collections.has(task.collection)) return false;
  if (request.taskIds && !request.taskIds.has(task.id)) return false;
  return true;
}

function matchedTermsOf(
  query: ParsedQuery,
  result: SearchResult,
  field?: "heading",
): { readonly count: number; readonly all: boolean } {
  const matchedFields = Object.entries(result.match);
  let count = 0;
  for (const term of query.terms) {
    const found = matchedFields.some(
      ([candidate, fields]) =>
        (field === undefined || fields.includes(field)) &&
        matchTerm(term, candidate, textRules) !== null,
    );
    if (found) count += 1;
  }
  return { count, all: count === query.terms.length };
}

function byScore(left: SearchResult, right: SearchResult): number {
  return right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function compareCandidates(left: Candidate, right: Candidate, combine: Combine): number {
  if (combine === "OR" && left.matchedCount !== right.matchedCount) {
    return right.matchedCount - left.matchedCount;
  }
  return (
    MATCH_KIND_RANK[left.match] - MATCH_KIND_RANK[right.match] ||
    Number(right.phrase) - Number(left.phrase) ||
    right.score - left.score
  );
}

interface Collected {
  readonly candidates: Candidate[];
  readonly capped: boolean;
}

function collect(
  view: SearchView,
  query: ParsedQuery,
  request: SearchRunRequest,
  combine: Combine,
  limits: SearchLimits,
): Collected {
  const candidates: Candidate[] = [];
  let capped = false;
  const layers = view.layers();

  const take = (results: SearchResult[]): SearchResult[] => {
    results.sort(byScore);
    if (results.length > limits.maxCandidates) {
      capped = true;
      return results.slice(0, limits.maxCandidates);
    }
    return results;
  };

  for (const layer of layers) {
    if (request.types.has("tasks")) collectTitles(layer);
    if (request.types.has("documents")) collectSections(layer);
    if (request.types.has("chat") && request.chat) collectMessages(layer);
  }
  return { candidates, capped };

  function collectTitles(layer: SearchLayer): void {
    const results = take(
      layer.index.query(query.terms, {
        fields: ["title"],
        combineWith: combine,
        prefix: (term) => codePointLength(term) >= TITLE_MIN_PREFIX,
        fuzzy: (term) => maxTypoEdits(term) || false,
        filter: (result) =>
          docKind(result.id) === "title" &&
          layer.visible(result.id) &&
          allowTask(view.task(docTaskId(result.id)), request),
      }),
    );
    for (const result of results) {
      const taskId = docTaskId(result.id);
      const task = view.task(taskId) as SearchTaskRecord;
      const classified = classifyTitle(query, task.title, combine);
      if (!classified) continue;
      candidates.push({
        taskId,
        match: classified.match,
        matchedCount: classified.matchedCount,
        score: result.score,
        phrase: classified.phrase,
      });
    }
  }

  function collectSections(layer: SearchLayer): void {
    const results = take(
      layer.index.query(query.terms, {
        fields: ["heading", "body"],
        combineWith: combine,
        prefix: (term) => codePointLength(term) >= TEXT_MIN_PREFIX,
        fuzzy: false,
        filter: (result) =>
          docKind(result.id) === "section" &&
          layer.visible(result.id) &&
          allowTask(view.task(docTaskId(result.id)), request),
      }),
    );
    for (const result of results) {
      const entry = layer.index.section(result.id);
      if (!entry) continue;
      const all = matchedTermsOf(query, result);
      if (all.count === 0 || (combine === "AND" && !all.all)) continue;
      const heading = matchedTermsOf(query, result, "heading");
      let cached: { heading: string[]; body: string[] } | undefined;
      candidates.push({
        taskId: entry.taskId,
        match: heading.count === all.count ? "heading" : "body",
        matchedCount: all.count,
        score: result.score,
        phrase: false,
        entry,
        fieldTerms: () => {
          cached ??= { heading: terms(entry.heading ?? ""), body: terms(entry.text) };
          return cached;
        },
      });
    }
  }

  function collectMessages(layer: SearchLayer): void {
    const results = take(
      layer.index.query(query.terms, {
        fields: ["chat"],
        combineWith: combine,
        prefix: (term) => codePointLength(term) >= TEXT_MIN_PREFIX,
        fuzzy: false,
        filter: (result) => {
          if (docKind(result.id) !== "message" || !layer.visible(result.id)) return false;
          const message = layer.index.message(docMessageId(result.id));
          return message !== undefined && allowTask(view.task(message.taskId), request);
        },
      }),
    );
    for (const result of results) {
      const message = layer.index.message(docMessageId(result.id));
      if (!message) continue;
      const all = matchedTermsOf(query, result);
      if (all.count === 0 || (combine === "AND" && !all.all)) continue;
      let cached: { heading: string[]; body: string[] } | undefined;
      candidates.push({
        taskId: message.taskId,
        match: "chat",
        matchedCount: all.count,
        score: result.score,
        phrase: false,
        message,
        fieldTerms: () => {
          cached ??= { heading: [], body: terms(message.text) };
          return cached;
        },
      });
    }
  }
}

/** Applies quoted phrases (a filter) and unquoted multiword adjacency (a bonus) to text candidates. */
function applyPhrases(
  candidates: Candidate[],
  query: ParsedQuery,
  combine: Combine,
  limits: SearchLimits,
): { readonly kept: Candidate[]; readonly capped: boolean } {
  let capped = false;
  let kept = candidates;
  if (query.phrases.length > 0) {
    let checks = 0;
    kept = [];
    for (const candidate of candidates) {
      if (!candidate.fieldTerms) {
        kept.push(candidate);
        continue;
      }
      if (checks >= limits.maxPhraseChecks) {
        capped = true;
        continue;
      }
      checks += 1;
      const fields = candidate.fieldTerms();
      const satisfied = query.phrases.every(
        (phrase) =>
          phraseOccurrences(phrase, fields.heading).length > 0 ||
          phraseOccurrences(phrase, fields.body).length > 0,
      );
      if (satisfied) {
        candidate.phrase = true;
        kept.push(candidate);
      }
    }
  } else if (query.sequence.length >= 2) {
    const ordered = kept
      .filter((candidate) => candidate.fieldTerms)
      .sort((left, right) => compareCandidates(left, right, combine))
      .slice(0, limits.maxAdjacencyChecks);
    for (const candidate of ordered) {
      const fields = (candidate.fieldTerms as NonNullable<Candidate["fieldTerms"]>)();
      candidate.phrase =
        phraseOccurrences(query.sequence, fields.heading, true).length > 0 ||
        phraseOccurrences(query.sequence, fields.body, true).length > 0;
    }
  }
  return { kept, capped };
}

interface GroupBuilder {
  readonly task: SearchTaskRecord;
  best: Candidate;
  title: Candidate | null;
  readonly sections: Map<number, Candidate>;
  readonly messages: Candidate[];
}

function rank(
  view: SearchView,
  query: ParsedQuery,
  request: SearchRunRequest,
  combine: Combine,
  limits: SearchLimits,
): SearchRun {
  const collected = collect(view, query, request, combine, limits);
  const phrased = applyPhrases(collected.candidates, query, combine, limits);
  const groups = new Map<string, GroupBuilder>();
  for (const candidate of phrased.kept) {
    const task = view.task(candidate.taskId);
    if (!task) continue;
    let group = groups.get(candidate.taskId);
    if (!group) {
      group = { task, best: candidate, title: null, sections: new Map(), messages: [] };
      groups.set(candidate.taskId, group);
    } else if (compareCandidates(candidate, group.best, combine) < 0) {
      group.best = candidate;
    }
    if (candidate.entry) {
      const existing = group.sections.get(candidate.entry.ordinal);
      if (
        !existing ||
        compareCandidates(candidate, existing, combine) < 0 ||
        (compareCandidates(candidate, existing, combine) === 0 &&
          candidate.entry.chunk < (existing.entry as SectionEntry).chunk)
      ) {
        group.sections.set(candidate.entry.ordinal, candidate);
      }
    } else if (candidate.message) {
      group.messages.push(candidate);
    } else if (!group.title || compareCandidates(candidate, group.title, combine) < 0) {
      group.title = candidate;
    }
  }

  const ordered = [...groups.values()].sort((left, right) => {
    const a = left.best;
    const b = right.best;
    if (combine === "OR" && a.matchedCount !== b.matchedCount)
      return b.matchedCount - a.matchedCount;
    return (
      MATCH_KIND_RANK[a.match] - MATCH_KIND_RANK[b.match] ||
      Number(b.phrase) - Number(a.phrase) ||
      scoreBucket(b.score) - scoreBucket(a.score) ||
      right.task.updatedAt - left.task.updatedAt ||
      b.score - a.score ||
      (left.task.id < right.task.id ? -1 : left.task.id > right.task.id ? 1 : 0)
    );
  });
  const capped = collected.capped || phrased.capped || ordered.length > limits.maxGroups;
  const termCount = query.terms.length;
  return {
    capped,
    partialTerms: combine === "OR",
    groups: ordered.slice(0, limits.maxGroups).map((group) => ({
      task: group.task,
      match: group.best.match,
      matchedAllTerms: group.best.matchedCount === termCount,
      titleMatch: (group.title?.match as SearchTitleMatchKind | undefined) ?? null,
      sections: [...group.sections.values()]
        .sort(
          (left, right) =>
            compareCandidates(left, right, combine) ||
            (left.entry as SectionEntry).ordinal - (right.entry as SectionEntry).ordinal,
        )
        .map((candidate) => ({
          entry: candidate.entry as SectionEntry,
          match: candidate.match as "heading" | "body",
          phrase: candidate.phrase,
          score: candidate.score,
        })),
      messages: group.messages
        .sort(
          (left, right) =>
            compareCandidates(left, right, combine) ||
            (right.message as SearchMessageRecord).createdAt -
              (left.message as SearchMessageRecord).createdAt ||
            ((left.message as SearchMessageRecord).id < (right.message as SearchMessageRecord).id
              ? -1
              : 1),
        )
        .map((candidate) => ({
          message: candidate.message as SearchMessageRecord,
          phrase: candidate.phrase,
          score: candidate.score,
        })),
    })),
  };
}

/**
 * Runs a query over a view and returns every task group in rank order (note 14): exact title, title
 * prefix, title terms, bounded title typos, headings, bodies, then chat; within a kind quoted and
 * adjacent phrases first, then clearly better scores, then the most recently updated task, then a
 * stable id order. Multiple section hits of a task collapse into its group. Terms combine with AND;
 * when nothing matches every term of a multiword query without quoted phrases, the query falls back to
 * results matching some terms, ranked by how many they match.
 */
export function runSearch(
  view: SearchView,
  query: ParsedQuery,
  request: SearchRunRequest,
): SearchRun {
  const limits = { ...SEARCH_LIMITS, ...request.limits };
  if (query.terms.length === 0 || request.types.size === 0) {
    return { groups: [], capped: false, partialTerms: false };
  }
  const strict = rank(view, query, request, "AND", limits);
  if (strict.groups.length > 0 || query.terms.length < 2 || query.phrases.length > 0) {
    return strict;
  }
  const loose = rank(view, query, request, "OR", limits);
  return loose.groups.length > 0 ? loose : strict;
}
