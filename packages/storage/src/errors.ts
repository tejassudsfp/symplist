/** Stable object storage error codes. Messages never contain keys, bodies, metadata or credentials. */
export type StorageErrorCode =
  | "storage.invalid_key"
  | "storage.invalid_metadata"
  | "storage.invalid_cursor"
  | "storage.too_large"
  /** A conditional write raced another writer without a stored object to compare (R2 409). */
  | "storage.conflict"
  | "storage.unauthorized"
  /** R2 answered 429 (for example more than one write per second to one key). */
  | "storage.rate_limited"
  | "storage.unavailable"
  | "storage.rejected"
  /** The local filesystem store refuses `NODE_ENV=production` (decision A7). */
  | "storage.production_refused"
  | "storage.config_invalid";

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  /** HTTP status from R2, when the error came from a response. */
  readonly httpStatus: number | undefined;

  constructor(code: StorageErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function isStorageError(value: unknown, code?: StorageErrorCode): value is StorageError {
  return value instanceof StorageError && (code === undefined || value.code === code);
}
