import type { Provider } from "@nestjs/common";
import { localDataPaths } from "@symplist/config";
import { createLocalObjectStore, createR2ObjectStore, type ObjectStore } from "@symplist/storage";
import { API_CONFIG, type ApiConfig } from "../config/api-config.ts";
import { LOCAL_DATA_DIR } from "../db/db.providers.ts";

/** Injection token for the api's {@link ObjectStore} (R2, or the local filesystem store). */
export const OBJECT_STORE = "symplist:OBJECT_STORE";

/** Selects R2 for `DATA_DRIVER=d1` and the local store under the data directory otherwise (§16.1). */
export function createApiObjectStore(config: ApiConfig, localDataDir: string): ObjectStore {
  if (config.DATA_DRIVER === "d1") {
    const { CLOUDFLARE_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = config;
    if (!CLOUDFLARE_ACCOUNT_ID || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
      throw new Error("DATA_DRIVER=d1 requires the R2 bucket and credentials");
    }
    return createR2ObjectStore({
      accountId: CLOUDFLARE_ACCOUNT_ID,
      bucket: R2_BUCKET,
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    });
  }
  return createLocalObjectStore({
    root: localDataPaths(localDataDir).objects,
    env: { NODE_ENV: config.NODE_ENV },
  });
}

export const storageProviders: Provider[] = [
  {
    provide: OBJECT_STORE,
    useFactory: createApiObjectStore,
    inject: [API_CONFIG, LOCAL_DATA_DIR],
  },
];
