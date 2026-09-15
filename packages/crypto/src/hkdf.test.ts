import { randomBytes, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { expectCryptoError, fromHex, toHex, vectors } from "../test/support.ts";
import { InvalidCryptoInputError } from "./errors.ts";
import { deriveKey, HKDF_LABELS, type HkdfLabel } from "./hkdf.ts";

async function webCryptoHkdf(ikm: Uint8Array, label: string): Promise<string> {
  const base = await webcrypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await webcrypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: Buffer.from(label, "utf8") },
    base,
    256,
  );
  return toHex(new Uint8Array(bits));
}

describe("deriveKey", () => {
  it("uses exactly the fixed labels", () => {
    expect(Object.values(HKDF_LABELS).sort()).toEqual([
      "symplist/account-key/v1",
      "symplist/approval-args/v1",
      "symplist/email-suppression/v1",
      "symplist/vault-recovery/v1",
      "symplist/vault-session/v1",
    ]);
    expect(vectors.hkdf.map((vector) => vector.label).sort()).toEqual(
      Object.values(HKDF_LABELS).sort(),
    );
  });

  it.each(vectors.hkdf.map((vector) => [vector.label, vector] as const))(
    "matches the frozen vector and WebCrypto for %s",
    async (label, vector) => {
      const ikm = fromHex(vector.ikm);
      expect(toHex(deriveKey(ikm, label as HkdfLabel))).toBe(vector.output);
      expect(await webCryptoHkdf(ikm, label)).toBe(vector.output);
    },
  );

  it("gives each label an independent key", () => {
    const ikm = randomBytes(32);
    const outputs = Object.values(HKDF_LABELS).map((label) => toHex(deriveKey(ikm, label)));
    expect(new Set(outputs).size).toBe(outputs.length);
  });

  it("rejects labels outside the fixed set", () => {
    expectCryptoError(
      () => deriveKey(randomBytes(32), "symplist/other/v1" as HkdfLabel),
      InvalidCryptoInputError,
    );
  });

  it("rejects input keys that are not 32 bytes", () => {
    for (const length of [0, 16, 31, 33]) {
      expectCryptoError(
        () => deriveKey(randomBytes(length), HKDF_LABELS.accountKey),
        InvalidCryptoInputError,
      );
    }
    expectCryptoError(
      () => deriveKey("x".repeat(32) as unknown as Uint8Array, HKDF_LABELS.accountKey),
      InvalidCryptoInputError,
    );
  });
});
