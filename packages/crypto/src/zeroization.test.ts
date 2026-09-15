import * as nodeCrypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expectCryptoError,
  flipBase64UrlBit,
  randomAccountKey,
  scriptedRandom,
} from "../test/support.ts";
import {
  createAccountKey,
  decryptField,
  decryptObject,
  encryptField,
  encryptObject,
  rewrapAccountKey,
  unwrapAccountKey,
} from "./envelopes.ts";
import { DecryptionFailedError } from "./errors.ts";
import { createKeyProvider } from "./key-provider.ts";
import { unwrapVaultKeyForSession, wrapVaultKeyForSession } from "./vault.ts";

/** Buffers returned by `decipher.update` and ArrayBuffers returned by `hkdfSync`, in call order. */
const decipherOutputs: Buffer[] = [];
const hkdfOutputs: ArrayBuffer[] = [];

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    createDecipheriv: vi.fn((...args: Parameters<typeof actual.createDecipheriv>) => {
      const decipher = actual.createDecipheriv(...args);
      const update = decipher.update.bind(decipher) as (data: Uint8Array) => Buffer;
      (decipher as unknown as { update: (data: Uint8Array) => Buffer }).update = (data) => {
        const output = update(data);
        decipherOutputs.push(output);
        return output;
      };
      return decipher;
    }),
    hkdfSync: vi.fn((...args: Parameters<typeof actual.hkdfSync>) => {
      const output = actual.hkdfSync(...args);
      hkdfOutputs.push(output);
      return output;
    }),
  };
});

afterEach(() => {
  decipherOutputs.length = 0;
  hkdfOutputs.length = 0;
});

const isZero = (buffer: ArrayBuffer): boolean => new Uint8Array(buffer).every((byte) => byte === 0);

const owner = "owner-zeroise";
const marker = Buffer.from("ZEROISE-MARKER-plaintext", "utf8");
const context = {
  purpose: "title",
  ownerId: owner,
  table: "tasks",
  rowId: "r",
  column: "title_enc",
};
const objectContext = { kind: "artifact", ownerId: owner, objectId: "o", formatVersion: 1 };

describe("zeroisation", () => {
  it("wipes the unauthenticated output of a failed field decryption", () => {
    const key = randomAccountKey(owner);
    const envelope = encryptField(key, context, marker);
    const [format, version, iv, body] = envelope.split(".");
    const tampered = [format, version, iv, flipBase64UrlBit(body ?? "", marker.byteLength)].join(
      ".",
    );
    expectCryptoError(() => decryptField(key, context, tampered), DecryptionFailedError);
    expect(decipherOutputs).toHaveLength(1);
    const output = decipherOutputs[0] ?? Buffer.alloc(1, 1);
    expect(output.byteLength).toBe(marker.byteLength);
    expect(output.every((byte) => byte === 0)).toBe(true);
  });

  it("wipes the object key after encrypting and decrypting an object", () => {
    const key = randomAccountKey(owner);
    const objectKey = Buffer.from(nodeCrypto.randomBytes(32));
    const random = scriptedRandom([
      objectKey.toString("hex"),
      nodeCrypto.randomBytes(12).toString("hex"),
      nodeCrypto.randomBytes(12).toString("hex"),
    ]);
    // scriptedRandom hands out fresh buffers, so capture the one it returns for the object key.
    let drawn: Uint8Array | undefined;
    const envelope = encryptObject(key, objectContext, marker, {
      random: (length) => {
        const bytes = random(length);
        drawn ??= bytes;
        return bytes;
      },
    });
    expect(drawn?.every((byte) => byte === 0)).toBe(true);

    const plaintext = decryptObject(key, objectContext, envelope);
    expect(Buffer.from(plaintext).equals(marker)).toBe(true);
    expect(decipherOutputs).toHaveLength(2);
    const [unwrappedObjectKey] = decipherOutputs;
    expect(unwrappedObjectKey?.byteLength).toBe(32);
    expect(unwrappedObjectKey?.every((byte) => byte === 0)).toBe(true);
  });

  it("wipes HKDF-derived wrapping keys after account key and Vault session operations", () => {
    const keys = createKeyProvider({
      CONTENT_KEK: {
        current: 2,
        versions: new Map([
          [1, nodeCrypto.randomBytes(32)],
          [2, nodeCrypto.randomBytes(32)],
        ]),
      },
    });
    const { wrapped } = createAccountKey(keys, owner);
    unwrapAccountKey(keys, wrapped);
    rewrapAccountKey(keys, wrapped);
    const token = nodeCrypto.randomBytes(32).toString("base64url");
    const vaultKey = nodeCrypto.randomBytes(32);
    const sessionContext = { ownerId: owner, vaultSessionId: "vs" };
    unwrapVaultKeyForSession(
      token,
      sessionContext,
      wrapVaultKeyForSession(token, sessionContext, vaultKey),
    );

    expect(hkdfOutputs.length).toBeGreaterThanOrEqual(5);
    for (const output of hkdfOutputs) expect(isZero(output)).toBe(true);
  });
});
