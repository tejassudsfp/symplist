/** Corpus, candidate and output bounds; tests lower them to exercise each limit. */
export interface SearchLimits {
  readonly maxCorpusChars: number;
  readonly maxDocumentChars: number;
  readonly maxSectionsPerDocument: number;
  readonly maxMessageChars: number;
  readonly maxTitleChars: number;
  readonly chunkChars: number;
  readonly chunkOverlapChars: number;
  readonly maxCandidates: number;
  readonly maxPhraseChecks: number;
  readonly maxAdjacencyChecks: number;
  readonly maxGroups: number;
  readonly snippetChars: number;
  readonly maxHighlights: number;
}

/**
 * Explicit corpus, cache and output bounds for search (note 14: "Establish explicit corpus/cache/output
 * size limits"). Every value here is enforced by code in this package or `core/search`, and tests pin
 * the behaviour at each limit.
 */
export const SEARCH_LIMITS: SearchLimits = Object.freeze({
  /** Indexed text across one account (titles, section text, messages), in UTF-16 code units. */
  maxCorpusChars: 16_000_000,
  /** Section text indexed per document; the rest of a larger document is not searchable. */
  maxDocumentChars: 1_048_576,
  /** Sections indexed per document. */
  maxSectionsPerDocument: 2_000,
  /** Text indexed per chat message. */
  maxMessageChars: 8_000,
  /** Task titles longer than this are indexed only up to it. */
  maxTitleChars: 4_096,
  /** Long section bodies are indexed as overlapping chunks of about this many characters. */
  chunkChars: 1_200,
  /** Characters shared by consecutive chunks, so phrases across a boundary still match. */
  chunkOverlapChars: 80,
  /** Candidates of one kind (titles, sections, messages) evaluated per search. */
  maxCandidates: 2_000,
  /** Candidates whose text is tokenized to verify quoted phrases per search. */
  maxPhraseChecks: 500,
  /** Top candidates checked for phrase adjacency of unquoted multiword queries. */
  maxAdjacencyChecks: 200,
  /** Task groups one search ranks; later groups are dropped and the response says so. */
  maxGroups: 500,
  /** Snippet window length before whitespace collapsing. */
  snippetChars: 180,
  /** Highlight ranges returned for one text. */
  maxHighlights: 16,
});
