import { createHash } from "node:crypto";
import type {
  SearchArchiveMode,
  SearchCollection,
  SearchContentType,
  SearchDeadlineFilter,
} from "@symplist/contracts";
import type { ParsedQuery } from "@symplist/search";
import { SearchServiceError } from "./errors.ts";

/**
 * Opaque search cursors (§10.1: cursors pin `indexGeneration`). A cursor names the index generation and
 * the highest pending intent the page was ranked over, the offset of the next page, and a digest of
 * the normalized query and scope, so it cannot be replayed against another query.
 */
export interface SearchCursor {
  readonly generation: number;
  readonly pendingThrough: number;
  readonly offset: number;
  readonly digest: string;
}

/** The digest of what a result list depends on: normalized terms, phrases and the effective scope. */
export function searchDigest(input: {
  readonly query: ParsedQuery;
  readonly collections: readonly SearchCollection[];
  readonly archive: SearchArchiveMode;
  readonly types: readonly SearchContentType[];
  readonly taskId: string | null;
  readonly deadline: SearchDeadlineFilter | null;
  readonly chat: boolean;
}): string {
  const canonical = JSON.stringify([
    input.query.sequence,
    input.query.phrases,
    [...input.collections].sort(),
    input.archive,
    [...input.types].sort(),
    input.taskId,
    input.deadline,
    input.chat,
  ]);
  return createHash("sha256").update(canonical).digest("base64url").slice(0, 22);
}

const maxOffset = 100_000;

export function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(
    JSON.stringify([1, cursor.generation, cursor.pendingThrough, cursor.offset, cursor.digest]),
    "utf8",
  ).toString("base64url");
}

/** Decodes a cursor, throwing `search.cursor_invalid` for anything not produced by {@link encodeSearchCursor}. */
export function decodeSearchCursor(text: string): SearchCursor {
  let value: unknown;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(text)) throw new Error("format");
    value = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    throw new SearchServiceError("search.cursor_invalid");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 5 ||
    value[0] !== 1 ||
    !Number.isSafeInteger(value[1]) ||
    value[1] < 0 ||
    !Number.isSafeInteger(value[2]) ||
    value[2] < 0 ||
    !Number.isSafeInteger(value[3]) ||
    value[3] < 1 ||
    value[3] > maxOffset ||
    typeof value[4] !== "string" ||
    !/^[A-Za-z0-9_-]{22}$/.test(value[4])
  ) {
    throw new SearchServiceError("search.cursor_invalid");
  }
  return {
    generation: value[1] as number,
    pendingThrough: value[2] as number,
    offset: value[3] as number,
    digest: value[4] as string,
  };
}
