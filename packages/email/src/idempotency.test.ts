import { describe, expect, it } from "vitest";
import { EmailValidationError } from "./errors.ts";
import { emailIdempotencyKeys } from "./idempotency.ts";

const id = "0192f0a0-0000-7000-8000-000000000001";

describe("email idempotency keys", () => {
  it("builds one key per logical send", () => {
    expect(emailIdempotencyKeys.otp("login", id)).toBe(`otp/login/${id}`);
    expect(emailIdempotencyKeys.otp("account_delete", id)).toBe(`otp/account_delete/${id}`);
    expect(emailIdempotencyKeys.vaultResetNotice(id)).toBe(`vault-reset-notice/${id}`);
    expect(emailIdempotencyKeys.reminder(id)).toBe(`reminder/${id}/email`);
  });

  it("keeps purposes apart for the same challenge id", () => {
    expect(emailIdempotencyKeys.otp("login", id)).not.toBe(emailIdempotencyKeys.otp("signup", id));
  });

  it.each(["", "a/b", "maya@example.com", "x".repeat(129), "id with space"])(
    "rejects the segment %j",
    (segment) => {
      expect(() => emailIdempotencyKeys.reminder(segment)).toThrow(EmailValidationError);
    },
  );
});
