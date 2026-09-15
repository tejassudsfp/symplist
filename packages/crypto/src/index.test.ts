import { describe, expect, it } from "vitest";
import * as crypto from "./index.ts";

describe("@symplist/crypto public API", () => {
  it("keeps every foundation contract export", () => {
    for (const name of [
      "computeDigest",
      "computeDigestCandidates",
      "verifyDigest",
      "encodeAad",
      "encryptField",
      "decryptField",
      "encryptObject",
      "decryptObject",
      "createAccountKey",
      "unwrapAccountKey",
      "NotImplementedError",
      "hashArgon2id",
      "verifyArgon2id",
      "deriveArgon2idKey",
      "generateToken",
      "generateOtp",
    ]) {
      expect(crypto).toHaveProperty(name);
      expect(typeof (crypto as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it("implements every former stub", async () => {
    const keys = crypto.createKeyProvider({
      CONTENT_KEK: { current: 1, versions: new Map([[1, crypto.generateToken()]]) },
      SESSION_DIGEST_SECRET: { current: 1, versions: new Map([[1, crypto.generateToken()]]) },
    });
    const { key, wrapped } = crypto.createAccountKey(keys, "owner");
    expect(crypto.unwrapAccountKey(keys, wrapped).ownerId).toBe("owner");
    const context = {
      purpose: "title",
      ownerId: "owner",
      table: "tasks",
      rowId: "t",
      column: "title_enc",
    };
    const field = crypto.encryptField(key, context, Buffer.from("x"));
    expect(Buffer.from(crypto.decryptField(key, context, field)).toString()).toBe("x");
    const objectContext = { kind: "artifact", ownerId: "owner", objectId: "a", formatVersion: 1 };
    const object = crypto.encryptObject(key, objectContext, Buffer.from("y"));
    expect(Buffer.from(crypto.decryptObject(key, objectContext, object)).toString()).toBe("y");
    expect(crypto.encodeAad({ f: "sym1", p: "x" })).toBeInstanceOf(Uint8Array);
    const digest = crypto.computeDigest(keys, "SESSION_DIGEST_SECRET", "session", "v");
    expect(crypto.computeDigestCandidates(keys, "SESSION_DIGEST_SECRET", "session", "v")).toEqual([
      digest,
    ]);
    expect(crypto.verifyDigest(keys, "SESSION_DIGEST_SECRET", "session", "v", digest)).toBe(true);
    const hash = await crypto.hashArgon2id("pw");
    expect(await crypto.verifyArgon2id("pw", hash)).toBe(true);
    const { hash: _hash, ...parameters } = hash;
    expect(await crypto.deriveArgon2idKey("pw", parameters)).toHaveLength(32);
    expect(crypto.generateToken()).toHaveLength(43);
    expect(crypto.generateOtp(6)).toMatch(/^\d{6}$/);
  });

  it("does not export internal GCM primitives", () => {
    for (const name of [
      "sealAesGcm",
      "openAesGcm",
      "wrapKey",
      "unwrapKey",
      "sealSym1",
      "openSym1",
      "drawRandom",
    ]) {
      expect(crypto).not.toHaveProperty(name);
    }
  });
});
