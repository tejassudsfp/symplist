import * as nodeCrypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  expectCryptoError,
  expectCryptoRejection,
  fromHex,
  scriptedRandom,
  vectors,
} from "../test/support.ts";
import {
  Argon2UnavailableError,
  InputTooLargeError,
  InvalidCryptoInputError,
  InvalidPasswordHashError,
  RateLimitedError,
} from "./errors.ts";
import {
  ARGON2ID_PARAMETERS,
  type Argon2idHash,
  assertArgon2Available,
  createArgon2idParameters,
  deriveArgon2idKey,
  hashArgon2id,
  MAX_ARGON2_SECRET_BYTES,
  parseArgon2idHash,
  parseArgon2idParameters,
  verifyArgon2id,
} from "./passwords.ts";
import { Argon2Semaphore, argon2Semaphore } from "./semaphore.ts";

describe("Argon2id runtime", () => {
  it("passes the RFC 9106 Argon2id known-answer test", () => {
    const tag = nodeCrypto.argon2Sync("argon2id", {
      message: Buffer.alloc(32, 0x01),
      nonce: Buffer.alloc(16, 0x02),
      secret: Buffer.alloc(8, 0x03),
      associatedData: Buffer.alloc(12, 0x04),
      memory: 32,
      passes: 3,
      parallelism: 4,
      tagLength: 32,
    });
    expect(tag.toString("hex")).toBe(
      "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659",
    );
  });

  it("fails startup when crypto.argon2 is missing", () => {
    expect(() => assertArgon2Available()).not.toThrow();
    expect(() => assertArgon2Available({ argon2: nodeCrypto.argon2 })).not.toThrow();
    const error = expectCryptoError(() => assertArgon2Available({}), Argon2UnavailableError);
    expect(error.code).toBe("crypto.argon2_unavailable");
    expectCryptoError(
      () => assertArgon2Available({ argon2: "not a function" }),
      Argon2UnavailableError,
    );
  });
});

describe("hashArgon2id and verifyArgon2id", () => {
  it.each(vectors.argon2id.map((vector) => [vector.name, vector] as const))(
    "reproduces the frozen %s vector",
    async (_name, vector) => {
      const record = await hashArgon2id(vector.secret, { random: scriptedRandom([vector.salt]) });
      expect(record).toEqual(vector.record);
      expect(await verifyArgon2id(vector.secret, vector.record)).toBe(true);
      const direct = nodeCrypto.argon2Sync("argon2id", {
        message: Buffer.from(vector.normalized ?? vector.secret, "utf8"),
        nonce: fromHex(vector.salt),
        memory: 19456,
        passes: 2,
        parallelism: 1,
        tagLength: 32,
      });
      expect(direct.toString("base64url")).toBe(vector.record.hash);
    },
  );

  it("stores {v, alg, m, t, p, salt, hash} with the §4.3 parameters and a random salt", async () => {
    const first = await hashArgon2id("share password");
    const second = await hashArgon2id("share password");
    expect(Object.keys(first).sort()).toEqual(["alg", "hash", "m", "p", "salt", "t", "v"]);
    expect(first).toMatchObject({ v: 1, alg: "argon2id", m: 19456, t: 2, p: 1 });
    expect(Buffer.from(first.salt, "base64url")).toHaveLength(16);
    expect(Buffer.from(first.hash, "base64url")).toHaveLength(32);
    expect(first.salt).not.toBe(second.salt);
    expect(first.hash).not.toBe(second.hash);
    expect(ARGON2ID_PARAMETERS).toEqual({
      v: 1,
      alg: "argon2id",
      m: 19456,
      t: 2,
      p: 1,
      saltBytes: 16,
      hashBytes: 32,
    });
  });

  it("verifies only the right secret", async () => {
    const record = await hashArgon2id("share password");
    expect(await verifyArgon2id("share password", record)).toBe(true);
    expect(await verifyArgon2id("share passworD", record)).toBe(false);
    expect(await verifyArgon2id("", record)).toBe(false);
    const otherSalt = { ...record, salt: createArgon2idParameters().salt };
    expect(await verifyArgon2id("share password", otherSalt)).toBe(false);
  });

  it("normalizes secrets with NFKC so equivalent input verifies", async () => {
    const record = await hashArgon2id("café");
    expect(await verifyArgon2id("café", record)).toBe(true);
  });

  it("rejects secrets that are too long or not well-formed", async () => {
    await expectCryptoRejection(
      () => hashArgon2id("a".repeat(MAX_ARGON2_SECRET_BYTES + 1)),
      InputTooLargeError,
    );
    await expectCryptoRejection(
      () => hashArgon2id("é".repeat(MAX_ARGON2_SECRET_BYTES / 2 + 1)),
      InputTooLargeError,
    );
    await expectCryptoRejection(() => hashArgon2id("bad \udfff"), InvalidCryptoInputError);
    await expectCryptoRejection(() => hashArgon2id(42 as never), InvalidCryptoInputError);
    expect((await hashArgon2id("a".repeat(MAX_ARGON2_SECRET_BYTES))).hash).toHaveLength(43);
  });
});

describe("stored parameter verification", () => {
  const valid: Argon2idHash = vectors.argon2id[0]?.record as Argon2idHash;

  it.each([
    ["an unknown version", { v: 2 }],
    ["another algorithm", { alg: "argon2i" }],
    ["weaker memory", { m: 8 }],
    ["inflated memory", { m: 4 * 1024 * 1024 }],
    ["fewer iterations", { t: 1 }],
    ["more iterations", { t: 1000 }],
    ["other parallelism", { p: 4 }],
    ["string parameters", { m: "19456" }],
    ["a 15-byte salt", { salt: nodeCrypto.randomBytes(15).toString("base64url") }],
    ["a 17-byte salt", { salt: nodeCrypto.randomBytes(17).toString("base64url") }],
    ["a non-base64url salt", { salt: "!".repeat(22) }],
    ["a 31-byte hash", { hash: nodeCrypto.randomBytes(31).toString("base64url") }],
    ["a padded hash", { hash: `${valid.hash}=` }],
    ["an extra field", { pepper: "x" }],
  ])("rejects %s before running Argon2id", async (_label, change) => {
    // The only slot is held and nothing may queue, so reaching the semaphore (and so Argon2id) at all
    // would fail with rate.limited instead of the record error.
    const semaphore = new Argon2Semaphore({ maxConcurrent: 1, maxQueue: 0, retryAfterSeconds: 1 });
    let release: () => void = () => undefined;
    const held = semaphore.run(() => new Promise<void>((resolve) => (release = resolve)));
    try {
      const record = { ...valid, ...change } as unknown as Argon2idHash;
      expectCryptoError(() => parseArgon2idHash(record), InvalidPasswordHashError);
      await expectCryptoRejection(
        () => verifyArgon2id("secret", record, { semaphore }),
        InvalidPasswordHashError,
      );
      if (!("hash" in change)) {
        // Every other change also invalidates the salt-and-parameters record used for Vault keys.
        const { hash: _hash, ...parameters } = record;
        await expectCryptoRejection(
          () => deriveArgon2idKey("secret", parameters as never, { semaphore }),
          InvalidPasswordHashError,
        );
      }
      expect(semaphore.active).toBe(1);
    } finally {
      release();
      await held;
    }
  });

  it("rejects missing fields and non-objects", async () => {
    const { hash: _hash, ...withoutHash } = valid;
    for (const record of [withoutHash, null, [], "record", { ...valid, salt: undefined }]) {
      await expectCryptoRejection(
        () => verifyArgon2id("secret", record as unknown as Argon2idHash),
        InvalidPasswordHashError,
      );
    }
    expect(parseArgon2idHash(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
  });

  it("parses key-derivation parameters only without a hash", () => {
    const parameters = createArgon2idParameters();
    expect(parseArgon2idParameters(parameters)).toEqual(parameters);
    expectCryptoError(() => parseArgon2idParameters(valid), InvalidPasswordHashError);
    expectCryptoError(
      () => parseArgon2idParameters({ ...parameters, m: 1024 }),
      InvalidPasswordHashError,
    );
  });
});

describe("deriveArgon2idKey", () => {
  it("derives the same 32 bytes as the verifier for the same salt and parameters", async () => {
    const vector = vectors.argon2id[0];
    if (!vector) throw new Error("missing vector");
    const { hash: _hash, ...parameters } = vector.record;
    const key = await deriveArgon2idKey(vector.secret, parameters);
    expect(key).toHaveLength(32);
    expect(Buffer.from(key).toString("base64url")).toBe(vector.record.hash);
    const other = await deriveArgon2idKey(`${vector.secret}!`, parameters);
    expect(Buffer.from(other).equals(Buffer.from(key))).toBe(false);
  });

  it("creates fresh parameters with an injectable salt", () => {
    const salt = "00112233445566778899aabbccddeeff";
    expect(createArgon2idParameters({ random: scriptedRandom([salt]) })).toEqual({
      v: 1,
      alg: "argon2id",
      m: 19456,
      t: 2,
      p: 1,
      salt: fromHex(salt).toString("base64url"),
    });
  });
});

describe("process-wide Argon2id semaphore", () => {
  it("allows 2 concurrent operations and a queue of 16, then refuses with rate.limited", async () => {
    let peak = 0;
    const observe = setInterval(() => {
      peak = Math.max(peak, argon2Semaphore.active);
    }, 1);
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 19 }, (_unused, index) => hashArgon2id(`secret-${index}`)),
      );
      const refused = results.filter((result) => result.status === "rejected");
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(18);
      expect(refused).toHaveLength(1);
      const reason = (refused[0] as PromiseRejectedResult).reason as RateLimitedError;
      expect(reason).toBeInstanceOf(RateLimitedError);
      expect(reason.code).toBe("rate.limited");
      expect(reason.retryAfter).toBe(1);
      expect(results[18]?.status).toBe("rejected");
    } finally {
      clearInterval(observe);
    }
    expect(peak).toBeLessThanOrEqual(2);
    expect(argon2Semaphore.active).toBe(0);
    expect(argon2Semaphore.queued).toBe(0);
  });

  it("routes verification and key derivation through the semaphore", async () => {
    const semaphore = new Argon2Semaphore({ maxConcurrent: 1, maxQueue: 0, retryAfterSeconds: 2 });
    const record = vectors.argon2id[0]?.record as Argon2idHash;
    const { hash: _hash, ...parameters } = record;
    const running = hashArgon2id("hold the slot", { semaphore });
    await expectCryptoRejection(() => verifyArgon2id("x", record, { semaphore }), RateLimitedError);
    await expectCryptoRejection(
      () => deriveArgon2idKey("x", parameters, { semaphore }),
      RateLimitedError,
    );
    await expectCryptoRejection(() => hashArgon2id("x", { semaphore }), RateLimitedError);
    await running;
    expect(await verifyArgon2id(vectors.argon2id[0]?.secret ?? "", record, { semaphore })).toBe(
      true,
    );
  });
});
