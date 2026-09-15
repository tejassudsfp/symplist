/** Metadata stored with an object, for example the `write-id` checked after a conditional put (§1). */
export type ObjectMetadata = Readonly<Record<string, string>>;

export interface PutObjectInput {
  /** Owner-prefixed opaque key such as `u/<ownerId>/docs/<taskId>/<commitId>.md.sym` (§4.1). */
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType?: string;
  /** `*` writes only when no object exists at the key (R2 `If-None-Match: *`). */
  readonly ifNoneMatch?: "*";
  readonly metadata?: ObjectMetadata;
}

/** `exists` means a conditional put found an object already stored at the key (HTTP 412). */
export type PutObjectResult =
  | { readonly status: "created"; readonly etag?: string }
  | { readonly status: "exists" };

export interface ObjectHead {
  readonly key: string;
  readonly size: number;
  readonly etag?: string;
  readonly uploadedAt?: number;
  readonly metadata: ObjectMetadata;
}

export interface StoredObject extends ObjectHead {
  readonly body: Uint8Array;
}

export interface ListObjectsInput {
  readonly prefix: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListObjectsResult {
  readonly objects: readonly ObjectHead[];
  /** Present when more objects remain under the prefix. */
  readonly cursor?: string;
}

/** Object storage for R2 and the local filesystem stand-in (§1, §2). */
export interface ObjectStore {
  put(input: PutObjectInput): Promise<PutObjectResult>;
  /** Returns null when no object exists at the key. */
  get(key: string): Promise<StoredObject | null>;
  /** Returns null when no object exists at the key. */
  head(key: string): Promise<ObjectHead | null>;
  /** Deletes one key; R2 uses one `DeleteObject` per key and never `DeleteObjects`. */
  delete(key: string): Promise<void>;
  list(input: ListObjectsInput): Promise<ListObjectsResult>;
}
