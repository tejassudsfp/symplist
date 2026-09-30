/**
 * The keychain's IPC contract: how Settings → Models puts a model provider key on this device.
 *
 * Main and preload are bundled separately, so this module is the only place they agree on these names;
 * nothing here may import `electron` or `node:*`.
 *
 * There is no channel that returns a key, and that absence is the contract. The renderer writes one and
 * afterwards learns only whether each provider has one — which is all Settings → Models draws from. A
 * masked value or a last-four hint would be a read channel with a smaller payload, so neither exists.
 */

/** Every channel the keychain group registers. Merged into `ipcChannels` in `./ipc.ts`. */
export const keychainChannels = Object.freeze({
  keychainStatus: "symplist:keychain/status",
  keychainSet: "symplist:keychain/set",
  keychainClear: "symplist:keychain/clear",
} as const);

/** The providers a key can be stored for. Mirrors `AssistantProvider`, which lives in main. */
export type KeychainProvider = "openai" | "anthropic";

/** Which providers this device holds a key for. Never the values — those never leave main. */
export interface KeychainStatus {
  /**
   * Whether the OS keychain can be used at all. False means `safeStorage` has no backing key, so a
   * secret could only be kept as plaintext — which this app never does. The user experiences it as
   * being asked for the key on every launch, so the UI says so rather than letting it be guessed at.
   */
  readonly available: boolean;
  readonly providers: Readonly<Record<KeychainProvider, boolean>>;
}
