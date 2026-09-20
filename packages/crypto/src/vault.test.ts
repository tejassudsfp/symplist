import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  expectCryptoError,
  expectCryptoRejection,
  flipBase64UrlBit,
  randomAccountKey,
  utf8,
} from "../test/support.ts";
import { decryptField, encryptFieldText } from "./envelopes.ts";
import {
  DecryptionFailedError,
  InvalidCryptoInputError,
  InvalidPasswordHashError,
  KeyUnavailableError,
  MalformedEnvelopeError,
  UnsupportedKeyVersionError,
} from "./errors.ts";
import { createKeyProvider } from "./key-provider.ts";
import { createArgon2idParameters, deriveArgon2idKey } from "./passwords.ts";
import { generateToken } from "./tokens.ts";
import {
  decryptVaultGrantValue,
  decryptVaultItem,
  encryptVaultGrantValue,
  encryptVaultItem,
  generateVaultKey,
  rewrapVaultRecoveryKey,
  unwrapVaultKeyForSession,
  unwrapVaultKeyWithPassphrase,
  unwrapVaultKeyWithRecovery,
  vaultRecoveryWrapNeedsRewrap,
  wrapVaultKeyForRecovery,
  wrapVaultKeyForSession,
  wrapVaultKeyWithPassphrase,
} from "./vault.ts";

const owner = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const otherOwner = "0199a1b2-c3d4-7e5f-8a6b-000000000002";
const secretValue = Buffer.from("VAULT-SECRET-MARKER-91c2", "utf8");

describe("Vault passphrase wrap", () => {
  it("unwraps only with the passphrase-derived key and the bound owner and version", async () => {
    const vaultKey = generateVaultKey();
    const parameters = createArgon2idParameters();
    const passphraseKey = await deriveArgon2idKey("correct horse battery staple", parameters);
    const context = { ownerId: owner, vaultVersion: 1 };
    const wrapped = wrapVaultKeyWithPassphrase(passphraseKey, context, vaultKey);
    expect(wrapped).toMatch(/^[A-Za-z0-9_-]{80}$/);

    const again = await deriveArgon2idKey("correct horse battery staple", parameters);
    expect(
      Buffer.from(unwrapVaultKeyWithPassphrase(again, context, wrapped)).equals(vaultKey),
    ).toBe(true);

    const wrong = await deriveArgon2idKey("correct horse battery stapler", parameters);
    expectCryptoError(
      () => unwrapVaultKeyWithPassphrase(wrong, context, wrapped),
      DecryptionFailedError,
    );
    expectCryptoError(
      () => unwrapVaultKeyWithPassphrase(again, { ownerId: otherOwner, vaultVersion: 1 }, wrapped),
      DecryptionFailedError,
    );
    expectCryptoError(
      () => unwrapVaultKeyWithPassphrase(again, { ownerId: owner, vaultVersion: 2 }, wrapped),
      DecryptionFailedError,
    );
    expectCryptoError(
      () => unwrapVaultKeyWithPassphrase(again, context, flipBase64UrlBit(wrapped, 30)),
      DecryptionFailedError,
    );
    expectCryptoError(
      () => unwrapVaultKeyWithPassphrase(again, context, wrapped.slice(2)),
      MalformedEnvelopeError,
    );
  });

  it("rejects keys of the wrong length", () => {
    expectCryptoError(
      () =>
        wrapVaultKeyWithPassphrase(
          randomBytes(16),
          { ownerId: owner, vaultVersion: 1 },
          generateVaultKey(),
        ),
      InvalidCryptoInputError,
    );
    expectCryptoError(
      () =>
        wrapVaultKeyWithPassphrase(
          randomBytes(32),
          { ownerId: owner, vaultVersion: 1 },
          randomBytes(31),
        ),
      InvalidCryptoInputError,
    );
  });

  it("rejects a stored record that carries a hash", async () => {
    const parameters = createArgon2idParameters();
    const withHash = { ...parameters, hash: randomBytes(32).toString("base64url") };
    await expectCryptoRejection(
      // @ts-expect-error a verifier hash must never be used for key derivation
      () => deriveArgon2idKey("secret", withHash),
      InvalidPasswordHashError,
    );
  });
});

describe("Vault recovery wrap", () => {
  const recovery1 = randomBytes(32);
  const recovery2 = randomBytes(32);
  const v1 = createKeyProvider({
    VAULT_RECOVERY_KEY: { current: 1, versions: new Map([[1, recovery1]]) },
  });
  const v2 = createKeyProvider({
    VAULT_RECOVERY_KEY: {
      current: 2,
      versions: new Map([
        [1, recovery1],
        [2, recovery2],
      ]),
    },
  });

  it("wraps under the current recovery key and unwraps with the recorded version", () => {
    const vaultKey = generateVaultKey();
    const wrap = wrapVaultKeyForRecovery(v2, owner, vaultKey);
    expect(wrap.recoveryKeyVersion).toBe(2);
    expect(Buffer.from(unwrapVaultKeyWithRecovery(v2, owner, wrap)).equals(vaultKey)).toBe(true);
  });

  it("rotates to the current recovery key", () => {
    const vaultKey = generateVaultKey();
    const old = wrapVaultKeyForRecovery(v1, owner, vaultKey);
    expect(vaultRecoveryWrapNeedsRewrap(v2, old)).toBe(true);
    const rotated = rewrapVaultRecoveryKey(v2, owner, old);
    expect(rotated.recoveryKeyVersion).toBe(2);
    expect(vaultRecoveryWrapNeedsRewrap(v2, rotated)).toBe(false);
    const onlyV2 = createKeyProvider({
      VAULT_RECOVERY_KEY: { current: 2, versions: new Map([[2, recovery2]]) },
    });
    expect(Buffer.from(unwrapVaultKeyWithRecovery(onlyV2, owner, rotated)).equals(vaultKey)).toBe(
      true,
    );
  });

  it("fails for a wrong or unconfigured version, a swapped owner or a modified wrap", () => {
    const wrap = wrapVaultKeyForRecovery(v2, owner, generateVaultKey());
    expectCryptoError(() => unwrapVaultKeyWithRecovery(v1, owner, wrap), KeyUnavailableError);
    expectCryptoError(
      () => unwrapVaultKeyWithRecovery(v2, owner, { ...wrap, recoveryKeyVersion: 1 }),
      DecryptionFailedError,
    );
    expectCryptoError(
      () => unwrapVaultKeyWithRecovery(v2, otherOwner, wrap),
      DecryptionFailedError,
    );
    expectCryptoError(
      () =>
        unwrapVaultKeyWithRecovery(v2, owner, {
          ...wrap,
          wrapped: flipBase64UrlBit(wrap.wrapped, 0),
        }),
      DecryptionFailedError,
    );
    expectCryptoError(
      () => wrapVaultKeyForRecovery(createKeyProvider({}), owner, generateVaultKey()),
      KeyUnavailableError,
    );
  });
});

describe("Vault session wrap", () => {
  it("unwraps only with the session token, owner and session id", () => {
    const vaultKey = generateVaultKey();
    const token = generateToken();
    const context = { ownerId: owner, vaultSessionId: "vs-1" };
    const wrapped = wrapVaultKeyForSession(token, context, vaultKey);
    expect(Buffer.from(unwrapVaultKeyForSession(token, context, wrapped)).equals(vaultKey)).toBe(
      true,
    );
    expectCryptoError(
      () => unwrapVaultKeyForSession(generateToken(), context, wrapped),
      DecryptionFailedError,
    );
    expectCryptoError(
      () => unwrapVaultKeyForSession(token, { ...context, vaultSessionId: "vs-2" }, wrapped),
      DecryptionFailedError,
    );
    expectCryptoError(
      () => unwrapVaultKeyForSession(token, { ...context, ownerId: otherOwner }, wrapped),
      DecryptionFailedError,
    );
  });

  it("rejects malformed session tokens", () => {
    const context = { ownerId: owner, vaultSessionId: "vs-1" };
    for (const token of ["", "short", `${generateToken()}A`, generateToken(16), 42]) {
      expectCryptoError(
        () => wrapVaultKeyForSession(token as string, context, generateVaultKey()),
        InvalidCryptoInputError,
      );
    }
  });
});

describe("Vault items", () => {
  const vaultKey = generateVaultKey();
  const context = { ownerId: owner, itemId: "item-1" };
  const envelope = encryptVaultItem(vaultKey, context, secretValue);

  it("round-trips under the Vault key", () => {
    expect(envelope.startsWith("sym1.1.")).toBe(true);
    expect(Buffer.from(decryptVaultItem(vaultKey, context, envelope)).equals(secretValue)).toBe(
      true,
    );
  });

  it("fails with a wrong key, swapped item or owner, or a modified envelope", () => {
    expectCryptoError(
      () => decryptVaultItem(generateVaultKey(), context, envelope),
      DecryptionFailedError,
    );
    expectCryptoError(
      () => decryptVaultItem(vaultKey, { ...context, itemId: "item-2" }, envelope),
      DecryptionFailedError,
    );
    expectCryptoError(
      () => decryptVaultItem(vaultKey, { ...context, ownerId: otherOwner }, envelope),
      DecryptionFailedError,
    );
    const parts = envelope.split(".");
    expectCryptoError(
      () => decryptVaultItem(vaultKey, context, [parts[0], "2", parts[2], parts[3]].join(".")),
      UnsupportedKeyVersionError,
    );
    expectCryptoError(
      () =>
        decryptVaultItem(
          vaultKey,
          context,
          [parts[0], parts[1], parts[2], flipBase64UrlBit(parts[3] ?? "", 2)].join("."),
        ),
      DecryptionFailedError,
    );
  });

  it("cannot be opened as a grant value or a field envelope", () => {
    const accountKey = { ownerId: owner, kekVersion: 1, key: vaultKey };
    expectCryptoError(
      () =>
        decryptVaultGrantValue(
          accountKey,
          { ownerId: owner, grantId: "item-1", taskId: "t" },
          envelope,
        ),
      DecryptionFailedError,
    );
    expectCryptoError(
      () =>
        decryptField(
          accountKey,
          {
            purpose: "vault-item",
            ownerId: owner,
            table: "vault_items",
            rowId: "item-1",
            column: "value_enc",
          },
          envelope,
        ),
      DecryptionFailedError,
    );
  });
});

describe("Vault grant values", () => {
  const key = randomAccountKey(owner);
  const context = { ownerId: owner, grantId: "grant-1", taskId: "task-1" };
  const envelope = encryptVaultGrantValue(key, context, secretValue);

  it("round-trips under the account data key", () => {
    expect(utf8(decryptVaultGrantValue(key, context, envelope))).toBe(utf8(secretValue));
  });

  it.each([
    ["grant", { grantId: "grant-2" }],
    ["task", { taskId: "task-2" }],
  ] as const)("fails when the %s is swapped", (_label, change) => {
    expectCryptoError(
      () => decryptVaultGrantValue(key, { ...context, ...change }, envelope),
      DecryptionFailedError,
    );
  });

  it("fails for a swapped owner, a wrong key and a foreign key", () => {
    expectCryptoError(
      () =>
        decryptVaultGrantValue(
          { ...key, ownerId: otherOwner },
          { ...context, ownerId: otherOwner },
          envelope,
        ),
      DecryptionFailedError,
    );
    expectCryptoError(
      () => decryptVaultGrantValue(randomAccountKey(owner), context, envelope),
      DecryptionFailedError,
    );
    expectCryptoError(
      () => decryptVaultGrantValue(randomAccountKey(otherOwner), context, envelope),
      InvalidCryptoInputError,
    );
    expectCryptoError(
      () => encryptVaultGrantValue(randomAccountKey(otherOwner), context, secretValue),
      InvalidCryptoInputError,
    );
  });

  it("is distinct from an ordinary field envelope under the same key", () => {
    const field = encryptFieldText(
      key,
      {
        purpose: "vault-grant",
        ownerId: owner,
        table: "vault_grants",
        rowId: "grant-1",
        column: "value_enc",
      },
      "x",
    );
    expectCryptoError(() => decryptVaultGrantValue(key, context, field), DecryptionFailedError);
  });
});
