/**
 * Per-user MiniSearch index (§10.1): normalization and tokenization, index build and mutation,
 * serialization inside `SYMO` object envelopes, ranking, grouping, and deterministic safe snippets.
 * Server-side only: it encrypts with `node:crypto` through `@symplist/crypto`.
 */
export * from "./chunk.ts";
export * from "./envelope.ts";
export * from "./limits.ts";
export * from "./match.ts";
export * from "./normalize.ts";
export * from "./query.ts";
export * from "./rank.ts";
export * from "./records.ts";
export * from "./search-index.ts";
export * from "./snippet.ts";
export * from "./view.ts";
