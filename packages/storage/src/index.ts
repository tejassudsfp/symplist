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

/**
 * R2, loaded on demand.
 *
 * The import is dynamic and the function is async, and both are deliberate: `@aws-sdk/client-s3` and
 * its transitive tree are about 11MB of code that only a `DATA_DRIVER=d1` deployment ever calls. A
 * static import here would put them in the module graph of *every* consumer — including the api running
 * on one person's machine with no R2 account, which the Symplist desktop app ships (note 18,
 * `DEPLOYMENT=local`). A dependency that cannot be reached at runtime should not have to be installed.
 *
 * The concrete class and `r2ClientConfig` are reachable at `@symplist/storage/r2` for anything that
 * genuinely wants them — the live suite and the unit tests do.
 */
export async function createR2ObjectStore(
  options: import("./r2-object-store.ts").R2ObjectStoreOptions,
): Promise<import("./object-store.ts").ObjectStore> {
  const { R2ObjectStore } = await import("./r2-object-store.ts");
  return new R2ObjectStore(options);
}
