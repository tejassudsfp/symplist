import * as nodeCrypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectCryptoError, scriptedRandom } from "../test/support.ts";
import { InvalidCryptoInputError } from "./errors.ts";
import { generateOtp, generateToken, MAX_OTP_LENGTH, MIN_OTP_LENGTH } from "./tokens.ts";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});

afterEach(() => {
  vi.mocked(nodeCrypto.randomInt).mockClear();
});

describe("generateToken", () => {
  it("returns 32 random bytes as 43 base64url characters by default", () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(Buffer.from(token, "base64url").toString("base64url")).toBe(token);
  });

  it("never repeats across many draws", () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateToken()));
    expect(tokens.size).toBe(1000);
  });

  it("supports other lengths within bounds and an injected random source", () => {
    expect(Buffer.from(generateToken(16), "base64url")).toHaveLength(16);
    expect(Buffer.from(generateToken(1024), "base64url")).toHaveLength(1024);
    const hex = "ff".repeat(32);
    expect(generateToken(32, { random: scriptedRandom([hex]) })).toBe(
      Buffer.from(hex, "hex").toString("base64url"),
    );
  });

  it("rejects lengths below 16 bytes, above 1024 bytes or not integral", () => {
    for (const length of [0, 15, 1025, 32.5, Number.NaN]) {
      expectCryptoError(() => generateToken(length), InvalidCryptoInputError);
    }
  });

  it("rejects a random source that returns the wrong length", () => {
    expectCryptoError(
      () => generateToken(32, { random: () => new Uint8Array(31) }),
      InvalidCryptoInputError,
    );
  });
});

describe("generateOtp", () => {
  it("draws the whole code from crypto.randomInt and keeps leading zeros", () => {
    vi.mocked(nodeCrypto.randomInt).mockReturnValueOnce(42 as never);
    expect(generateOtp(6)).toBe("000042");
    expect(nodeCrypto.randomInt).toHaveBeenCalledWith(0, 1_000_000);
  });

  it("returns six decimal digits with every digit position varying", () => {
    const codes = Array.from({ length: 2000 }, () => generateOtp(6));
    for (const code of codes) expect(code).toMatch(/^[0-9]{6}$/);
    for (let position = 0; position < 6; position += 1) {
      expect(new Set(codes.map((code) => code[position])).size).toBe(10);
    }
    expect(new Set(codes).size).toBeGreaterThan(1900);
  });

  it("supports longer codes up to the uniform randomInt range", () => {
    expect(generateOtp(MAX_OTP_LENGTH)).toMatch(/^[0-9]{12}$/);
    expect(nodeCrypto.randomInt).toHaveBeenLastCalledWith(0, 10 ** MAX_OTP_LENGTH);
  });

  it("rejects lengths outside the supported range", () => {
    for (const length of [MIN_OTP_LENGTH - 1, MAX_OTP_LENGTH + 1, 6.5, Number.NaN]) {
      expectCryptoError(() => generateOtp(length), InvalidCryptoInputError);
    }
  });
});
