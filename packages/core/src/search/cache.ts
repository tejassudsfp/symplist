import type { SearchIndex, SearchView } from "@symplist/search";
import { type SearchLog, silentSearchLog } from "./log.ts";

/** The default bound on decrypted index bytes held by one process (§10.1). */
export const DEFAULT_SEARCH_CACHE_BYTES = 128 * 1024 * 1024;

/** How long an owner's decrypted index may stay unused before it is dropped. */
export const DEFAULT_SEARCH_CACHE_IDLE_MS = 10 * 60_000;

/** Views (published index plus one overlay) kept per owner, for pinned cursors. */
const VIEWS_PER_OWNER = 2;

export interface CachedSearchView {
  readonly view: SearchView;
  /** Every pending change is applied. */
  readonly complete: boolean;
  readonly bytes: number;
}

interface OwnerEntry {
  readonly ownerId: string;
  /** The access generation of the request that loaded the entry (§3.3). */
  readonly accessGeneration: number;
  /** The published generation held, or 0 with no published index. */
  readonly generation: number;
  readonly base: SearchIndex | null;
  readonly baseBytes: number;
  readonly views: Map<string, CachedSearchView>;
  lastUsedAt: number;
}

export type SearchCacheEvictionReason =
  | "capacity"
  | "idle"
  | "access_changed"
  | "restricted"
  | "deleted"
  | "generation";

export interface SearchIndexCacheOptions {
  readonly maxBytes?: number;
  readonly idleMs?: number;
  readonly now: () => number;
  readonly log?: SearchLog;
}

export interface SearchIndexCacheStats {
  readonly owners: number;
  readonly bytes: number;
  readonly maxBytes: number;
  readonly evictions: number;
}

/**
 * Decrypted search indexes in api memory, least recently used first out, bounded by total decrypted
 * bytes (§3.3, §10.1). Entries remember the requester's access generation, so an entry loaded before
 * an access change is never served after it on any instance; restriction and deletion evict the owner
 * at once, and idle entries are dropped. Per-index sizes are logged when entries enter and leave.
 */
export class SearchIndexCache {
  private readonly entries = new Map<string, OwnerEntry>();
  private readonly maxBytes: number;
  private readonly idleMs: number;
  private readonly log: SearchLog;
  private totalBytes = 0;
  private evictionCount = 0;

  constructor(private readonly options: SearchIndexCacheOptions) {
    this.maxBytes = options.maxBytes ?? DEFAULT_SEARCH_CACHE_BYTES;
    this.idleMs = options.idleMs ?? DEFAULT_SEARCH_CACHE_IDLE_MS;
    this.log = options.log ?? silentSearchLog;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new RangeError("maxBytes must be a positive integer");
    }
  }

  /**
   * The owner's entry for a published generation, or undefined. An entry loaded under a different access
   * generation is evicted, so the caller reloads under the current one.
   */
  base(
    ownerId: string,
    generation: number,
    accessGeneration: number,
  ): { readonly base: SearchIndex | null } | undefined {
    const entry = this.entries.get(ownerId);
    if (!entry) return undefined;
    if (entry.accessGeneration !== accessGeneration) {
      this.evictOwner(ownerId, "access_changed");
      return undefined;
    }
    if (entry.generation !== generation) return undefined;
    this.touch(entry);
    return { base: entry.base };
  }

  /** Stores the owner's published index (or null while rebuilding), replacing older generations. */
  setBase(
    ownerId: string,
    input: {
      readonly accessGeneration: number;
      readonly generation: number;
      readonly base: SearchIndex | null;
      readonly bytes: number;
    },
  ): boolean {
    const previous = this.entries.get(ownerId);
    if (previous) this.remove(previous, "generation");
    if (input.bytes > this.maxBytes) {
      this.log.warn("search.cache_entry_too_large", {
        ownerId,
        generation: input.generation,
        byteCount: input.bytes,
      });
      return false;
    }
    const entry: OwnerEntry = {
      ownerId,
      accessGeneration: input.accessGeneration,
      generation: input.generation,
      base: input.base,
      baseBytes: input.bytes,
      views: new Map(),
      lastUsedAt: this.options.now(),
    };
    this.entries.set(ownerId, entry);
    this.totalBytes += input.bytes;
    this.log.info("search.cache_entry_added", {
      ownerId,
      generation: input.generation,
      byteCount: input.bytes,
      totalBytes: this.totalBytes,
    });
    this.shrink(ownerId);
    return true;
  }

  view(ownerId: string, key: string): CachedSearchView | undefined {
    const entry = this.entries.get(ownerId);
    const view = entry?.views.get(key);
    if (entry && view) this.touch(entry);
    return view;
  }

  /** Stores a view of the owner's current entry; the oldest view beyond two is dropped. */
  setView(ownerId: string, key: string, view: CachedSearchView): void {
    const entry = this.entries.get(ownerId);
    if (!entry) return;
    const previous = entry.views.get(key);
    if (previous) {
      entry.views.delete(key);
      this.totalBytes -= previous.bytes;
    }
    entry.views.set(key, view);
    this.totalBytes += view.bytes;
    while (entry.views.size > VIEWS_PER_OWNER) {
      const oldest = entry.views.keys().next().value as string;
      this.totalBytes -= (entry.views.get(oldest) as CachedSearchView).bytes;
      entry.views.delete(oldest);
    }
    this.touch(entry);
    this.shrink(ownerId);
  }

  /** Drops everything held for an owner. Returns whether anything was held. */
  evictOwner(ownerId: string, reason: SearchCacheEvictionReason): boolean {
    const entry = this.entries.get(ownerId);
    if (!entry) return false;
    this.remove(entry, reason);
    return true;
  }

  /** Drops entries unused for longer than the idle period; returns how many. */
  evictIdle(): number {
    const cutoff = this.options.now() - this.idleMs;
    let count = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.lastUsedAt <= cutoff) {
        this.remove(entry, "idle");
        count += 1;
      }
    }
    return count;
  }

  has(ownerId: string): boolean {
    return this.entries.has(ownerId);
  }

  stats(): SearchIndexCacheStats {
    return Object.freeze({
      owners: this.entries.size,
      bytes: this.totalBytes,
      maxBytes: this.maxBytes,
      evictions: this.evictionCount,
    });
  }

  clear(): void {
    for (const entry of [...this.entries.values()]) this.remove(entry, "capacity");
  }

  private touch(entry: OwnerEntry): void {
    entry.lastUsedAt = this.options.now();
    // Map order is the LRU order: most recently used last.
    this.entries.delete(entry.ownerId);
    this.entries.set(entry.ownerId, entry);
  }

  private shrink(protectedOwner: string): void {
    for (const entry of [...this.entries.values()]) {
      if (this.totalBytes <= this.maxBytes) return;
      if (entry.ownerId === protectedOwner) continue;
      this.remove(entry, "capacity");
    }
    // Only the protected owner is left and still too large: drop its overlays, then the owner.
    const own = this.entries.get(protectedOwner);
    if (own && this.totalBytes > this.maxBytes) this.remove(own, "capacity");
  }

  private remove(entry: OwnerEntry, reason: SearchCacheEvictionReason): void {
    if (this.entries.get(entry.ownerId) !== entry) return;
    this.entries.delete(entry.ownerId);
    let bytes = entry.baseBytes;
    for (const view of entry.views.values()) bytes += view.bytes;
    this.totalBytes -= bytes;
    if (reason !== "generation") this.evictionCount += 1;
    this.log.info("search.cache_entry_evicted", {
      ownerId: entry.ownerId,
      generation: entry.generation,
      byteCount: bytes,
      reason,
    });
  }
}
