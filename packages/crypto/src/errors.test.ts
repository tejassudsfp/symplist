import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { flipBase64UrlBit, randomAccountKey } from "../test/support.ts";
import { computeDigest, verifyDigest } from "./digests.ts";
import {
  createAccountKey,
  decryptField,
  decryptFieldText,
  decryptObject,
  encryptFieldText,
  encryptObject,
  unwrapAccountKey,
} from "./envelopes.ts";
import {
  Argon2UnavailableError,
  CryptoError,
  DecryptionFailedError,
  InputTooLargeError,
  InvalidCryptoInputError,
  InvalidPasswordHashError,
  KeyConfigurationError,
  KeyUnavailableError,
  MalformedEnvelopeError,
  NotImplementedError,
  RateLimitedError,
  UnsupportedKeyVersionError,
} from "./errors.ts";
import { createEnvKeyProvider, createKeyProvider } from "./key-provider.ts";
import { verifyArgon2id } from "./passwords.ts";
import { generateToken } from "./tokens.ts";
import {
  decryptVaultItem,
  encryptVaultItem,
  unwrapVaultKeyForSession,
  wrapVaultKeyForSession,
} from "./vault.ts";

const owner = "owner-leak-test";
const marker = "LEAK-MARKER-plaintext-5d1e";

function captureSync(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("operation did not fail");
}

async function captureAsync(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("operation did not fail");
}

function render(error: unknown): string {
  const record = error as Record<string, unknown>;
  return [
    String(error),
    inspect(error, { depth: 5, showHidden: true }),
    JSON.stringify(error),
    JSON.stringify(Object.getOwnPropertyNames(record).map((name) => record[name])),
  ].join("\n");
}

describe("typed errors", () => {
  it("expose stable codes and names", () => {
    const cases: [CryptoError, string, string][] = [
      [new KeyConfigurationError("x"), "KeyConfigurationError", "crypto.key_configuration_invalid"],
      [new KeyUnavailableError("CONTENT_KEK", 2), "KeyUnavailableError", "crypto.key_unavailable"],
      [new InvalidCryptoInputError("x"), "InvalidCryptoInputError", "crypto.invalid_input"],
      [new InputTooLargeError("x", 1), "InputTooLargeError", "crypto.input_too_large"],
      [new MalformedEnvelopeError("x"), "MalformedEnvelopeError", "crypto.malformed_envelope"],
      [
        new UnsupportedKeyVersionError("x"),
        "UnsupportedKeyVersionError",
        "crypto.unsupported_key_version",
      ],
      [new DecryptionFailedError("x"), "DecryptionFailedError", "crypto.decryption_failed"],
      [
        new InvalidPasswordHashError("x"),
        "InvalidPasswordHashError",
        "crypto.invalid_password_hash",
      ],
      [new Argon2UnavailableError(), "Argon2UnavailableError", "crypto.argon2_unavailable"],
      [new RateLimitedError(1), "RateLimitedError", "rate.limited"],
    ];
    for (const [error, name, code] of cases) {
      expect(error).toBeInstanceOf(CryptoError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(name);
      expect(error.code).toBe(code);
      expect(error.cause).toBeUndefined();
    }
    expect(new NotImplementedError("op").message).toBe("op is not implemented yet");
  });

  it("never contain plaintext, keys, ciphertext or secrets", async () => {
    const accountKeyBytes = randomBytes(32);
    const key = { ownerId: owner, kekVersion: 1, key: accountKeyBytes };
    const kek = randomBytes(32);
    const keys = createKeyProvider({ CONTENT_KEK: { current: 1, versions: new Map([[1, kek]]) } });
    const context = {
      purpose: "title",
      ownerId: owner,
      table: "tasks",
      rowId: "r",
      column: "title_enc",
    };
    const envelope = encryptFieldText(key, context, marker);
    const [, , iv = "", body = ""] = envelope.split(".");
    const objectContext = { kind: "artifact", ownerId: owner, objectId: "o", formatVersion: 1 };
    const object = encryptObject(key, objectContext, Buffer.from(marker));
    const { wrapped } = createAccountKey(keys, owner);
    const token = generateToken();
    const vaultKey = randomBytes(32);
    const sessionWrap = wrapVaultKeyForSession(
      token,
      { ownerId: owner, vaultSessionId: "s" },
      vaultKey,
    );
    const item = encryptVaultItem(vaultKey, { ownerId: owner, itemId: "i" }, Buffer.from(marker));
    const badSecret = `${randomBytes(32).toString("base64url").slice(0, 42)}B`;
    const digestKeys = createKeyProvider({
      SESSION_DIGEST_SECRET: { current: 1, versions: new Map([[1, randomBytes(32)]]) },
    });

    const errors: unknown[] = [
      captureSync(() => decryptField(randomAccountKey(owner), context, envelope)),
      captureSync(() => decryptField(key, { ...context, rowId: "other" }, envelope)),
      captureSync(() => decryptField(key, context, `sym1.1.${iv}.${flipBase64UrlBit(body, 3)}`)),
      captureSync(() => decryptField(key, context, `sym1.2.${iv}.${body}`)),
      captureSync(() => decryptField(key, context, `${envelope}=`)),
      captureSync(() =>
        decryptFieldText(key, context, encryptFieldText(key, context, marker).slice(0, -3)),
      ),
      captureSync(() => encryptFieldText(key, context, `${marker}\ud800`)),
      captureSync(() => decryptObject(randomAccountKey(owner), objectContext, object)),
      captureSync(() =>
        decryptObject(key, objectContext, object.subarray(0, object.byteLength - 1)),
      ),
      captureSync(() =>
        unwrapAccountKey(keys, { ...wrapped, wrapped: flipBase64UrlBit(wrapped.wrapped, 20) }),
      ),
      captureSync(() => unwrapAccountKey(keys, { ...wrapped, kekVersion: 5 })),
      captureSync(() =>
        unwrapVaultKeyForSession(
          generateToken(),
          { ownerId: owner, vaultSessionId: "s" },
          sessionWrap,
        ),
      ),
      captureSync(() =>
        wrapVaultKeyForSession(`${token}x`, { ownerId: owner, vaultSessionId: "s" }, vaultKey),
      ),
      captureSync(() => decryptVaultItem(randomBytes(32), { ownerId: owner, itemId: "i" }, item)),
      captureSync(() =>
        createEnvKeyProvider({ CONTENT_KEK_1: badSecret, CONTENT_KEK_CURRENT: "1" }),
      ),
      captureSync(() =>
        verifyDigest(digestKeys, "SESSION_DIGEST_SECRET", "session", marker, {
          version: 1,
          digest: marker,
        }),
      ),
      captureSync(() =>
        computeDigest(digestKeys, "SESSION_DIGEST_SECRET", "csrf", `${marker}\udc00`),
      ),
      await captureAsync(() =>
        verifyArgon2id(marker, {
          v: 1,
          alg: "argon2id",
          m: 1,
          t: 1,
          p: 1,
          salt: marker,
          hash: marker,
        } as never),
      ),
    ];

    const forbidden = [
      marker,
      accountKeyBytes.toString("hex"),
      accountKeyBytes.toString("base64url"),
      kek.toString("hex"),
      kek.toString("base64url"),
      vaultKey.toString("base64url"),
      token,
      badSecret,
      iv,
      body,
      body.slice(0, 16),
      wrapped.wrapped,
      Buffer.from(object).subarray(20, 40).toString("hex"),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(CryptoError);
      expect((error as Error).cause).toBeUndefined();
      const text = render(error);
      for (const value of forbidden) expect(text).not.toContain(value);
    }
  });
});
