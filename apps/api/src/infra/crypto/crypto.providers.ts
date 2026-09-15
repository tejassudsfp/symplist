import type { Provider } from "@nestjs/common";
import { apiSecretFamilies } from "@symplist/config/api";
import {
  assertArgon2Available,
  createKeyProvider,
  type KeyFamily,
  type KeyFamilySources,
  type ManagedKeyProvider,
} from "@symplist/crypto";
import { API_CONFIG, type ApiConfig } from "../config/api-config.ts";

/** Injection token for the api's {@link ManagedKeyProvider} (decision A4). */
export const KEY_PROVIDER = "symplist:KEY_PROVIDER";

/**
 * Builds the environment key provider from the validated secret families, requiring every family
 * the api holds (§4.5). Startup fails when `crypto.argon2` is missing (§4.3).
 */
export function createApiKeyProvider(config: ApiConfig): ManagedKeyProvider {
  assertArgon2Available();
  const sources: { -readonly [F in KeyFamily]?: KeyFamilySources[F] } = {};
  for (const family of apiSecretFamilies) {
    sources[family] = config[family];
  }
  return createKeyProvider(sources, { required: apiSecretFamilies });
}

export const cryptoProviders: Provider[] = [
  { provide: KEY_PROVIDER, useFactory: createApiKeyProvider, inject: [API_CONFIG] },
];
