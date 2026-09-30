/**
 * The keychain group: the one way a model provider key gets onto this device.
 *
 * Note 18 put the key here rather than in the cloud — "model keys live on the device that makes the
 * call. The cloud never holds one and never returns one" — and `harness/provider-keys.ts` is the reader
 * that hands it to the harness child. This is the writer, and the two agree through
 * `providerKeySecretName` rather than through a string spelled twice.
 *
 * The rule the whole file is shaped by: **a key goes in and never comes out.** There is no read
 * channel, not even a masked one. `status()` answers which providers have a key as two booleans, which
 * is everything Settings → Models needs to draw itself — "Added" or "Add a key" — and nothing an
 * attacker who reached page script could exfiltrate. A last-four hint is deliberately absent for the
 * same reason the cloud's `ai_provider_keys` refuses one.
 *
 * The honest limit, repeated here because it belongs next to the code that stores the key: the agent
 * has a shell and runs as this user. The keychain protects the key at rest across restarts. It does not
 * protect it from the agent, and dsh's own credentials documentation says the same of its file
 * permissions.
 */

import type { KeychainStatus } from "../shared/keychain.ts";
import { keychainChannels } from "../shared/keychain.ts";
import type { GuardedHandle } from "./assistant-ipc.ts";
import type { AssistantProvider } from "./harness/profile.ts";
import { assistantProviders, providerKeySecretName } from "./harness/provider-keys.ts";
import type { MainLog } from "./log.ts";

/** The `SecretStore` surface this writer uses. Narrow, so a test needs no `safeStorage`. */
export interface ProviderKeyWriter {
  isAvailable(): boolean;
  read(name: string): string | null;
  write(name: string, plainText: string): boolean;
  clear(name: string): void;
}

/**
 * The longest key accepted. Provider keys are ~100–200 characters; this is loose enough never to reject
 * a real one and tight enough that the channel cannot be used to write a file of arbitrary size.
 */
const MAX_KEY_LENGTH = 4_096;

/** Whether a value names a provider a key may be stored for. */
function providerOf(value: unknown): AssistantProvider | null {
  return assistantProviders.find((candidate) => candidate === value) ?? null;
}

export function registerKeychainHandlers(
  handle: GuardedHandle,
  store: ProviderKeyWriter,
  log: MainLog,
  onChanged: () => void,
): void {
  const status = (): KeychainStatus => {
    const available = store.isAvailable();
    const providers = {} as Record<AssistantProvider, boolean>;
    for (const provider of assistantProviders) {
      // A blank stored value counts as absent, matching the reader exactly: an empty key would fail
      // inside a turn with a provider error instead of being answered here with "add a key".
      providers[provider] = available
        ? (store.read(providerKeySecretName[provider])?.trim() ?? "").length > 0
        : false;
    }
    return { available, providers };
  };

  handle(keychainChannels.keychainStatus, (): KeychainStatus => status());

  handle(keychainChannels.keychainSet, (provider: unknown, key: unknown): KeychainStatus => {
    const named = providerOf(provider);
    const value = typeof key === "string" ? key.trim() : "";
    if (named === null || value.length === 0 || value.length > MAX_KEY_LENGTH) {
      // Refused without saying which test failed, and without the value reaching a log line.
      log.warn("keychain.set_refused");
      return status();
    }
    if (!store.write(providerKeySecretName[named], value)) {
      log.warn("keychain.set_failed", { provider: named });
      return status();
    }
    log.info("keychain.set", { provider: named });
    // The supervisor reads the keyring when it spawns a child, so a key added while a conversation is
    // open must invalidate the child that was started without one — otherwise the first turn after
    // adding a key still fails, and the user has no way to know a restart would fix it.
    onChanged();
    return status();
  });

  handle(keychainChannels.keychainClear, (provider: unknown): KeychainStatus => {
    const named = providerOf(provider);
    if (named === null) {
      log.warn("keychain.clear_refused");
      return status();
    }
    store.clear(providerKeySecretName[named]);
    log.info("keychain.clear", { provider: named });
    onChanged();
    return status();
  });
}
