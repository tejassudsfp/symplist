import {
  type AccountDataKey,
  decryptObject,
  encryptObject,
  inspectObjectEnvelope,
  type RandomOptions,
  zeroize,
} from "@symplist/crypto";
import type { SearchLimits } from "./limits.ts";
import { INDEX_FORMAT_VERSION } from "./normalize.ts";
import { SearchIndex, SearchIndexFormatError } from "./search-index.ts";

/** The object kind bound into the object envelope AAD (§4.2). */
export const SEARCH_INDEX_OBJECT_KIND = "search_index";

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** `u/<ownerId>/search/`: every index object of an account (§4.1). */
export function searchIndexObjectPrefix(ownerId: string): string {
  if (!uuidV7.test(ownerId)) throw new TypeError("Search index owners are UUIDv7 ids");
  return `u/${ownerId}/search/`;
}

/** The immutable key of one published generation: `u/<ownerId>/search/<generation>-<writeId>.idx`. */
export function searchIndexObjectKey(ownerId: string, generation: number, writeId: string): string {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new TypeError("Search index generations are positive integers");
  }
  if (!uuidV7.test(writeId)) throw new TypeError("Search index write ids are UUIDv7 ids");
  return `${searchIndexObjectPrefix(ownerId)}${generation}-${writeId}.idx`;
}

/** The generation and write id named by an index object key of an owner, or null for other keys. */
export function parseSearchIndexObjectKey(
  ownerId: string,
  key: string,
): { readonly generation: number; readonly writeId: string } | null {
  const prefix = searchIndexObjectPrefix(ownerId);
  if (!key.startsWith(prefix)) return null;
  const match = /^([1-9][0-9]{0,15})-([0-9a-f-]{36})\.idx$/.exec(key.slice(prefix.length));
  if (!match || !uuidV7.test(match[2] as string)) return null;
  const generation = Number(match[1]);
  return Number.isSafeInteger(generation) ? { generation, writeId: match[2] as string } : null;
}

/** The object id bound into the AAD: generation and write id, so objects cannot be swapped. */
function objectContext(ownerId: string, generation: number, writeId: string) {
  return {
    kind: SEARCH_INDEX_OBJECT_KIND,
    ownerId,
    objectId: `${generation}-${writeId}`,
    formatVersion: INDEX_FORMAT_VERSION,
  } as const;
}

export interface SealedSearchIndex {
  readonly key: string;
  readonly body: Uint8Array;
  /** Plaintext bytes before encryption, the unit of the decrypted-index cache bound. */
  readonly plaintextBytes: number;
}

/**
 * Serializes and encrypts an index as a `SYMO` object envelope under the owner's account data key
 * (§4.1, §10.1). The index is compacted first. Plaintext bytes are zeroized after sealing.
 */
export async function sealSearchIndex(
  accountKey: AccountDataKey,
  index: SearchIndex,
  meta: { readonly generation: number; readonly appliedThrough: number; readonly writeId: string },
  options?: RandomOptions,
): Promise<SealedSearchIndex> {
  if (accountKey.ownerId !== index.ownerId) {
    throw new TypeError("The account key belongs to a different owner than the index");
  }
  await index.compact();
  const key = searchIndexObjectKey(index.ownerId, meta.generation, meta.writeId);
  const plaintext = new TextEncoder().encode(
    JSON.stringify(
      index.toArtifact({ generation: meta.generation, appliedThrough: meta.appliedThrough }),
    ),
  );
  try {
    const body = encryptObject(
      accountKey,
      objectContext(index.ownerId, meta.generation, meta.writeId),
      plaintext,
      options,
    );
    return { key, body, plaintextBytes: plaintext.byteLength };
  } finally {
    zeroize(plaintext);
  }
}

export interface OpenedSearchIndex {
  readonly index: SearchIndex;
  readonly appliedThrough: number;
  readonly plaintextBytes: number;
}

/**
 * Decrypts and loads a published index. An envelope of another format version is detected from its
 * plaintext header without decrypting; a wrong key, owner, generation or write id, truncation,
 * tampering or an inconsistent artifact throws {@link SearchIndexFormatError}, never partial content.
 */
export function openSearchIndex(
  accountKey: AccountDataKey,
  body: Uint8Array,
  meta: { readonly ownerId: string; readonly generation: number; readonly writeId: string },
  limits?: Partial<SearchLimits>,
): OpenedSearchIndex {
  let header: ReturnType<typeof inspectObjectEnvelope>;
  try {
    header = inspectObjectEnvelope(body);
  } catch {
    throw new SearchIndexFormatError("malformed");
  }
  if (header.formatVersion !== INDEX_FORMAT_VERSION) {
    throw new SearchIndexFormatError("format_version");
  }
  let plaintext: Uint8Array;
  try {
    plaintext = decryptObject(
      accountKey,
      objectContext(meta.ownerId, meta.generation, meta.writeId),
      body,
    );
  } catch {
    throw new SearchIndexFormatError("decryption");
  }
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    } catch {
      throw new SearchIndexFormatError("malformed");
    }
    const index = SearchIndex.fromArtifact(
      parsed,
      { ownerId: meta.ownerId, generation: meta.generation },
      limits,
    );
    const appliedThrough = (parsed as { appliedThrough: number }).appliedThrough;
    return { index, appliedThrough, plaintextBytes: plaintext.byteLength };
  } finally {
    zeroize(plaintext);
  }
}
