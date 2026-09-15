import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  csrfHeader,
  preSessionCsrfHeaderValue,
  requestIdHeader,
  retryAfterHeader,
} from "./http.ts";
import {
  idempotencyKeyHeader,
  idempotencyKeySchema,
  oneTimeSecretResponseSchema,
  secretAlreadyIssuedNotice,
} from "./idempotency.ts";
import { idSchema } from "./ids.ts";

describe("HTTP header constants (§5.3, §6.1)", () => {
  it("names the headers exactly", () => {
    expect(idempotencyKeyHeader).toBe("Idempotency-Key");
    expect(csrfHeader).toBe("X-Symplist-CSRF");
    expect(preSessionCsrfHeaderValue).toBe("1");
    expect(retryAfterHeader).toBe("Retry-After");
    expect(requestIdHeader).toBe("X-Request-Id");
  });
});

describe("Idempotency-Key values", () => {
  it("accepts UUIDs and URL-safe random keys of 16 to 128 characters", () => {
    for (const key of [
      "0199a5a0-7c1e-7b3a-9f2e-3c4d5e6f7a8b",
      "a".repeat(16),
      "A_b-9".repeat(25),
    ]) {
      expect(idempotencyKeySchema.parse(key)).toBe(key);
    }
  });

  it.each([
    "",
    "short",
    "a".repeat(129),
    "has space and more",
    "semi;colon-key-1234",
    "line\nbreak-1234567",
  ])("rejects %j", (key) => {
    expect(idempotencyKeySchema.safeParse(key).success).toBe(false);
  });
});

describe("one-time secret responses (§6.1, decision R11)", () => {
  const schema = oneTimeSecretResponseSchema(
    { grantId: idSchema, createdAt: z.number().int() },
    { apiKey: z.string().startsWith("sym_") },
  );
  const grantId = "0199a5a0-7c1e-7b3a-9f2e-3c4d5e6f7a8b";

  it("round-trips the minting response with the secret", () => {
    const minted = { grantId, createdAt: 1, apiKey: "sym_abc", secretUnavailable: false };
    expect(schema.parse(JSON.parse(JSON.stringify(minted)))).toEqual(minted);
  });

  it("round-trips a replay that carries the notice and no secret", () => {
    const replay = {
      grantId,
      createdAt: 1,
      secretUnavailable: true,
      notice: secretAlreadyIssuedNotice,
    };
    expect(secretAlreadyIssuedNotice).toBe("secret.already_issued");
    expect(schema.parse(JSON.parse(JSON.stringify(replay)))).toEqual(replay);
  });

  it("never lets a replay carry the secret, and never lets a mint omit it", () => {
    expect(
      schema.safeParse({
        grantId,
        createdAt: 1,
        apiKey: "sym_abc",
        secretUnavailable: true,
        notice: secretAlreadyIssuedNotice,
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ grantId, createdAt: 1, secretUnavailable: true }).success).toBe(
      false,
    );
    expect(schema.safeParse({ grantId, createdAt: 1, secretUnavailable: false }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({
        grantId,
        createdAt: 1,
        apiKey: "sym_abc",
        secretUnavailable: false,
        notice: secretAlreadyIssuedNotice,
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ grantId, createdAt: 1, apiKey: "sym_abc" }).success).toBe(false);
  });

  it("refuses ambiguous declarations", () => {
    expect(() => oneTimeSecretResponseSchema({ token: z.string() }, { token: z.string() })).toThrow(
      /both a secret and a non-secret/,
    );
    expect(() =>
      oneTimeSecretResponseSchema({ notice: z.string() }, { token: z.string() }),
    ).toThrow(/reserved/);
    expect(() =>
      oneTimeSecretResponseSchema({ id: z.string() }, { secretUnavailable: z.boolean() }),
    ).toThrow(/reserved/);
    expect(() => oneTimeSecretResponseSchema({ id: z.string() }, {})).toThrow(
      /at least one secret/,
    );
  });
});
