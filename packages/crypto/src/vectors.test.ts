import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  fromHex,
  scriptedRandom,
  toHex,
  utf8,
  vectorKeySources,
  vectorKeys,
  vectors,
} from "../test/support.ts";
import {
  createAccountKey,
  decryptField,
  decryptObject,
  encryptField,
  encryptObject,
  unwrapAccountKey,
} from "./envelopes.ts";
import { createKeyProvider } from "./key-provider.ts";
import {
  decryptVaultGrantValue,
  decryptVaultItem,
  encryptVaultGrantValue,
  encryptVaultItem,
  unwrapVaultKeyForSession,
  unwrapVaultKeyWithPassphrase,
  unwrapVaultKeyWithRecovery,
  wrapVaultKeyForRecovery,
  wrapVaultKeyForSession,
  wrapVaultKeyWithPassphrase,
} from "./vault.ts";

/** An independent AES-256-GCM decryption (WebCrypto) of `ciphertext || tag` with explicit AAD text. */
async function webCryptoOpen(key: Uint8Array, iv: Uint8Array, sealed: Uint8Array, aad: string) {
  const cryptoKey = await webcrypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  const plaintext = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: Buffer.from(aad, "utf8"), tagLength: 128 },
    cryptoKey,
    sealed,
  );
  return Buffer.from(plaintext);
}

/** Decodes a wrapped key (IV || encrypted key || tag) independently of the package. */
async function webCryptoUnwrap(wrappingKey: Uint8Array, wrapped: string, aad: string) {
  const bytes = Buffer.from(wrapped, "base64url");
  expect(bytes).toHaveLength(60);
  return webCryptoOpen(wrappingKey, bytes.subarray(0, 12), bytes.subarray(12), aad);
}

function parseFieldEnvelope(envelope: string) {
  const match = /^sym1\.1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)$/.exec(envelope);
  if (!match?.[1] || !match[2]) throw new Error("vector is not a sym1 envelope");
  return { iv: Buffer.from(match[1], "base64url"), sealed: Buffer.from(match[2], "base64url") };
}

describe("frozen test vectors: account key wraps", () => {
  it.each(vectors.accountKeys.map((vector) => [vector.name, vector] as const))(
    "reproduces %s byte for byte",
    async (_name, vector) => {
      const sources = vectorKeySources();
      const keys = createKeyProvider({
        CONTENT_KEK: {
          current: vector.kekVersion,
          versions: sources.CONTENT_KEK?.versions ?? new Map(),
        },
      });
      const random = scriptedRandom(vector.random);
      const { key, wrapped } = createAccountKey(keys, vector.ownerId, { random });
      expect(random.remaining()).toBe(0);
      expect(wrapped).toEqual({
        ownerId: vector.ownerId,
        kekVersion: vector.kekVersion,
        wrapped: vector.wrapped,
      });
      expect(toHex(key.key)).toBe(vector.random[0]);

      const unwrapped = unwrapAccountKey(vectorKeys(), wrapped);
      expect(toHex(unwrapped.key)).toBe(vector.random[0]);
      expect(
        toHex(await webCryptoUnwrap(fromHex(vector.wrappingKey), vector.wrapped, vector.aad)),
      ).toBe(vector.random[0]);
    },
  );
});

describe("frozen test vectors: field envelopes", () => {
  it.each(vectors.fields.map((vector) => [vector.name, vector] as const))(
    "reproduces %s byte for byte and decrypts independently",
    async (_name, vector) => {
      const key = { ownerId: vector.context.ownerId, kekVersion: 2, key: fromHex(vector.dataKey) };
      const random = scriptedRandom(vector.random);
      expect(encryptField(key, vector.context, fromHex(vector.plaintextHex), { random })).toBe(
        vector.envelope,
      );
      expect(random.remaining()).toBe(0);
      expect(toHex(decryptField(key, vector.context, vector.envelope))).toBe(vector.plaintextHex);

      const { iv, sealed } = parseFieldEnvelope(vector.envelope);
      expect(toHex(iv)).toBe(vector.random[0]);
      expect(toHex(await webCryptoOpen(key.key, iv, sealed, vector.aad))).toBe(vector.plaintextHex);
    },
  );
});

describe("frozen test vectors: object envelopes", () => {
  it.each(vectors.objects.map((vector) => [vector.name, vector] as const))(
    "reproduces %s byte for byte and decrypts independently",
    async (_name, vector) => {
      const key = { ownerId: vector.context.ownerId, kekVersion: 2, key: fromHex(vector.dataKey) };
      const random = scriptedRandom(vector.random);
      const envelope = encryptObject(key, vector.context, fromHex(vector.plaintextHex), { random });
      expect(random.remaining()).toBe(0);
      expect(toHex(envelope)).toBe(vector.envelopeHex);
      expect(toHex(decryptObject(key, vector.context, fromHex(vector.envelopeHex)))).toBe(
        vector.plaintextHex,
      );

      const bytes = fromHex(vector.envelopeHex);
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("SYMO");
      expect(bytes[4]).toBe(1);
      const headerLength = bytes.readUInt32BE(5);
      const headerText = bytes.subarray(9, 9 + headerLength).toString("utf8");
      expect(headerText).toBe(vector.header);
      const header = JSON.parse(headerText) as {
        alg: string;
        iv: string;
        kv: number;
        v: number;
        wk: string;
      };
      expect(header.alg).toBe("A256GCM");
      expect(header.kv).toBe(1);
      expect(header.v).toBe(vector.context.formatVersion);
      expect(toHex(Buffer.from(header.iv, "base64url"))).toBe(vector.random[2]);

      const objectKey = await webCryptoUnwrap(key.key, header.wk, vector.aad);
      expect(toHex(objectKey)).toBe(vector.random[0]);
      expect(toHex(Buffer.from(header.wk, "base64url").subarray(0, 12))).toBe(vector.random[1]);
      const body = bytes.subarray(9 + headerLength);
      expect(
        toHex(
          await webCryptoOpen(objectKey, Buffer.from(header.iv, "base64url"), body, vector.aad),
        ),
      ).toBe(vector.plaintextHex);
    },
  );
});

describe("frozen test vectors: Vault", () => {
  const vault = vectors.vault;
  const vaultKey = fromHex(vault.vaultKey);

  it("reproduces the passphrase wrap", async () => {
    const { passphrase } = vault;
    const random = scriptedRandom(passphrase.random);
    const key = fromHex(passphrase.passphraseKey);
    expect(wrapVaultKeyWithPassphrase(key, passphrase.context, vaultKey, { random })).toBe(
      passphrase.wrapped,
    );
    expect(toHex(unwrapVaultKeyWithPassphrase(key, passphrase.context, passphrase.wrapped))).toBe(
      vault.vaultKey,
    );
    expect(toHex(await webCryptoUnwrap(key, passphrase.wrapped, passphrase.aad))).toBe(
      vault.vaultKey,
    );
  });

  it("reproduces the recovery wrap", async () => {
    const { recovery } = vault;
    const keys = vectorKeys();
    const random = scriptedRandom(recovery.random);
    expect(wrapVaultKeyForRecovery(keys, recovery.ownerId, vaultKey, { random })).toEqual({
      recoveryKeyVersion: recovery.recoveryKeyVersion,
      wrapped: recovery.wrapped,
    });
    expect(toHex(unwrapVaultKeyWithRecovery(keys, recovery.ownerId, recovery))).toBe(
      vault.vaultKey,
    );
    expect(
      toHex(await webCryptoUnwrap(fromHex(recovery.wrappingKey), recovery.wrapped, recovery.aad)),
    ).toBe(vault.vaultKey);
  });

  it("reproduces the session wrap", async () => {
    const { session } = vault;
    const random = scriptedRandom(session.random);
    expect(
      wrapVaultKeyForSession(session.sessionToken, session.context, vaultKey, { random }),
    ).toBe(session.wrapped);
    expect(
      toHex(unwrapVaultKeyForSession(session.sessionToken, session.context, session.wrapped)),
    ).toBe(vault.vaultKey);
    expect(
      toHex(await webCryptoUnwrap(fromHex(session.wrappingKey), session.wrapped, session.aad)),
    ).toBe(vault.vaultKey);
  });

  it("reproduces the item envelope", async () => {
    const { item } = vault;
    const random = scriptedRandom(item.random);
    expect(encryptVaultItem(vaultKey, item.context, fromHex(item.plaintextHex), { random })).toBe(
      item.envelope,
    );
    expect(toHex(decryptVaultItem(vaultKey, item.context, item.envelope))).toBe(item.plaintextHex);
    const { iv, sealed } = parseFieldEnvelope(item.envelope);
    expect(toHex(await webCryptoOpen(vaultKey, iv, sealed, item.aad))).toBe(item.plaintextHex);
  });

  it("reproduces the grant value envelope", async () => {
    const { grant } = vault;
    const key = { ownerId: grant.context.ownerId, kekVersion: 2, key: fromHex(grant.dataKey) };
    const random = scriptedRandom(grant.random);
    expect(
      encryptVaultGrantValue(key, grant.context, fromHex(grant.plaintextHex), { random }),
    ).toBe(grant.envelope);
    expect(utf8(decryptVaultGrantValue(key, grant.context, grant.envelope))).toBe(
      utf8(fromHex(grant.plaintextHex)),
    );
    const { iv, sealed } = parseFieldEnvelope(grant.envelope);
    expect(toHex(await webCryptoOpen(key.key, iv, sealed, grant.aad))).toBe(grant.plaintextHex);
  });
});
