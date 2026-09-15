import { Buffer } from "node:buffer";
import { StorageError } from "./errors.ts";
import type { ListObjectsInput, ObjectMetadata } from "./object-store.ts";

/** Limits shared by every ObjectStore implementation (§1 R2 rules, R2 platform limits). */
export const OBJECT_STORE_LIMITS = Object.freeze({
  /** R2 key limit in UTF-8 bytes. */
  maxKeyBytes: 1024,
  /** R2 user metadata limit (keys plus values) in bytes. */
  maxMetadataBytes: 8192,
  /** Default cap on object bodies, for writes and for reads. */
  defaultMaxBodyBytes: 100 * 1024 * 1024,
  /** ListObjectsV2 page size cap. */
  maxListLimit: 1000,
});

const segment = "[A-Za-z0-9._~-]+";
const keyPattern = new RegExp(`^${segment}(?:/${segment})*$`);
const prefixPattern = new RegExp(`^${segment}(?:/${segment})*/?$`);
const metadataKeyPattern = /^[a-z0-9][a-z0-9-]*$/;
const metadataValuePattern = /^[\x20-\x7e]*$/;

function hasDotSegment(value: string): boolean {
  return value.split("/").some((part) => part === "." || part === "..");
}

/**
 * Keys are opaque, owner-prefixed paths such as `u/<ownerId>/docs/<taskId>/<commitId>.md.sym` (§4.1):
 * ASCII letters, digits, `.`, `_`, `~` and `-` in non-empty `/`-separated segments, never `.` or `..`,
 * at most 1024 bytes. The same rule on every store keeps the local store free of path traversal.
 */
export function assertObjectKey(key: string): string {
  if (
    typeof key !== "string" ||
    !keyPattern.test(key) ||
    hasDotSegment(key) ||
    Buffer.byteLength(key, "utf8") > OBJECT_STORE_LIMITS.maxKeyBytes
  ) {
    throw new StorageError("storage.invalid_key", "Invalid object key");
  }
  return key;
}

/** A non-empty list prefix following the key rules; it may end with `/`. */
export function assertPrefix(prefix: string): string {
  if (
    typeof prefix !== "string" ||
    !prefixPattern.test(prefix) ||
    hasDotSegment(prefix.replace(/\/$/, "")) ||
    Buffer.byteLength(prefix, "utf8") > OBJECT_STORE_LIMITS.maxKeyBytes
  ) {
    throw new StorageError("storage.invalid_key", "Invalid list prefix");
  }
  return prefix;
}

/** Metadata keys are lower-case (S3 lower-cases them); values are printable ASCII header text. */
export function assertMetadata(metadata: ObjectMetadata | undefined): ObjectMetadata {
  if (metadata === undefined) return {};
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new StorageError("storage.invalid_metadata", "Metadata must be a string record");
  }
  let bytes = 0;
  for (const [key, value] of Object.entries(metadata)) {
    if (
      !metadataKeyPattern.test(key) ||
      typeof value !== "string" ||
      !metadataValuePattern.test(value)
    ) {
      throw new StorageError("storage.invalid_metadata", "Invalid metadata entry");
    }
    bytes += key.length + value.length;
  }
  if (bytes > OBJECT_STORE_LIMITS.maxMetadataBytes) {
    throw new StorageError("storage.invalid_metadata", "Metadata exceeds 8192 bytes");
  }
  return metadata;
}

export function assertBody(body: Uint8Array, maxBodyBytes: number): Uint8Array {
  if (!(body instanceof Uint8Array)) {
    throw new StorageError("storage.rejected", "Object body must be a Uint8Array");
  }
  if (body.byteLength > maxBodyBytes) {
    throw new StorageError("storage.too_large", "Object body exceeds the size limit");
  }
  return body;
}

export function listLimit(input: ListObjectsInput): number {
  const limit = input.limit ?? OBJECT_STORE_LIMITS.maxListLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > OBJECT_STORE_LIMITS.maxListLimit) {
    throw new StorageError("storage.rejected", "List limit must be an integer from 1 to 1000");
  }
  return limit;
}

/** The `write-id` metadata entry checked after a conditional put finds an existing object (§1). */
export const WRITE_ID_METADATA_KEY = "write-id";
