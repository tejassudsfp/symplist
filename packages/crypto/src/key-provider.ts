import { decodeBase64Url } from "./encoding.ts";
import { KeyConfigurationError, KeyUnavailableError } from "./errors.ts";
import type { KeyFamily, KeyProvider, VersionedKey } from "./keys.ts";

/** Every generated secret family (§4.5), in inventory order. */
export const keyFamilies: readonly KeyFamily[] = Object.freeze([
  "CONTENT_KEK",
  "INTERNAL_EVENT_SECRET",
  "REMINDER_UNSUBSCRIBE_SECRET",
  "VAULT_RECOVERY_KEY",
  "SESSION_DIGEST_SECRET",
  "OTP_DIGEST_SECRET",
  "INVITE_DIGEST_SECRET",
  "SHARE_DIGEST_SECRET",
  "SHARE_SESSION_DIGEST_SECRET",
  "MCP_TOKEN_DIGEST_SECRET",
  "MCP_OAUTH_SIGNING_KEY",
  "IDEMPOTENCY_SECRET",
]);

/** Every generated secret is 32 random bytes (§4.1, §4.5). */
export const SECRET_KEY_BYTES = 32;

/** Largest accepted version number, so versions stay small safe integers. */
export const MAX_KEY_VERSION = 999_999_999;

const versionPattern = /^[1-9][0-9]{0,8}$/;

/**
 * One configured family. Structurally compatible with `SecretFamilyConfig` from `@symplist/config`
 * (base64url strings keyed by version); tests may pass raw bytes instead.
 */
export interface KeyFamilySource {
  /** The version named by `<NAME>_CURRENT`. */
  readonly current: number;
  /** Every configured `<NAME>_<n>` value keyed by version: base64url text or 32 raw bytes. */
  readonly versions: ReadonlyMap<number, string | Uint8Array>;
}

/** Configured families; families that a runtime does not hold are simply absent. */
export type KeyFamilySources = { readonly [F in KeyFamily]?: KeyFamilySource };

/** Options for building a key provider. */
export interface KeyProviderOptions {
  /** Families that must be configured; a missing one fails construction. */
  readonly required?: readonly KeyFamily[];
}

/** Options for reading families from environment variables. */
export interface EnvKeyProviderOptions extends KeyProviderOptions {
  /** Families to read. Defaults to every family; variables of other families are ignored. */
  readonly families?: readonly KeyFamily[];
}

/** A key provider that owns its key buffers. */
export interface ManagedKeyProvider extends KeyProvider {
  /** Families with a configured current version. */
  families(): readonly KeyFamily[];
  /** Zeroises every key buffer; any later call fails with `KeyConfigurationError`. */
  destroy(): void;
}

interface LoadedFamily {
  readonly current: VersionedKey;
  readonly byVersion: ReadonlyMap<number, VersionedKey>;
  readonly newestFirst: readonly VersionedKey[];
}

function isValidVersion(version: number): boolean {
  return Number.isSafeInteger(version) && version >= 1 && version <= MAX_KEY_VERSION;
}

function loadKey(family: KeyFamily, version: number, value: string | Uint8Array): Buffer {
  if (typeof value === "string") {
    const decoded = decodeBase64Url(value, SECRET_KEY_BYTES);
    if (!decoded) {
      throw new KeyConfigurationError(
        `${family}_${version} must be ${SECRET_KEY_BYTES} bytes encoded as unpadded base64url`,
      );
    }
    // Copy out of Node's shared allocation pool so destroy() zeroises a buffer this provider owns.
    const owned = Buffer.alloc(SECRET_KEY_BYTES);
    decoded.copy(owned);
    decoded.fill(0);
    return owned;
  }
  if (!(value instanceof Uint8Array) || value.byteLength !== SECRET_KEY_BYTES) {
    throw new KeyConfigurationError(`${family}_${version} must be ${SECRET_KEY_BYTES} bytes`);
  }
  const owned = Buffer.alloc(SECRET_KEY_BYTES);
  owned.set(value);
  return owned;
}

function loadFamily(family: KeyFamily, source: KeyFamilySource): LoadedFamily {
  if (!isValidVersion(source.current)) {
    throw new KeyConfigurationError(`${family}_CURRENT must be a positive integer version`);
  }
  const byVersion = new Map<number, VersionedKey>();
  for (const [version, value] of source.versions) {
    if (!isValidVersion(version)) {
      throw new KeyConfigurationError(`${family} versions must be positive integers`);
    }
    byVersion.set(version, Object.freeze({ version, key: loadKey(family, version, value) }));
  }
  const current = byVersion.get(source.current);
  if (!current) {
    throw new KeyConfigurationError(
      `${family}_CURRENT names version ${source.current}, which is not configured`,
    );
  }
  const newestFirst = Object.freeze([...byVersion.values()].sort((a, b) => b.version - a.version));
  return { current, byVersion, newestFirst };
}

/** Builds a key provider from already-parsed families (for example the validated config). */
export function createKeyProvider(
  sources: KeyFamilySources,
  options: KeyProviderOptions = {},
): ManagedKeyProvider {
  const loaded = new Map<KeyFamily, LoadedFamily>();
  try {
    for (const family of keyFamilies) {
      const source = sources[family];
      if (source) loaded.set(family, loadFamily(family, source));
    }
    for (const family of options.required ?? []) {
      if (!loaded.has(family)) {
        throw new KeyConfigurationError(`Key family ${family} is required but not configured`);
      }
    }
  } catch (error) {
    for (const entry of loaded.values()) for (const key of entry.newestFirst) key.key.fill(0);
    throw error;
  }

  let destroyed = false;
  const family = (name: KeyFamily): LoadedFamily => {
    if (destroyed) throw new KeyConfigurationError("The key provider has been destroyed");
    const entry = loaded.get(name);
    if (!entry) throw new KeyUnavailableError(name);
    return entry;
  };

  return Object.freeze({
    current: (name: KeyFamily) => family(name).current,
    get: (name: KeyFamily, version: number) => {
      if (destroyed) throw new KeyConfigurationError("The key provider has been destroyed");
      return loaded.get(name)?.byVersion.get(version);
    },
    all: (name: KeyFamily) => family(name).newestFirst,
    families: () => {
      if (destroyed) throw new KeyConfigurationError("The key provider has been destroyed");
      return Object.freeze([...loaded.keys()]);
    },
    destroy: () => {
      for (const entry of loaded.values()) for (const key of entry.newestFirst) key.key.fill(0);
      destroyed = true;
    },
  });
}

/**
 * Reads `<NAME>_<n>` and `<NAME>_CURRENT` variables (decision A4). A family with neither is treated
 * as absent; a family with versions but no current version, a current version that is not
 * configured, a malformed version number or a value that is not 32 bytes of base64url fails.
 */
export function createEnvKeyProvider(
  env: Readonly<Record<string, string | undefined>>,
  options: EnvKeyProviderOptions = {},
): ManagedKeyProvider {
  const sources: { [F in KeyFamily]?: KeyFamilySource } = {};
  for (const family of options.families ?? keyFamilies) {
    const versions = new Map<number, string>();
    const prefix = `${family}_`;
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined || !name.startsWith(prefix)) continue;
      const suffix = name.slice(prefix.length);
      if (suffix === "CURRENT" || !/^[0-9]+$/.test(suffix)) continue;
      if (!versionPattern.test(suffix)) {
        throw new KeyConfigurationError(`${name} must use a positive integer version`);
      }
      versions.set(Number(suffix), value);
    }
    const currentText = env[`${family}_CURRENT`];
    if (currentText === undefined && versions.size === 0) continue;
    if (currentText === undefined) {
      throw new KeyConfigurationError(`${family}_CURRENT is required when ${family} is configured`);
    }
    if (!versionPattern.test(currentText)) {
      throw new KeyConfigurationError(`${family}_CURRENT must be a positive integer version`);
    }
    sources[family] = { current: Number(currentText), versions };
  }
  return createKeyProvider(sources, options);
}
