/*
 * `search_used` is a client-owned analytics event (decision C5.3, note 17). Search never loads or
 * talks to an analytics provider itself: it describes what happened in the allowlisted properties —
 * a surface, two booleans and a bucketed count, never a query, a title or a result — and the
 * analytics feature, which owns consent and the provider client, registers the reporter.
 */

export type SearchSurface = "command_palette" | "full_search" | "collection" | "document" | "chat";

export type ResultCountBucket = "0" | "1-5" | "6-20" | "21+";

export interface SearchUsedEvent {
  readonly surface: SearchSurface;
  readonly include_archive: boolean;
  readonly include_chat: boolean;
  readonly result_count: ResultCountBucket;
}

export function resultCountBucket(count: number): ResultCountBucket {
  if (count <= 0) return "0";
  if (count <= 5) return "1-5";
  if (count <= 20) return "6-20";
  return "21+";
}

type Reporter = (event: SearchUsedEvent) => void;

let reporter: Reporter | null = null;

/** The analytics feature registers the reporter once consent allows it; null turns reporting off. */
export function setSearchUsedReporter(next: Reporter | null): void {
  reporter = next;
}

/** Reports one completed search. Without a reporter nothing happens and nothing is queued. */
export function reportSearchUsed(event: SearchUsedEvent): void {
  reporter?.(event);
}
