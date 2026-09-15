import { randomBytes, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  expectCryptoError,
  fromHex,
  randomAccountKey,
  vectorKeys,
  vectors,
} from "../test/support.ts";
import {
  computeApprovalArgsDigest,
  computeDigest,
  computeDigestCandidates,
  computeEmailSuppressionDigest,
  computeEmailSuppressionDigestCandidates,
  computeIdempotencyFingerprint,
  computeOtpDigest,
  DIGEST_PURPOSE_FAMILY,
  type DigestPurpose,
  digestNeedsRotation,
  hmacSha256,
  MAX_DIGEST_INPUT_BYTES,
  type OtpPurpose,
  verifyApprovalArgsDigest,
  verifyDigest,
  verifyOtpDigest,
} from "./digests.ts";
import { constantTimeEqual } from "./encoding.ts";
import { InputTooLargeError, InvalidCryptoInputError, KeyUnavailableError } from "./errors.ts";
import { createKeyProvider } from "./key-provider.ts";
import type { KeyFamily } from "./keys.ts";

async function webCryptoDigest(
  key: Uint8Array,
  purpose: string,
  value: Uint8Array,
): Promise<string> {
  const hmacKey = await webcrypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = Buffer.concat([Buffer.from(purpose, "ascii"), Buffer.from([0x00]), value]);
  return Buffer.from(await webcrypto.subtle.sign("HMAC", hmacKey, message)).toString("base64url");
}

describe("versioned HMAC digests (§4.3)", () => {
  const keys = vectorKeys();

  it("maps every purpose in the architecture table to its family", () => {
    expect(DIGEST_PURPOSE_FAMILY).toEqual({
      session: "SESSION_DIGEST_SECRET",
      csrf: "SESSION_DIGEST_SECRET",
      "vault-session": "SESSION_DIGEST_SECRET",
      otp: "OTP_DIGEST_SECRET",
      "otp-limit-email": "OTP_DIGEST_SECRET",
      "account-tombstone": "OTP_DIGEST_SECRET",
      invite: "INVITE_DIGEST_SECRET",
      "share-token": "SHARE_DIGEST_SECRET",
      "share-form": "SHARE_DIGEST_SECRET",
      "share-session": "SHARE_SESSION_DIGEST_SECRET",
      "mcp-key": "MCP_TOKEN_DIGEST_SECRET",
      "oauth-code": "MCP_TOKEN_DIGEST_SECRET",
      "oauth-refresh": "MCP_TOKEN_DIGEST_SECRET",
      idem: "IDEMPOTENCY_SECRET",
      "reminder-unsubscribe": "REMINDER_UNSUBSCRIBE_SECRET",
    });
    const covered = new Set(vectors.digests.map((vector) => vector.purpose));
    expect(covered).toEqual(new Set(Object.keys(DIGEST_PURPOSE_FAMILY)));
  });

  it.each(
    vectors.digests.map((vector) => [`${vector.purpose} v${vector.version}`, vector] as const),
  )("matches the frozen vector and WebCrypto for %s", async (_label, vector) => {
    const value =
      vector.valueHex === undefined ? (vector.valueText ?? "") : fromHex(vector.valueHex);
    const purpose = vector.purpose as DigestPurpose;
    const candidates = computeDigestCandidates(keys, vector.family, purpose, value);
    expect(candidates.find((candidate) => candidate.version === vector.version)?.digest).toBe(
      vector.digest,
    );
    expect(verifyDigest(keys, vector.family, purpose, value, vector)).toBe(true);
    const secret = keys.get(vector.family, vector.version)?.key ?? new Uint8Array();
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    expect(await webCryptoDigest(secret, vector.purpose, bytes)).toBe(vector.digest);
  });

  it("digests under the current version and lists candidates newest first", () => {
    const digest = computeDigest(keys, "SESSION_DIGEST_SECRET", "session", "token");
    expect(digest.version).toBe(2);
    expect(digest.digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const candidates = computeDigestCandidates(keys, "SESSION_DIGEST_SECRET", "session", "token");
    expect(candidates.map((candidate) => candidate.version)).toEqual([2, 1]);
    expect(candidates[0]).toEqual(digest);
    expect(new Set(candidates.map((candidate) => candidate.digest)).size).toBe(2);
  });

  it("verifies under an older configured version and flags it for rotation", () => {
    const old = computeDigestCandidates(keys, "SESSION_DIGEST_SECRET", "session", "token")[1];
    if (!old) throw new Error("missing candidate");
    expect(verifyDigest(keys, "SESSION_DIGEST_SECRET", "session", "token", old)).toBe(true);
    expect(digestNeedsRotation(keys, "SESSION_DIGEST_SECRET", old)).toBe(true);
    const current = computeDigest(keys, "SESSION_DIGEST_SECRET", "session", "token");
    expect(digestNeedsRotation(keys, "SESSION_DIGEST_SECRET", current)).toBe(false);
  });

  it("does not verify a wrong value, a wrong version or a retired version", () => {
    const stored = computeDigest(keys, "SESSION_DIGEST_SECRET", "session", "token");
    expect(verifyDigest(keys, "SESSION_DIGEST_SECRET", "session", "token2", stored)).toBe(false);
    expect(
      verifyDigest(keys, "SESSION_DIGEST_SECRET", "session", "token", { ...stored, version: 1 }),
    ).toBe(false);
    expect(
      verifyDigest(keys, "SESSION_DIGEST_SECRET", "session", "token", { ...stored, version: 9 }),
    ).toBe(false);
  });

  it("separates purposes that share a family", () => {
    const values = (["session", "csrf", "vault-session"] as const).map(
      (purpose) => computeDigest(keys, "SESSION_DIGEST_SECRET", purpose, "same").digest,
    );
    expect(new Set(values).size).toBe(3);
    const session = computeDigest(keys, "SESSION_DIGEST_SECRET", "session", "same");
    expect(verifyDigest(keys, "SESSION_DIGEST_SECRET", "csrf", "same", session)).toBe(false);
  });

  it("frames purpose and value so boundaries cannot shift", () => {
    const a = computeDigest(keys, "SESSION_DIGEST_SECRET", "session", "\u0000x").digest;
    const b = computeDigest(keys, "SESSION_DIGEST_SECRET", "session", "x").digest;
    expect(a).not.toBe(b);
  });

  it("refuses a purpose with the wrong family and unknown purposes", () => {
    for (const [purpose, family] of Object.entries(DIGEST_PURPOSE_FAMILY)) {
      const wrong: KeyFamily =
        family === "SESSION_DIGEST_SECRET" ? "OTP_DIGEST_SECRET" : "SESSION_DIGEST_SECRET";
      expectCryptoError(
        () => computeDigest(keys, wrong, purpose as DigestPurpose, "v"),
        InvalidCryptoInputError,
      );
    }
    expectCryptoError(
      () => computeDigest(keys, "SESSION_DIGEST_SECRET", "approval-args" as DigestPurpose, "v"),
      InvalidCryptoInputError,
    );
    expectCryptoError(
      () => computeDigest(keys, "SESSION_DIGEST_SECRET", "toString" as DigestPurpose, "v"),
      InvalidCryptoInputError,
    );
  });

  it("rejects malformed stored digests and inputs", () => {
    for (const stored of [
      { version: 1, digest: "short" },
      { version: 1, digest: `${"A".repeat(42)}B` },
      { version: 1.5, digest: "A".repeat(43) },
      null,
    ]) {
      expectCryptoError(
        () => verifyDigest(keys, "SESSION_DIGEST_SECRET", "session", "v", stored as never),
        InvalidCryptoInputError,
      );
    }
    expectCryptoError(
      () => computeDigest(keys, "SESSION_DIGEST_SECRET", "session", "\ud800"),
      InvalidCryptoInputError,
    );
    expectCryptoError(
      () => computeDigest(keys, "SESSION_DIGEST_SECRET", "session", 42 as never),
      InvalidCryptoInputError,
    );
  });

  it("rejects oversized inputs", () => {
    expectCryptoError(
      () =>
        computeDigest(keys, "IDEMPOTENCY_SECRET", "idem", "a".repeat(MAX_DIGEST_INPUT_BYTES + 1)),
      InputTooLargeError,
    );
    expectCryptoError(
      () =>
        computeDigest(
          keys,
          "IDEMPOTENCY_SECRET",
          "idem",
          "é".repeat(MAX_DIGEST_INPUT_BYTES / 2 + 1),
        ),
      InputTooLargeError,
    );
    expectCryptoError(
      () =>
        computeDigest(
          keys,
          "IDEMPOTENCY_SECRET",
          "idem",
          new Uint8Array(MAX_DIGEST_INPUT_BYTES + 1),
        ),
      InputTooLargeError,
    );
    expect(
      computeDigest(keys, "IDEMPOTENCY_SECRET", "idem", new Uint8Array(MAX_DIGEST_INPUT_BYTES))
        .version,
    ).toBe(1);
  });

  it("fails when the family is not configured", () => {
    const empty = createKeyProvider({});
    expectCryptoError(
      () => computeDigest(empty, "INVITE_DIGEST_SECRET", "invite", "v"),
      KeyUnavailableError,
    );
    expectCryptoError(
      () => computeDigestCandidates(empty, "INVITE_DIGEST_SECRET", "invite", "v"),
      KeyUnavailableError,
    );
    expectCryptoError(
      () =>
        computeDigestCandidates(
          {
            current: () => ({ version: 1, key: randomBytes(32) }),
            get: () => undefined,
            all: () => [],
          },
          "INVITE_DIGEST_SECRET",
          "invite",
          "v",
        ),
      KeyUnavailableError,
    );
  });
});

describe("OTP digests", () => {
  const keys = vectorKeys();

  it.each(vectors.otp.map((vector) => [vector.purpose, vector] as const))(
    "matches the frozen %s vector",
    (_label, vector) => {
      expect(vector.value).toBe(JSON.stringify([vector.challengeId, vector.purpose, vector.code]));
      expect(computeOtpDigest(keys, vector)).toEqual({
        version: vector.version,
        digest: vector.digest,
      });
      expect(computeDigest(keys, "OTP_DIGEST_SECRET", "otp", vector.value).digest).toBe(
        vector.digest,
      );
      expect(verifyOtpDigest(keys, vector, vector)).toBe(true);
    },
  );

  it("binds the code to its challenge and purpose", () => {
    const input = { challengeId: "challenge-1", purpose: "login" as OtpPurpose, code: "123456" };
    const stored = computeOtpDigest(keys, input);
    expect(verifyOtpDigest(keys, input, stored)).toBe(true);
    expect(verifyOtpDigest(keys, { ...input, code: "123457" }, stored)).toBe(false);
    expect(verifyOtpDigest(keys, { ...input, challengeId: "challenge-2" }, stored)).toBe(false);
    expect(verifyOtpDigest(keys, { ...input, purpose: "signup" }, stored)).toBe(false);
  });

  it("rejects unknown purposes and empty challenge ids", () => {
    expectCryptoError(
      () => computeOtpDigest(keys, { challengeId: "c", purpose: "reset" as OtpPurpose, code: "1" }),
      InvalidCryptoInputError,
    );
    expectCryptoError(
      () => computeOtpDigest(keys, { challengeId: "", purpose: "login", code: "1" }),
      InvalidCryptoInputError,
    );
    expectCryptoError(
      () => computeOtpDigest(keys, { challengeId: "c", purpose: "login", code: 1 as never }),
      InvalidCryptoInputError,
    );
  });
});

describe("idempotency fingerprints", () => {
  const keys = vectorKeys();

  it("matches the frozen vector over canonical JSON", () => {
    for (const vector of vectors.idempotency) {
      expect(computeIdempotencyFingerprint(keys, vector.input)).toEqual({
        version: vector.version,
        digest: vector.digest,
      });
      expect(computeDigest(keys, "IDEMPOTENCY_SECRET", "idem", vector.canonical).digest).toBe(
        vector.digest,
      );
    }
  });

  it("ignores key order and distinguishes different inputs", () => {
    const a = computeIdempotencyFingerprint(keys, { title: "a", collection: "now" });
    const b = computeIdempotencyFingerprint(keys, { collection: "now", title: "a" });
    const c = computeIdempotencyFingerprint(keys, { collection: "now", title: "b" });
    expect(a).toEqual(b);
    expect(a.digest).not.toBe(c.digest);
  });
});

describe("approval argument digests", () => {
  it("matches the frozen vector and WebCrypto", async () => {
    for (const vector of vectors.approvalArgs) {
      const key = { ownerId: "owner", kekVersion: 2, key: fromHex(vector.dataKey) };
      expect(computeApprovalArgsDigest(key, vector.input)).toBe(vector.digest);
      expect(verifyApprovalArgsDigest(key, vector.input, vector.digest)).toBe(true);
      expect(
        await webCryptoDigest(
          fromHex(vector.digestKey),
          "approval-args",
          Buffer.from(vector.canonical),
        ),
      ).toBe(vector.digest);
    }
  });

  it("changes with the slug, connected account, arguments or account key", () => {
    const key = randomAccountKey("owner");
    const input = {
      toolSlug: "GMAIL_SEND_EMAIL",
      connectedAccountId: "ca_1",
      arguments: { to: "a@b.test" },
    };
    const digest = computeApprovalArgsDigest(key, input);
    expect(verifyApprovalArgsDigest(key, { ...input, toolSlug: "GMAIL_DELETE" }, digest)).toBe(
      false,
    );
    expect(verifyApprovalArgsDigest(key, { ...input, connectedAccountId: "ca_2" }, digest)).toBe(
      false,
    );
    expect(verifyApprovalArgsDigest(key, { ...input, connectedAccountId: null }, digest)).toBe(
      false,
    );
    expect(verifyApprovalArgsDigest(key, { ...input, arguments: { to: "c@d.test" } }, digest)).toBe(
      false,
    );
    expect(verifyApprovalArgsDigest(randomAccountKey("owner"), input, digest)).toBe(false);
    expect(verifyApprovalArgsDigest(key, input, "not-a-digest")).toBe(false);
    expect(verifyApprovalArgsDigest(key, input, 7 as never)).toBe(false);
    expect(
      verifyApprovalArgsDigest(
        key,
        { ...input, arguments: { to: "a@b.test", extra: undefined } },
        digest,
      ),
    ).toBe(true);
  });

  it("rejects invalid inputs", () => {
    const key = randomAccountKey("owner");
    expectCryptoError(
      () =>
        computeApprovalArgsDigest(key, { toolSlug: "", connectedAccountId: null, arguments: {} }),
      InvalidCryptoInputError,
    );
    expectCryptoError(
      () =>
        computeApprovalArgsDigest(key, {
          toolSlug: "X",
          connectedAccountId: 1 as never,
          arguments: {},
        }),
      InvalidCryptoInputError,
    );
    expectCryptoError(
      () =>
        computeApprovalArgsDigest(key, {
          toolSlug: "X",
          connectedAccountId: null,
          arguments: new Date(),
        }),
      InvalidCryptoInputError,
    );
    expectCryptoError(
      () =>
        computeApprovalArgsDigest(
          { ...key, key: randomBytes(8) },
          { toolSlug: "X", connectedAccountId: null, arguments: {} },
        ),
      InvalidCryptoInputError,
    );
  });
});

describe("email suppression digests", () => {
  const keys = vectorKeys();

  it("matches the frozen vectors under every CONTENT_KEK version", () => {
    const candidates = computeEmailSuppressionDigestCandidates(keys, "maya@example.test");
    expect(candidates).toEqual(
      vectors.emailSuppression.map((vector) => ({
        version: vector.version,
        digest: vector.digest,
      })),
    );
    expect(candidates.map((candidate) => candidate.version)).toEqual([2, 1]);
    expect(computeEmailSuppressionDigest(keys, "maya@example.test")).toEqual(candidates[0]);
  });

  it("is not the same as a plain digest or another address", () => {
    const suppression = computeEmailSuppressionDigest(keys, "maya@example.test");
    expect(computeEmailSuppressionDigest(keys, "maya2@example.test").digest).not.toBe(
      suppression.digest,
    );
    expect(
      computeDigest(keys, "OTP_DIGEST_SECRET", "otp-limit-email", "maya@example.test").digest,
    ).not.toBe(suppression.digest);
    expectCryptoError(() => computeEmailSuppressionDigest(keys, ""), InvalidCryptoInputError);
    expectCryptoError(
      () => computeEmailSuppressionDigestCandidates(createKeyProvider({}), "maya@example.test"),
      KeyUnavailableError,
    );
  });
});

describe("hmacSha256 and constantTimeEqual", () => {
  it("computes raw HMAC-SHA256 with 32-byte keys only", async () => {
    const key = randomBytes(32);
    const message = randomBytes(100);
    const hmacKey = await webcrypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    expect(
      hmacSha256(key, message).equals(
        Buffer.from(await webcrypto.subtle.sign("HMAC", hmacKey, message)),
      ),
    ).toBe(true);
    expectCryptoError(() => hmacSha256(randomBytes(16), message), InvalidCryptoInputError);
    expectCryptoError(() => hmacSha256(key, "text" as never), InvalidCryptoInputError);
    expectCryptoError(
      () => hmacSha256(key, new Uint8Array(MAX_DIGEST_INPUT_BYTES + 1)),
      InputTooLargeError,
    );
  });

  it("compares bytes and strings", () => {
    const a = randomBytes(32);
    expect(constantTimeEqual(a, Buffer.from(a))).toBe(true);
    expect(constantTimeEqual(a, randomBytes(32))).toBe(false);
    expect(constantTimeEqual(a, a.subarray(0, 31))).toBe(false);
    expect(constantTimeEqual("token", "token")).toBe(true);
    expect(constantTimeEqual("token", "tokem")).toBe(false);
    expect(constantTimeEqual("token", "token-longer")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("never treats strings with lone surrogates as equal", () => {
    // Both encode to the UTF-8 replacement character, so a byte comparison alone would say equal.
    expect(constantTimeEqual("\ud800", "\udbff")).toBe(false);
    expect(constantTimeEqual("x\udc00", "x\udc00")).toBe(false);
    expect(constantTimeEqual("\ufffd", "\ud800")).toBe(false);
    expect(constantTimeEqual("\ud83d\ude00", "\ud83d\ude00")).toBe(true);
  });

  it("rejects values that are neither strings nor bytes with a typed error", () => {
    for (const value of [undefined, null, 42, ["a"], { length: 1 }]) {
      expectCryptoError(() => constantTimeEqual(value as never, "a"), InvalidCryptoInputError);
      expectCryptoError(() => constantTimeEqual("a", value as never), InvalidCryptoInputError);
    }
  });
});
