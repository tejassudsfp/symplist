import { describe, expect, it } from "vitest";
import { emailAddressSchema, isNormalizableEmail, normalizeEmail } from "./email.ts";

describe("email normalization (§4.3, §5.1)", () => {
  it("trims, lowercases and applies NFC", () => {
    expect(normalizeEmail("  Maya.Rao@Example.COM \n")).toBe("maya.rao@example.com");
    // A decomposed "é" (e + U+0301) and the composed U+00E9 normalize to the same text.
    expect(normalizeEmail("René@example.com")).toBe(normalizeEmail("RENÉ@example.com"));
    expect(normalizeEmail("René@example.com")).toBe("rené@example.com");
  });

  it("is idempotent, including for case mappings that leave NFC", () => {
    for (const input of [
      "İstanbul@example.com",
      "  STRASSEẞ@example.com",
      "Å@example.com",
      "user+tag@Example.org",
    ]) {
      const once = normalizeEmail(input);
      expect(normalizeEmail(once)).toBe(once);
      expect(once).toBe(once.normalize("NFC"));
    }
  });

  it("trims Unicode whitespace such as non-breaking spaces", () => {
    expect(normalizeEmail(" maya@example.com ")).toBe("maya@example.com");
  });

  it("parses request addresses to the normalized form", () => {
    expect(emailAddressSchema.parse(" Maya@Example.com ")).toBe("maya@example.com");
    expect(isNormalizableEmail(" Maya@Example.com ")).toBe(true);
  });

  it("rejects values that are not addresses without echoing them", () => {
    for (const input of ["", "   ", "not-an-address", "a@b", `${"x".repeat(250)}@example.com`]) {
      const result = emailAddressSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success && input.trim().length > 0) {
        expect(JSON.stringify(result.error.issues)).not.toContain(input.trim().slice(0, 20));
      }
    }
    expect(emailAddressSchema.safeParse(42).success).toBe(false);
    expect(isNormalizableEmail("nope")).toBe(false);
  });
});
