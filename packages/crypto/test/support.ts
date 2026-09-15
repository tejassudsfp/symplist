import { readFileSync } from "node:fs";
import { expect } from "vitest";
import type { RandomSource } from "../src/encoding.ts";
import type { FieldEnvelopeContext, ObjectEnvelopeContext } from "../src/envelopes.ts";
import type { CryptoError } from "../src/errors.ts";
import { createKeyProvider, type KeyFamilySources } from "../src/key-provider.ts";
import type { AccountDataKey, KeyFamily } from "../src/keys.ts";
import type { Argon2idHash } from "../src/passwords.ts";

interface FamilyJson {
  readonly current: number;
  readonly versions: Readonly<Record<string, string>>;
}

export interface AadVector {
  readonly name: string;
  readonly shape:
    | "field"
    | "object"
    | "account-key"
    | "vault-pass"
    | "vault-recovery"
    | "vault-session"
    | "vault-item"
    | "vault-grant";
  readonly input: Readonly<Record<string, unknown>>;
  readonly encoded: string;
}

export interface Vectors {
  readonly keys: Readonly<Record<string, FamilyJson>>;
  readonly aad: readonly AadVector[];
  readonly hkdf: readonly { label: string; ikm: string; output: string }[];
  readonly accountKeys: readonly {
    name: string;
    ownerId: string;
    kekVersion: number;
    random: readonly string[];
    wrappingKey: string;
    aad: string;
    wrapped: string;
  }[];
  readonly fields: readonly {
    name: string;
    dataKey: string;
    context: FieldEnvelopeContext;
    plaintextHex: string;
    random: readonly string[];
    aad: string;
    envelope: string;
  }[];
  readonly objects: readonly {
    name: string;
    dataKey: string;
    context: ObjectEnvelopeContext;
    plaintextHex: string;
    random: readonly string[];
    aad: string;
    header: string;
    envelopeHex: string;
  }[];
  readonly vault: {
    vaultKey: string;
    passphrase: {
      passphraseKey: string;
      context: { ownerId: string; vaultVersion: number };
      random: readonly string[];
      aad: string;
      wrapped: string;
    };
    recovery: {
      ownerId: string;
      recoveryKeyVersion: number;
      random: readonly string[];
      wrappingKey: string;
      aad: string;
      wrapped: string;
    };
    session: {
      sessionToken: string;
      context: { ownerId: string; vaultSessionId: string };
      random: readonly string[];
      wrappingKey: string;
      aad: string;
      wrapped: string;
    };
    item: {
      context: { ownerId: string; itemId: string };
      plaintextHex: string;
      random: readonly string[];
      aad: string;
      envelope: string;
    };
    grant: {
      dataKey: string;
      context: { ownerId: string; grantId: string; taskId: string };
      plaintextHex: string;
      random: readonly string[];
      aad: string;
      envelope: string;
    };
  };
  readonly digests: readonly {
    purpose: string;
    family: KeyFamily;
    version: number;
    valueText?: string;
    valueHex?: string;
    digest: string;
  }[];
  readonly otp: readonly {
    challengeId: string;
    purpose: "login" | "signup" | "vault_reset" | "account_delete";
    code: string;
    value: string;
    version: number;
    digest: string;
  }[];
  readonly idempotency: readonly {
    input: unknown;
    canonical: string;
    version: number;
    digest: string;
  }[];
  readonly approvalArgs: readonly {
    dataKey: string;
    input: { toolSlug: string; connectedAccountId: string | null; arguments: unknown };
    canonical: string;
    digestKey: string;
    digest: string;
  }[];
  readonly emailSuppression: readonly { email: string; version: number; digest: string }[];
  readonly argon2id: readonly {
    name: string;
    secret: string;
    normalized?: string;
    salt: string;
    record: Argon2idHash;
  }[];
}

/** The committed, frozen test vectors. */
export const vectors: Vectors = JSON.parse(
  readFileSync(new URL("../test-vectors/v1.json", import.meta.url), "utf8"),
) as Vectors;

export const fromHex = (hex: string): Buffer => Buffer.from(hex, "hex");
export const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
export const utf8 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8");

/** Sources built from the vector key families. */
export function vectorKeySources(): KeyFamilySources {
  const sources: { [F in KeyFamily]?: { current: number; versions: Map<number, string> } } = {};
  for (const [family, json] of Object.entries(vectors.keys)) {
    sources[family as KeyFamily] = {
      current: json.current,
      versions: new Map(Object.entries(json.versions).map(([v, value]) => [Number(v), value])),
    };
  }
  return sources;
}

/** A key provider holding the vector keys. */
export function vectorKeys() {
  return createKeyProvider(vectorKeySources());
}

/**
 * A random source that returns the given hex values in order, each as a fresh buffer, and fails when a
 * requested length differs or the script runs out.
 */
export function scriptedRandom(hexValues: readonly string[]): RandomSource & {
  remaining(): number;
} {
  const queue = hexValues.map(fromHex);
  const source = (byteLength: number): Uint8Array => {
    const next = queue.shift();
    if (!next || next.byteLength !== byteLength) {
      throw new Error(`scripted random source cannot supply ${byteLength} bytes`);
    }
    return next;
  };
  return Object.assign(source, { remaining: () => queue.length });
}

/** A throwaway random account data key. */
export function randomAccountKey(ownerId: string, kekVersion = 1): AccountDataKey {
  return {
    ownerId,
    kekVersion,
    key: Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))),
  };
}

/** Asserts `operation` throws an instance of `type` (a `CryptoError`). */
export function expectCryptoError(
  operation: () => unknown,
  type: abstract new (...args: never[]) => CryptoError,
): CryptoError {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(type);
  return thrown as CryptoError;
}

/** Asserts `operation` rejects with an instance of `type` (a `CryptoError`). */
export async function expectCryptoRejection(
  operation: () => Promise<unknown>,
  type: abstract new (...args: never[]) => CryptoError,
): Promise<CryptoError> {
  let thrown: unknown;
  try {
    await operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(type);
  return thrown as CryptoError;
}

/** Flips one bit of a base64url character position, keeping the text valid base64url. */
export function flipBase64UrlChar(text: string, index: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const current = alphabet.indexOf(text.charAt(index));
  if (current < 0) throw new Error("not a base64url character");
  const replacement = alphabet.charAt(current ^ 0b100000);
  return `${text.slice(0, index)}${replacement}${text.slice(index + 1)}`;
}

/** Flips one bit in the decoded bytes of a base64url segment and re-encodes it canonically. */
export function flipBase64UrlBit(text: string, byteIndex: number, bit = 0): string {
  const bytes = Buffer.from(text, "base64url");
  bytes[byteIndex] = (bytes[byteIndex] ?? 0) ^ (1 << bit);
  return bytes.toString("base64url");
}
