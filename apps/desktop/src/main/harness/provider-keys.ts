/**
 * The device's model provider keys, read out of the keychain.
 *
 * Note 18 made this a property of the architecture rather than of a route: "model keys live on the
 * device that makes the call. The cloud never holds one and never returns one." `SecretStore` is
 * where that lands — `safeStorage` derives its key from the macOS Keychain and the ciphertext sits in
 * a mode-600 file under `userData`, so a key survives a restart without ever existing as plaintext on
 * disk.
 *
 * This module is the *reader*. Writing a key is Settings → Models, which is the renderer's side of
 * the keychain lane; the names below are the contract between the two, which is why they are declared
 * here and exported rather than spelled inline at either end.
 *
 * The honest limit, again, because it belongs next to the code and not only in the product: the agent
 * has a shell and runs as the user. The keychain protects a key at rest across restarts. It does not
 * protect it from the agent, and dsh's own credentials documentation says the same of its file
 * permissions — they "cannot keep provider keys away from its own agent".
 */
import type { MainLog } from "../log.ts";
import type { AssistantProvider } from "./profile.ts";

/** The `SecretStore` surface this reader uses. Narrow, so a test needs no `safeStorage`. */
export interface ProviderKeyStore {
  isAvailable(): boolean;
  read(name: string): string | null;
}

/**
 * The stored name of each provider's key. Stable, because renaming one silently loses the user's key:
 * the old ciphertext stays on disk under a name nothing reads any more.
 */
export const providerKeySecretName: Readonly<Record<AssistantProvider, string>> = Object.freeze({
  openai: "model-key-openai",
  anthropic: "model-key-anthropic",
});

/** Every provider a key can be stored for, in the order routes are emitted into the patch. */
export const assistantProviders: readonly AssistantProvider[] = Object.freeze([
  "openai",
  "anthropic",
]);

/**
 * Read the keys this device holds.
 *
 * A blank stored value counts as absent. That is not pedantry: an empty `apiKeyEnv` reference fails a
 * request with `MISSING_CREDENTIAL` deep inside a turn, whereas absence here means the route is never
 * emitted and the user is told to add a key before anything is spawned.
 */
export function readProviderKeys(
  store: ProviderKeyStore,
  log: MainLog,
): Partial<Record<AssistantProvider, string>> {
  if (!store.isAvailable()) {
    // No keychain means keys were never persisted, so there is nothing to find. Logged because the
    // user's experience of it — "it keeps asking for my key" — has a cause worth naming.
    log.warn("assistant.keychain_unavailable");
    return {};
  }
  const keys: Partial<Record<AssistantProvider, string>> = {};
  for (const provider of assistantProviders) {
    const value = store.read(providerKeySecretName[provider])?.trim();
    if (value !== undefined && value.length > 0) keys[provider] = value;
  }
  // The count, never a key and never so much as its length: a length is a fingerprint.
  log.info("assistant.provider_keys", { count: Object.keys(keys).length });
  return keys;
}
