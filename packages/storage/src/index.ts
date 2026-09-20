export type { StorageErrorCode } from "./errors.ts";
export { isStorageError, StorageError } from "./errors.ts";
export {
  assertMetadata,
  assertObjectKey,
  assertPrefix,
  OBJECT_STORE_LIMITS,
  WRITE_ID_METADATA_KEY,
} from "./keys.ts";
export type { LocalObjectStoreOptions } from "./local-object-store.ts";
export {
  createLocalObjectStore,
  DEFAULT_LOCAL_OBJECTS_DIR,
  LocalObjectStore,
} from "./local-object-store.ts";
export type * from "./object-store.ts";
export type { R2Jurisdiction, R2ObjectStoreOptions } from "./r2-object-store.ts";
export { createR2ObjectStore, R2ObjectStore, r2ClientConfig } from "./r2-object-store.ts";
