import { z } from "zod";

/** The longest email address accepted after normalization (RFC 5321 path limit minus brackets). */
export const emailAddressMaxLength = 254;

/**
 * The canonical form of an email address, used for account lookup, uniqueness and every digest input
 * that binds an address (OTP limit keys, deletion tombstones, invite bindings, suppressions; §4.3,
 * §5.1): surrounding whitespace trimmed, Unicode NFC, lowercase. Normalizing again returns the same
 * text, so a value can be normalized at every boundary without drift.
 */
export function normalizeEmail(value: string): string {
  // Lowercasing can produce sequences that are no longer NFC (for example U+0130), so the text is
  // normalized on both sides of the case mapping.
  return value.trim().normalize("NFC").toLowerCase().normalize("NFC");
}

const addressSchema = z.email({ error: "Expected an email address" });

/** Whether a string is an email address once normalized. */
export function isNormalizableEmail(value: string): boolean {
  const normalized = normalizeEmail(value);
  return normalized.length <= emailAddressMaxLength && addressSchema.safeParse(normalized).success;
}

/**
 * An email address in a request body. The output is always the normalized form, so handlers never
 * compare or digest an address that was not normalized. Validation messages never echo the input.
 */
export const emailAddressSchema = z
  .string({ error: "Expected an email address" })
  .max(emailAddressMaxLength * 2, { error: "Email address is too long" })
  .transform(normalizeEmail)
  .pipe(
    z
      .string()
      .max(emailAddressMaxLength, { error: "Email address is too long" })
      .pipe(addressSchema),
  );

export type EmailAddress = z.infer<typeof emailAddressSchema>;
